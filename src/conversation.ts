import { MessageType, type IncomingMessage, type OutgoingMessage } from "agents/chat";
import {
  getToolName,
  isFileUIPart,
  isTextUIPart,
  isToolUIPart,
  type FileUIPart,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { Deferred, Effect, Fiber, Queue, Ref, Schedule, Stream } from "effect";
import { CommandError, EXIT } from "./command";
import { CliSession, type Status } from "./output";
import {
  directory,
  notCallable,
  RookSessions,
  within,
  type Conversation,
  type Profile,
} from "./session";
import type { RookConversation, RookDirectoryState } from "./wire/contracts";

const STATUS_EXIT = {
  completed: EXIT.done,
  failed: EXIT.failed,
  needs_human: EXIT.needsHuman,
  stopped: EXIT.stopped,
  running: EXIT.running,
} satisfies Record<Status, number>;
const OUTCOME = { completed: "completed", error: "failed", aborted: "stopped" } as const;
/** How often a follower re-reads the synchronized thread roster. */
const ROSTER_POLL_MS = 200;
/** How long a failed turn's replayed error has to arrive before the fallback detail. */
const EXPLAIN_MS = 3_000;
/** How much of a failed tool call's error `show --tools` prints. */
const TOOL_ERROR_CHARS = 200;
type Outcome = {
  profile: Profile;
  threadId: string;
  status: Status;
  text: string;
  files: string[];
  detail?: string;
  streamed: boolean;
};
type RosterRow = RookDirectoryState["threads"][number];
type Submission = Awaited<ReturnType<RookConversation["inspectSubmission"]>>;
type FollowOptions = {
  since: number;
  stream: boolean;
  waitHuman: boolean;
  /** A follow-up's message id, which is also its Think submission id. */
  submitted?: string;
};
type Projection = {
  messages: readonly UIMessage[];
  failure?: string;
  partText: string;
  streamed: boolean;
};

/** A chat frame from the conversation socket, or undefined for traffic that is
 * not JSON. The SDK owns the frame shape. */
function parseFrame(event: MessageEvent): OutgoingMessage | undefined {
  try {
    // SAFETY: Agent chat messages share the socket with state/RPC frames;
    // consumers select only the SDK's own OutgoingMessage variants.
    return JSON.parse(String(event.data)) as OutgoingMessage;
  } catch {
    return undefined;
  }
}

/** What an assistant turn or tool call hands back: its text and its files. */
export type Reply = { text: string; files: FileUIPart[] };

/** The assistant text and files answering the user message `after`; omitted,
 * those of the last turn. */
export function reply(messages: readonly UIMessage[], after?: string): Reply {
  const start =
    after === undefined
      ? messages.findLastIndex(({ role }) => role === "user")
      : messages.findIndex(({ id }) => id === after);
  const rest = messages.slice(start + 1);
  const next = rest.findIndex(({ role }) => role === "user");
  const turn = next < 0 ? rest : rest.slice(0, next);
  const parts = turn.flatMap(({ role, parts }) => (role === "assistant" ? parts : []));
  return {
    text: parts
      .flatMap((part) => (isTextUIPart(part) && part.text.trim() ? [part.text.trim()] : []))
      .join("\n\n"),
    files: parts.filter(isFileUIPart),
  };
}

export const turnOutcome = Effect.fnUntraced(function* (profile: Profile, chat: Conversation) {
  const sessions = yield* RookSessions;
  const outcome = yield* sessions.call<Awaited<ReturnType<RookConversation["turnOutcome"]>>>(
    profile,
    () => chat.stub.turnOutcome(),
  );
  return outcome === "running" ? "running" : OUTCOME[outcome];
});

const transcript = Effect.fnUntraced(function* (profile: Profile, chat: Conversation) {
  const sessions = yield* RookSessions;
  return yield* sessions.call(profile, () => chat.stub.getMessages());
});

export const withConversation = Effect.fnUntraced(function* <A, E, R>(
  profile: Profile,
  id: string,
  use: (chat: Conversation) => Effect.Effect<A, E, R>,
) {
  const sessions = yield* RookSessions;
  const chat = yield* sessions.conversation(profile, id);
  yield* sessions.ready(chat, `thread ${id} did not answer`);
  return yield* use(chat);
}, Effect.scoped);

type Inbox =
  | { readonly _tag: "Frame"; readonly frame: OutgoingMessage }
  | { readonly _tag: "Flush"; readonly done: Deferred.Deferred<void> };
type Settled = {
  status: Exclude<Status, "running">;
  detail?: string;
  /** A follow-up's transcript, read once its submission completed. */
  messages?: readonly UIMessage[];
};

/** One scoped owner serializes SDK frames, transcript projection, and streamed
 * output. Reading an outcome drains earlier frames before exposing its snapshot. */
const observeConversation = Effect.fnUntraced(function* (
  profile: Profile,
  threadId: string,
  options: FollowOptions,
) {
  const sessions = yield* RookSessions;
  const output = yield* CliSession;
  const projection = yield* Ref.make<Projection>({ messages: [], partText: "", streamed: false });
  const greeting = yield* Deferred.make<void>();
  // Set while a failed turn's error is replayed: its chunks were the turn's output.
  const explaining = yield* Ref.make(false);
  const explained = yield* Deferred.make<void>();
  // Whether a follow-up's user message is the transcript's latest. Think
  // broadcasts the transcript with it before its turn's first chunk, and with
  // the next one before that turn's, so this gates the stream in frame order.
  const latest = yield* Ref.make(false);
  const inbox = yield* Queue.unbounded<Inbox>();
  const chat = yield* sessions.conversation(profile, threadId);
  const live = options.stream && !output.machine && output.tty.stdout;
  const events = options.stream && output.machine;

  const progress = Effect.fnUntraced(function* (chunk: UIMessageChunk) {
    const state = yield* Ref.get(projection);
    switch (chunk.type) {
      case "text-delta":
        yield* Ref.set(projection, {
          ...state,
          partText: state.partText + chunk.delta,
          streamed: state.streamed || live,
        });
        if (live) yield* output.stdout(chunk.delta);
        return;
      case "text-end":
        yield* Ref.set(projection, { ...state, partText: "" });
        if (live) yield* output.stdout("\n");
        if (events && state.partText.trim())
          yield* output.json(threadId, { type: "message", text: state.partText });
        return;
      case "tool-input-available":
        if (live) yield* output.stderr(output.dim(`· ${chunk.title ?? chunk.toolName}\n`));
        if (events) yield* output.json(threadId, { type: "tool", name: chunk.toolName });
        return;
    }
  });

  const receive = Effect.fnUntraced(function* (entry: Inbox) {
    if (entry._tag === "Flush") return yield* Deferred.succeed(entry.done, undefined);
    const frame = entry.frame;
    switch (frame.type) {
      case MessageType.CF_AGENT_CHAT_MESSAGES:
        yield* Ref.update(projection, (state) => ({ ...state, messages: frame.messages }));
        yield* Ref.set(
          latest,
          frame.messages.findLast(({ role }) => role === "user")?.id === options.submitted,
        );
        yield* Deferred.succeed(greeting, undefined);
        return;
      // The SDK only sends live chunks after this acknowledgment. A reconnect
      // replays the turn; a terminal may therefore print that turn twice.
      case MessageType.CF_AGENT_STREAM_RESUMING:
        chat.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
            id: frame.id,
          } satisfies IncomingMessage),
        );
        yield* Deferred.succeed(greeting, undefined);
        return;
      case MessageType.CF_AGENT_STREAM_RESUME_NONE:
        yield* Deferred.succeed(explained, undefined);
        return;
      case MessageType.CF_AGENT_USE_CHAT_RESPONSE: {
        // A submission streams under its own id, also when a client joins
        // mid-turn; a recovered continuation streams under a new one while
        // its message is still the latest.
        const ours =
          options.submitted === undefined ||
          frame.id === options.submitted ||
          (yield* Ref.get(latest));
        if (frame.error) {
          if (ours) yield* Ref.update(projection, (state) => ({ ...state, failure: frame.body }));
          return yield* Deferred.succeed(explained, undefined);
        }
        if (!frame.body || !ours || (yield* Ref.get(explaining))) return;
        const chunk = yield* Effect.try({
          // SAFETY: non-error response bodies are serialized AI SDK chunks.
          try: () => JSON.parse(frame.body) as UIMessageChunk,
          catch: (cause) => CommandError.unavailable("Rook sent an invalid chat response", cause),
        });
        return yield* progress(chunk);
      }
    }
  });

  // RPC promises can resolve before backpressured stream processing catches
  // up. This local queue barrier orders completion after all preceding frames.
  const flush = Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    yield* Queue.offer(inbox, { _tag: "Flush", done });
    yield* Deferred.await(done);
  });

  // The listener enqueues synchronously so a flush offered after an RPC
  // resolves lands behind every frame that arrived before it.
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const listener = (event: MessageEvent) => {
        const frame = parseFrame(event);
        if (frame) Queue.offerUnsafe(inbox, { _tag: "Frame", frame });
      };
      chat.addEventListener("message", listener);
      return listener;
    }),
    (listener) => Effect.sync(() => chat.removeEventListener("message", listener)),
  );
  const consumer = yield* Stream.fromQueue(inbox).pipe(
    Stream.runForEach(receive),
    Effect.forkScoped,
  );

  return {
    ready: within(Deferred.await(greeting), `thread ${threadId} did not answer`),
    snapshot: Ref.get(projection),
    outcome: turnOutcome(profile, chat).pipe(
      Effect.provideService(RookSessions, sessions),
      Effect.tap(() => flush),
    ),
    /** Think's record of a submission; undefined from a Rook that predates the callable. */
    submission: (id: string) =>
      sessions
        .call(profile, () => chat.stub.inspectSubmission(id))
        .pipe(
          Effect.catchIf(
            (error) => notCallable(error.cause),
            () => Effect.succeed(undefined),
          ),
          Effect.tap(() => flush),
        ),
    // Think keeps a failed turn's error and replays it on a resume request: as
    // the stream resuming, which the ack above answers, then the error frame.
    // A turn that succeeded, or none at all, answers that no stream exists.
    explain: Effect.gen(function* () {
      yield* Ref.set(explaining, true);
      yield* Effect.sync(() =>
        chat.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST,
          } satisfies IncomingMessage),
        ),
      );
      yield* Deferred.await(explained).pipe(Effect.timeoutOption(EXPLAIN_MS));
      return (yield* Ref.get(projection)).failure;
    }),
    transcript: transcript(profile, chat).pipe(Effect.provideService(RookSessions, sessions)),
    // Output/decoding failure must fail the observer, not leave its sibling
    // status fiber waiting after the stream has stopped.
    failure: Fiber.join(consumer).pipe(Effect.andThen(Effect.never)),
  };
});

/** Wait for a greeting, then consult the roster and durable turn outcome until
 * the thread settles or needs a human; a follow-up settles with its own
 * submission. Cancellation closes the entire observer. */
export const follow = Effect.fn("rook.follow")(function* (
  profile: Profile,
  threadId: string,
  options: FollowOptions,
) {
  const output = yield* CliSession;
  const observer = yield* observeConversation(profile, threadId, options);
  const sawRunning = yield* Ref.make(false);
  const sawThread = yield* Ref.make(false);
  // The CLI ships on npm and Rook on the Web Store, days apart: a follow-up to
  // a Rook without inspectSubmission follows the thread, as rook wait does.
  const byThread = yield* Ref.make(options.submitted === undefined);

  const settledSubmission = Effect.fnUntraced(function* (
    record: Submission,
    thread: RosterRow | undefined,
  ) {
    let settled: Settled | undefined;
    if (record === null)
      // Rook never deletes a submission row; one Think has no record of, on a
      // thread at rest, did not run.
      settled =
        thread?.status === "running"
          ? undefined
          : { status: "stopped", detail: "the message did not run" };
    else if (record.status === "completed")
      settled = { status: "completed", messages: yield* observer.transcript };
    else if (record.status === "error") settled = { status: "failed", detail: record.error };
    else if (record.status === "aborted") settled = { status: "stopped" };
    else if (record.status === "skipped")
      settled = { status: "stopped", detail: "the message was skipped before it ran" };
    return settled;
  });

  const poll = Effect.gen(function* () {
    const state = yield* directory(profile.root);
    const thread = state.threads.find(({ id }) => id === threadId);
    const listed = yield* Ref.getAndUpdate(sawThread, (value) => value || thread !== undefined);
    // A thread that was listed and is gone was deleted, by rook rm or in the side panel.
    if (!thread && listed) {
      const settled: Settled = { status: "stopped", detail: "the thread was deleted" };
      return settled;
    }
    const submitted = (yield* Ref.get(byThread)) ? undefined : options.submitted;
    const record = submitted === undefined ? undefined : yield* observer.submission(submitted);
    if (submitted !== undefined && record === undefined) yield* Ref.set(byThread, true);
    // Before the human wait, which may be a later message's.
    if (record !== undefined) {
      const settled = yield* settledSubmission(record, thread);
      if (settled) return settled;
    }
    const wait = Object.values(state.browser.waits).find((entry) => entry.threadId === threadId);
    if (wait && !options.waitHuman) {
      if (output.machine)
        yield* output.json(threadId, {
          type: "needs_human",
          reason: wait.reason,
          tab: wait.tabId,
          expiresAt: new Date(wait.expiresAt).toISOString(),
        });
      const settled: Settled = { status: "needs_human", detail: wait.reason };
      return settled;
    }
    if (record !== undefined) return undefined;
    const running = yield* Ref.getAndUpdate(
      sawRunning,
      (value) => value || thread?.status === "running",
    );
    if (
      !thread ||
      thread.status === "running" ||
      (thread.status === "idle"
        ? !running && options.since !== 0
        : thread.updatedAt < options.since)
    )
      return undefined;
    const status = yield* observer.outcome;
    if (status === "running") return undefined;
    return { status };
  });

  const settle = Effect.gen(function* () {
    yield* observer.ready;
    const settled = yield* poll.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(ROSTER_POLL_MS),
        until: (result) => result !== undefined,
      }),
    );
    if (settled === undefined) return yield* Effect.die("the roster poll ended unsettled");
    let { status, detail }: Settled = settled;
    const state = yield* observer.snapshot;
    const answer =
      status === "completed"
        ? settled.messages
          ? reply(settled.messages, options.submitted)
          : reply(state.messages)
        : { text: "", files: [] };
    if (status === "completed" && !answer.text && !answer.files.length) {
      status = "failed";
      detail = `Rook finished without a reply; read the thread: rook show ${threadId} --tools`;
    }
    if (status === "failed" && detail === undefined)
      detail = state.failure ?? (yield* observer.explain) ?? "see the thread in Chrome";
    const files = yield* output.saveFiles(threadId, answer.files);
    const outcome: Outcome = {
      profile,
      threadId,
      status,
      text: answer.text,
      files,
      detail,
      streamed: state.streamed,
    };
    return outcome;
  });

  return yield* settle.pipe(Effect.raceFirst(observer.failure));
}, Effect.scoped);

export const report = Effect.fnUntraced(function* (outcome: Outcome, exitOverride?: number) {
  const output = yield* CliSession;
  const { threadId, status, text, files, detail } = outcome;
  const exit = exitOverride ?? STATUS_EXIT[status];
  const problem = status === "failed" ? detail : undefined;
  if (output.machine) {
    if (problem)
      yield* output.json(threadId, { type: "error", code: "run_failed", message: problem });
    yield* output.json(threadId, { type: "result", status, exit, text, files });
    return yield* output.finish(exit);
  }
  yield* output.stdout(
    [text && !outcome.streamed ? `${text}\n` : "", ...files.map((file) => `file: ${file}\n`)].join(
      "",
    ),
  );
  yield* output.stderr(
    problem
      ? `failed: ${problem}\n`
      : status === "stopped"
        ? `stopped${detail ? `: ${detail}` : ""}\n`
        : status === "needs_human"
          ? `needs a human in ${outcome.profile.label}: ${detail}\ntell the user, then: rook wait ${threadId} --wait-human\n`
          : status === "running"
            ? `still running: rook wait ${threadId}   stop: rook stop ${threadId}\n`
            : "",
  );
  yield* output.finish(exit);
});

export const remember = Effect.fnUntraced(function* (profile: Profile, threadId: string) {
  const output = yield* CliSession;
  yield* output.remember((code) =>
    report(
      { profile, threadId, status: "running", text: "", files: [], streamed: false },
      code,
    ).pipe(Effect.provideService(CliSession, output)),
  );
});

export const show = Effect.fn("rook.show.transcript")(function* (
  profile: Profile,
  threadId: string,
  tools: boolean,
) {
  const output = yield* CliSession;
  const unanswered = `thread ${threadId} did not answer`;
  const observer = yield* observeConversation(profile, threadId, {
    since: 0,
    stream: false,
    waitHuman: false,
  });
  yield* observer.ready;
  // A client that connects mid-turn is sent only the stream resuming, not the
  // transcript, so the transcript is asked for.
  const messages = yield* within(observer.transcript, unanswered);
  const outcome = yield* within(observer.outcome, unanswered);
  const wait = Object.values((yield* directory(profile.root)).browser.waits).find(
    (entry) => entry.threadId === threadId,
  );
  const status: Status = wait ? "needs_human" : outcome;
  const detail =
    status === "needs_human"
      ? wait?.reason
      : status === "failed"
        ? yield* observer.explain
        : undefined;
  for (const message of messages) {
    const lines = message.parts.flatMap((part) =>
      isTextUIPart(part) && part.text.trim()
        ? [part.text.trim()]
        : tools && isToolUIPart(part)
          ? [
              part.state === "output-error"
                ? `· ${getToolName(part)} output-error: ${(part.errorText.split("\n", 1)[0] ?? "").slice(0, TOOL_ERROR_CHARS)}`
                : `· ${getToolName(part)} ${part.state}`,
            ]
          : [],
    );
    const files = yield* output.saveFiles(threadId, message.parts.filter(isFileUIPart));
    if (!lines.length && !files.length) continue;
    if (output.machine)
      yield* output.json(threadId, {
        type: "message",
        role: message.role,
        text: lines.join("\n\n"),
        files,
      });
    else
      yield* output.stdout(
        `## ${message.role === "user" ? "you" : "rook"}\n\n${[...lines, ...files.map((file) => `file: ${file}`)].map((line) => `${line}\n\n`).join("")}`,
      );
  }
  if (output.machine)
    return yield* output.json(threadId, { type: "status", status, ...(detail && { detail }) });
  yield* output.stderr(
    status === "running"
      ? `still running: rook wait ${threadId}   stop: rook stop ${threadId}\n`
      : status === "needs_human"
        ? `needs a human in ${profile.label}: ${detail}\n`
        : status === "completed"
          ? ""
          : `${status}${detail ? `: ${detail}` : ""}\n`,
  );
}, Effect.scoped);

/** A run's trace arrives in synchronized conversation state. Capture it while
 * the command is alive so timeout reporting never issues a late recovery RPC. */
export const watchExecution = Effect.fn("rook.watchExecution")(function* (
  profile: Profile,
  threadId: string,
  executionId: Ref.Ref<string | undefined>,
) {
  const sessions = yield* RookSessions;
  yield* directory(profile.root).pipe(
    Effect.map((state) => state.threads.some(({ id }) => id === threadId)),
    Effect.repeat({ schedule: Schedule.spaced(ROSTER_POLL_MS), until: Boolean }),
  );
  const chat = yield* sessions.conversation(profile, threadId);
  yield* Stream.fromEventListener(chat, "message").pipe(
    Stream.runForEach(() =>
      chat.state?.executionTrace?.executionId
        ? Ref.set(executionId, chat.state.executionTrace.executionId)
        : Effect.void,
    ),
  );
}, Effect.scoped);
