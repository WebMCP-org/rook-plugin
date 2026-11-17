import { randomUUID } from "node:crypto";
import { fstatSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileUIPart } from "ai";
import { Clock, Effect, Fiber, FileSystem, Option, Ref, Result } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };
import { boolean, CommandError, duration, EXIT, optional, rootCommand } from "./command";
import { Chrome } from "./chrome";
import { RookConfig } from "./config";
import {
  follow,
  remember,
  report,
  show,
  turnOutcome,
  watchExecution,
  withConversation,
  type Reply,
} from "./conversation";
import { adoptModel, modelCommand } from "./model";
import { CliSession } from "./output";
import {
  directory,
  locate,
  matching,
  outdated,
  pick,
  RookSessions,
  type Located,
  type Profile,
} from "./session";
import { scopedLocalRelay } from "./serve";
import {
  executionTraceFile,
  mcpToolInputSchema,
  threadTitleSchema,
  type McpToolDescriptor,
  type RookDirectory,
} from "./wire/contracts";

const waiting = {
  timeout: duration("timeout").pipe(
    Flag.withDescription(
      "Stop waiting after DUR (for example 30s or 2m; a bare number is seconds); default 100s without a terminal, 0 waits indefinitely",
    ),
  ),
  waitHuman: boolean("wait-human").pipe(
    Flag.withDescription("Keep waiting when Rook needs a human instead of exiting with status 3"),
  ),
};
const destination = {
  thread: optional("thread").pipe(
    Flag.withDescription("Use an existing thread id or unique prefix"),
  ),
};
const threadArgument = Argument.String("ID").pipe(
  Argument.withDescription("Thread id or unique prefix, as ask and ps print it"),
);
const tabFlag = (description: string) =>
  Flag.Int("tab").pipe(
    Flag.optional,
    Flag.map(Option.getOrUndefined),
    Flag.withDescription(description),
  );

/** The profiles the shared --profile flag names, and that flag. */
const discover = Effect.gen(function* () {
  const sessions = yield* RookSessions;
  const { profile: wanted } = yield* rootCommand;
  const all = yield* sessions.profiles(wanted);
  return { wanted, all, unanswered: yield* sessions.unanswered };
});

/** The one selected profile, with a model adopted before it acts. */
const selected = Effect.gen(function* () {
  const { wanted, all, unanswered } = yield* discover;
  const profile = yield* pick(all, wanted, unanswered);
  yield* adoptModel(profile);
  return profile;
});

const located = Effect.fnUntraced(function* (id: string) {
  const { wanted, all, unanswered } = yield* discover;
  return yield* locate(all, wanted, id, unanswered);
});

/** The thread a command works in: --thread's, or a new one whose id is --id. */
const target = Effect.fnUntraced(function* (flags: { thread?: string; id?: string }) {
  const output = yield* CliSession;
  const { wanted, all, unanswered } = yield* discover;
  const found: Located = flags.thread
    ? yield* locate(all, wanted, flags.thread, unanswered)
    : { profile: yield* pick(all, wanted, unanswered), threadId: flags.id ?? randomUUID() };
  yield* adoptModel(found.profile);
  if (!output.machine) yield* output.stderr(`thread ${found.threadId} on ${found.profile.label}\n`);
  return found;
});

/** How long ask and wait observe without a terminal, unless --timeout says otherwise. */
const DEFAULT_WAIT_MS = 100_000;
/** How long a finished run waits for Rook to remove its thread before leaving it. */
const FORGET_MS = 5_000;

/** An absolute launch deadline includes input, discovery, model adoption and
 * RPC admission. Expiry only stops local observation of browser-owned work. */
const deadline = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  value: number | undefined,
  defaultWait: boolean,
) {
  const output = yield* CliSession;
  const ms = value ?? (defaultWait && !output.tty.stdout ? DEFAULT_WAIT_MS : 0);
  if (!ms) return yield* effect;
  const remaining = performance.timeOrigin + ms - (yield* Clock.currentTimeMillis);
  if (remaining <= 0) return yield* output.abandon(EXIT.running);
  return yield* effect.pipe(
    Effect.timeoutOrElse({ duration: remaining, orElse: () => output.abandon(EXIT.running) }),
  );
});

const rows = Effect.fnUntraced(function* <T>(values: readonly T[], line: (row: T) => string) {
  const output = yield* CliSession;
  yield* output.stdout(
    values.map((row) => `${output.machine ? JSON.stringify(row) : line(row)}\n`).join(""),
  );
});

/** The existing wire schema owns tool and automation input. */
export const toolInput = Effect.fnUntraced(function* (args: string | undefined) {
  const json: unknown =
    args === undefined
      ? {}
      : yield* Effect.try({
          try: () => JSON.parse(args),
          catch: (cause) => CommandError.usage(`--args is not JSON: ${String(cause)}`),
        });
  const parsed = mcpToolInputSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  return yield* CommandError.usage("--args must be a JSON object");
});

type ToolResult = Awaited<ReturnType<RookDirectory["callTool"]>>;

/** A tool result as `rook call` prints it: its text, and its images, audio
 * and resources as files. */
export function toolReply(result: ToolResult): Reply {
  return {
    text: result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
    files: result.content.flatMap((part): FileUIPart[] => {
      if (part.type === "image" || part.type === "audio") {
        const url = `data:${part.mimeType};base64,${part.data}`;
        return [{ type: "file", mediaType: part.mimeType, url }];
      }
      if (part.type === "resource_link") {
        return [
          { type: "file", mediaType: part.mimeType ?? "application/octet-stream", url: part.uri },
        ];
      }
      if (part.type !== "resource") return [];
      const { resource } = part;
      const mediaType = resource.mimeType ?? "application/octet-stream";
      const data =
        "blob" in resource ? resource.blob : Buffer.from(resource.text).toString("base64");
      const filename = basename(URL.parse(resource.uri)?.pathname ?? "");
      return [{ type: "file", mediaType, url: `data:${mediaType};base64,${data}`, filename }];
    }),
  };
}
const source = (tool: McpToolDescriptor) =>
  tool.tabId === undefined ? `server ${tool.serverId}` : `tab ${tool.tabId} ${tool.url}`;
const tools = Effect.fnUntraced(function* (profile: Profile, tab: number | undefined) {
  const sessions = yield* RookSessions;
  const all = yield* sessions.call(profile, () => profile.root.stub.listTools());
  return tab === undefined ? all : all.filter((tool) => tool.tabId === tab);
});
const prompt = Effect.fnUntraced(function* (words: readonly string[]) {
  const output = yield* CliSession;
  const given = words.join(" ").trim();
  const text =
    given && given !== "-" ? given : output.tty.stdin ? "" : (yield* output.input).trim();
  if (text) return text;
  return yield* CommandError.usage("usage: rook ask PROMPT (or pipe the prompt on stdin)");
});

const ask = Command.make(
  "ask",
  {
    ...waiting,
    ...destination,
    id: optional("id").pipe(
      Flag.withDescription(
        "Stable message UUID: repeating an ask with this id reports the first submission",
      ),
    ),
    detach: boolean("detach").pipe(
      Flag.withDescription(
        "Print the admitted thread id and return while Chrome continues working",
      ),
    ),
    prompt: Argument.String("PROMPT").pipe(
      Argument.withDescription("What Rook should do; omitted or -, it is read from stdin"),
      Argument.atLeast(0),
    ),
  },
  Effect.fn("rook.ask")(
    function* (flags) {
      const sessions = yield* RookSessions;
      const output = yield* CliSession;
      const trace = yield* RookConfig.traceContext;
      const text = yield* prompt(flags.prompt);
      const { profile, threadId } = yield* target(flags);
      yield* remember(profile, threadId);
      const since = yield* Clock.currentTimeMillis;
      const messageId = flags.id ?? randomUUID();
      let repeat: boolean;
      let submitted: string | undefined;
      let queued = false;
      if (flags.thread) {
        const row = (yield* directory(profile.root)).threads.find(({ id }) => id === threadId);
        const taken = yield* sessions.call(profile, () =>
          profile.root.call("submitMessage", [threadId, messageId, text], trace),
        );
        if (taken === undefined) return yield* outdated(profile);
        repeat = !taken;
        submitted = messageId;
        // Rook queues a message sent to a working thread behind the turn running there.
        queued = taken && row?.status === "running";
      } else {
        const state = yield* directory(profile.root);
        repeat = state.threads.some(({ id }) => id === threadId);
        // Rook mints a thread only under a UUID, and answers anything else
        // with its schema's error.
        if (!repeat && !z.uuid().safeParse(threadId).success)
          return yield* CommandError.usage(
            `--id takes a UUID, such as uuidgen prints: ${threadId} is not one`,
          );
        if (!repeat)
          yield* sessions.call(profile, () =>
            profile.root.call("startThread", [threadId, { text, files: [] }], trace),
          );
      }
      if (output.machine)
        yield* output.json(threadId, {
          type: "run.started",
          profile: { id: profile.id, label: profile.label },
          new: !flags.thread && !repeat,
          queued,
          repeat,
          // A thread's first message is submitted under the thread's id.
          message: submitted ?? threadId,
        });
      else
        yield* output.stderr(
          repeat
            ? "this message was already submitted; reporting that submission\n"
            : queued
              ? "the message runs after the current turn\n"
              : "the message started\n",
        );
      if (flags.detach) {
        if (!output.machine) yield* output.stdout(`${threadId}\n`);
        return yield* output.finish(EXIT.done);
      }
      const outcome = yield* follow(profile, threadId, {
        since: repeat ? 0 : since,
        stream: true,
        waitHuman: flags.waitHuman,
        submitted,
      });
      return yield* report(outcome);
    },
    (effect, flags) => deadline(effect, flags.timeout, true),
  ),
).pipe(Command.withDescription("Hand a prompt to Rook in Chrome"));

const wait = Command.make(
  "wait",
  { ...waiting, id: threadArgument },
  Effect.fn("rook.wait")(
    function* (flags) {
      const { profile, threadId } = yield* located(flags.id);
      yield* remember(profile, threadId);
      const outcome = yield* follow(profile, threadId, {
        since: 0,
        stream: false,
        waitHuman: flags.waitHuman,
      });
      return yield* report(outcome);
    },
    (effect, flags) => deadline(effect, flags.timeout, true),
  ),
).pipe(Command.withDescription("Wait for a thread's run to settle and print its reply"));

const showCommand = Command.make(
  "show",
  {
    id: threadArgument,
    tools: boolean("tools").pipe(Flag.withDescription("Also list each tool call and its state")),
  },
  Effect.fn("rook.show")(function* (flags) {
    const { profile, threadId } = yield* located(flags.id);
    yield* show(profile, threadId, flags.tools);
  }),
).pipe(Command.withDescription("Print a thread as the user sees it in the side panel"));

const stop = Command.make(
  "stop",
  { id: threadArgument },
  Effect.fn("rook.stop")(function* (flags) {
    const sessions = yield* RookSessions;
    const output = yield* CliSession;
    const { profile, threadId } = yield* located(flags.id);
    const wasRunning = yield* withConversation(profile, threadId, (chat) =>
      Effect.gen(function* () {
        const before = yield* turnOutcome(profile, chat);
        yield* sessions.call(profile, () => chat.stub.stopCurrentWork());
        return before === "running";
      }),
    );
    if (!output.machine)
      yield* output.stderr(
        wasRunning ? "stopped the work running there\n" : "nothing was running there\n",
      );
    yield* rows(
      [{ id: threadId, profile: profile.label, status: "stopped", wasRunning }],
      (row) => `${row.id}\t${row.status}`,
    );
  }),
).pipe(
  Command.withDescription(
    "Stop the turn or script working in a thread, skipping messages queued behind it",
  ),
);

const list = Command.make(
  "ls",
  {},
  Effect.fn("rook.ls")(function* () {
    const sessions = yield* RookSessions;
    const chrome = yield* Chrome;
    const { profile: wanted } = yield* rootCommand;
    const all = yield* sessions.connected;
    const profiles = yield* Effect.forEach(matching(all, wanted), ({ id, label, root }) =>
      directory(root).pipe(
        Effect.map((state) => ({
          id,
          label,
          running: state.threads.filter(({ status }) => status === "running").length,
          state: "connected" as const,
        })),
      ),
    );
    yield* rows(profiles, (row) => `${row.label}\t${row.id}\t${row.running} running`);
    const labels = new Set(all.map(({ label }) => label.toLowerCase()));
    // ponytail: a connected profile signed in to no Google account is labelled
    // by its host id, which names no Chrome folder, so it is listed again here
    // as not connected. Tying the two needs the profile to report its folder.
    const others = (yield* chrome.profiles).flatMap(({ dir, email, rook }) => {
      const label = email || dir;
      if (email && labels.has(email.toLowerCase())) return [];
      if (wanted && label.toLowerCase() !== wanted.toLowerCase()) return [];
      return [{ label, dir, state: rook ? ("installed" as const) : ("absent" as const) }];
    });
    if (wanted && !profiles.length && !others.length)
      return yield* CommandError.usage(`no connected profile or Chrome profile is ${wanted}`);
    yield* rows(
      others,
      (row) => `${row.label}\t-\t${row.state === "installed" ? "not connected" : "no Rook"}`,
    );
  }),
).pipe(
  Command.withDescription(
    "List Chrome profiles: connected ones with how many threads each runs, then the rest and whether Rook is installed; opens no Chrome window",
  ),
);

const ps = Command.make(
  "ps",
  {},
  Effect.fn("rook.ps")(function* () {
    const { wanted, all } = yield* discover;
    const profiles = wanted ? [yield* pick(all, wanted)] : all;
    const threads = yield* Effect.forEach(profiles, ({ label, root }) =>
      directory(root).pipe(
        Effect.map((state) => {
          const waits = new Set(Object.values(state.browser.waits).map((wait) => wait.threadId));
          return state.threads.map((thread) => ({
            profile: label,
            id: thread.id,
            status: waits.has(thread.id) ? "needs_human" : thread.status,
            updatedAt: new Date(thread.updatedAt).toISOString(),
            title: thread.title,
          }));
        }),
      ),
    );
    yield* rows(
      threads.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      (row) => `${row.id}\t${row.status}\t${row.profile}\t${row.title}`,
    );
  }),
).pipe(Command.withDescription("List threads and their status, most recently updated first"));

const bash = Command.make(
  "bash",
  {
    script: Argument.String("SCRIPT").pipe(
      Argument.withDescription("Shell script, run in a fresh shell at the workspace root"),
      Argument.atLeast(1),
    ),
  },
  Effect.fn("rook.bash")(function* ({ script }) {
    const sessions = yield* RookSessions;
    const output = yield* CliSession;
    const profile = yield* selected;
    // Stdio does not distinguish sockets from pipes. Node harnesses may hold a
    // socket open; only a shell pipe or redirected file supplies bash.
    const piped = yield* Effect.try({
      try: () => {
        const stat = fstatSync(0);
        return stat.isFIFO() || stat.isFile();
      },
      catch: (cause) => CommandError.failed("could not inspect stdin", cause),
    });
    const input = piped ? yield* output.input : "";
    const result = yield* sessions.call(profile, () =>
      profile.root.stub.runBash(script.join(" "), input),
    );
    yield* output.stdout(result.stdout);
    yield* output.stderr(result.stderr);
    yield* output.finish(result.exitCode);
  }),
).pipe(
  Command.withDescription(
    "Run a shell script on Rook's workspace; piped stdin goes in, its output and status come back",
  ),
);

const run = Command.make(
  "run",
  {
    ...destination,
    path: Argument.String("PATH").pipe(
      Argument.withDescription("A .ts or .js script under /automations"),
    ),
    args: optional("args").pipe(Flag.withDescription("The script's input, as a JSON object")),
    timeout: duration("timeout").pipe(
      Flag.withDescription(
        "Stop local observation after DUR, leaving the script running in Chrome; default 0 waits indefinitely",
      ),
    ),
  },
  Effect.fn("rook.run")(function* (flags) {
    const sessions = yield* RookSessions;
    const output = yield* CliSession;
    const trace = yield* RookConfig.traceContext;
    // The deadline covers discovery and the wait for the run. What follows a
    // settled run is brief, and inside the deadline it could be cut short and
    // reported as a run still going.
    const observed = yield* deadline(
      Effect.gen(function* () {
        const args = yield* toolInput(flags.args);
        const { profile, threadId } = yield* target(flags);
        const executionId = yield* Ref.make<string | undefined>(undefined);
        yield* output.remember(
          Effect.fnUntraced(function* (code: number) {
            const id = yield* Ref.get(executionId);
            const result = id
              ? `; when it ends, its result is in ${executionTraceFile(id)}: rook bash 'cat ${executionTraceFile(id)}'`
              : "";
            yield* output.error(
              `still running in ${profile.label}, thread ${threadId}${result}; stop: rook stop ${threadId}`,
              code,
            );
          }),
        );
        const watcher = yield* watchExecution(profile, threadId, executionId).pipe(
          Effect.forkScoped,
        );
        const run = yield* sessions
          .call(profile, () =>
            profile.root.call("runAutomation", [threadId, flags.path, args], {
              timeout: 0,
              ...trace,
            }),
          )
          .pipe(Effect.result);
        return { profile, threadId, watcher, run };
      }),
      flags.timeout,
      false,
    );
    // The deadline passed with the run going: it keeps its thread, and rook stop reaches it.
    if (!observed) return;
    const { profile, threadId, watcher, run } = observed;
    // A run that ended removes the thread it minted; its trace stays under /executions.
    const forget =
      flags.thread
        ? Effect.void
        : Effect.gen(function* () {
            // The observer goes first so its socket never redials a deleted conversation.
            yield* Fiber.interrupt(watcher);
            yield* sessions
              .call(profile, () => profile.root.stub.deleteThread(threadId))
              .pipe(Effect.timeoutOption(FORGET_MS), Effect.ignore);
          });
    if (Result.isFailure(run)) {
      const error = run.failure;
      const { threads } = yield* directory(profile.root);
      // Refused before a run began (a bad path, an older Rook): no thread to ask or remove.
      if (error.code !== EXIT.failed || !threads.some(({ id }) => id === threadId))
        return yield* error;
      const outcome = yield* withConversation(profile, threadId, (chat) =>
        turnOutcome(profile, chat),
      ).pipe(Effect.option);
      // The call can fail under a run that goes on, as when rook serve is
      // replaced; a run not known to have ended keeps its thread.
      if (Option.isNone(outcome)) return yield* error;
      if (outcome.value === "running") return yield* output.abandon(EXIT.running);
      yield* forget;
      return yield* new CommandError({
        code: outcome.value === "stopped" ? EXIT.stopped : EXIT.failed,
        message: error.message,
        cause: error.cause,
      });
    }
    const execution = run.success;
    if (output.machine) {
      yield* output.json(threadId, { type: "execution", exit: EXIT.done, ...execution });
    } else {
      yield* output.stderr(
        `execution ${execution.executionId}\n${execution.logs.map((line) => `${line}\n`).join("")}${execution.files.map((file) => `${file.label}: ${file.path}\n`).join("")}`,
      );
      if (execution.result !== undefined)
        yield* output.stdout(`${JSON.stringify(execution.result)}\n`);
    }
    yield* output.finish(EXIT.done);
    yield* forget;
  }),
).pipe(Command.withDescription("Run a saved automation script in Chrome and print its result"));

const remove = Command.make(
  "rm",
  { ids: threadArgument.pipe(Argument.atLeast(1)) },
  Effect.fn("rook.rm")(function* ({ ids }) {
    const sessions = yield* RookSessions;
    const { wanted, all, unanswered } = yield* discover;
    // Every id resolves before anything is deleted, so one bad prefix deletes nothing.
    const found = new Map<string, Located>();
    for (const id of ids) {
      const thread = yield* locate(all, wanted, id, unanswered);
      found.set(thread.threadId, thread);
    }
    for (const { profile, threadId } of found.values()) {
      yield* sessions.call(profile, () => profile.root.stub.deleteThread(threadId));
      yield* rows([{ id: threadId, profile: profile.label }], (row) => row.id);
    }
  }),
).pipe(
  Command.withDescription("Delete threads, even working ones, as the side panel's delete does"),
);

const rename = Command.make(
  "rename",
  {
    id: threadArgument,
    title: Argument.String("TITLE").pipe(
      Argument.withDescription("The thread's new title, 1 to 48 characters"),
      Argument.atLeast(1),
      Argument.mapTryCatch(
        (words) => threadTitleSchema.parse(words.join(" ")),
        () => "1 to 48 characters",
      ),
    ),
  },
  Effect.fn("rook.rename")(function* ({ id, title }) {
    const sessions = yield* RookSessions;
    const { profile, threadId } = yield* located(id);
    yield* sessions.call(profile, () => profile.root.stub.renameThread(threadId, title));
    yield* rows(
      [{ id: threadId, profile: profile.label, title }],
      (row) => `${row.id}\t${row.title}`,
    );
  }),
).pipe(Command.withDescription("Set a thread's title in the side panel's thread list"));

const toolsCommand = Command.make(
  "tools",
  { tab: tabFlag("Only list the tools on this tab id") },
  Effect.fn("rook.tools")(function* ({ tab }) {
    const profile = yield* selected;
    yield* rows(
      yield* tools(profile, tab),
      (tool) =>
        `${tool.name}\t${source(tool)}\t${tool.description?.replace(/\s+/gu, " ").trim() ?? ""}`,
    );
  }),
).pipe(Command.withDescription("List the WebMCP tools on open tabs and the connected MCP servers"));

const call = Command.make(
  "call",
  {
    name: Argument.String("NAME").pipe(
      Argument.withDescription("The tool's name, as rook tools prints it"),
    ),
    tab: tabFlag("Call the tool on this tab id when its name is in more than one place"),
    server: optional("server").pipe(
      Flag.withDescription(
        "Call the tool on this MCP server id when its name is in more than one place",
      ),
    ),
    args: optional("args").pipe(Flag.withDescription("The tool's input, as a JSON object")),
  },
  Effect.fn("rook.call")(function* (flags) {
    const sessions = yield* RookSessions;
    const output = yield* CliSession;
    const input = yield* toolInput(flags.args);
    const profile = yield* selected;
    const found = (yield* tools(profile, flags.tab)).filter(
      (tool) =>
        tool.name === flags.name && (flags.server === undefined || tool.serverId === flags.server),
    );
    const [tool] = found;
    if (!tool || found.length !== 1)
      return yield* CommandError.usage(
        tool
          ? `${flags.name} is on ${found.map(source).join(", ")}: pass --tab N or --server S`
          : `no tool ${flags.name} here; rook tools lists them`,
      );
    const result = yield* sessions.call(profile, () =>
      profile.root.stub.callTool(tool.serverId, flags.name, input),
    );
    if (output.machine) {
      yield* output.stdout(`${JSON.stringify(result)}\n`);
      return yield* output.finish(result.isError ? EXIT.failed : EXIT.done);
    }
    const { text, files } = toolReply(result);
    if (result.isError) return yield* CommandError.failed(text || `${flags.name} failed`);
    const saved = yield* output.saveFiles(randomUUID(), files);
    yield* output.stdout(
      `${text ? `${text}\n` : ""}${saved.map((file) => `file: ${file}\n`).join("")}`,
    );
  }),
).pipe(Command.withDescription("Call one tool directly, without a prompt, and print its result"));

const serve = Command.make(
  "serve",
  {},
  // Untraced: the daemon inherits its spawner's TRACEPARENT and OTLP settings,
  // and its lifetime is no part of that caller's trace.
  Effect.fnUntraced(function* () {
    const config = yield* RookConfig;
    const output = yield* CliSession;
    const token = yield* config.token;
    const relay = yield* scopedLocalRelay({ port: config.relayPort, token });
    yield* output.stderr(
      `rook serve ${packageJson.version} listening on http://127.0.0.1:${relay.port}\n`,
    );
    return yield* Effect.never;
  }),
).pipe(
  Command.withDescription(
    "Run the local relay between rook and Chrome; any rook command starts it when it is down",
  ),
);

/** A file the published package ships beside `bin/`. */
const shipped = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(fileURLToPath(new URL(`../${path}`, import.meta.url)));
});

// The guide is read from this package, never from an installed skill, so what
// an agent follows is always the version it runs.
const guide = Command.make(
  "guide",
  {},
  Effect.fn("rook.guide")(function* () {
    const output = yield* CliSession;
    yield* output.stdout(
      `# rook guide (rook ${packageJson.version})\n\n${yield* shipped("guide.md")}`,
    );
  }),
).pipe(Command.withDescription("Print the agent guide for this version of rook"));

const skill = Command.make("skill").pipe(
  Command.withDescription("The rook-browser skill an agent installs"),
  Command.withSubcommands([
    Command.make(
      "print",
      {},
      Effect.fn("rook.skill.print")(function* () {
        const output = yield* CliSession;
        yield* output.stdout(yield* shipped("skills/rook-browser/SKILL.md"));
      }),
    ).pipe(
      Command.withDescription("Print the rook-browser skill, which sends its reader to rook guide"),
    ),
  ]),
);

export const rook = rootCommand.pipe(
  Command.withDescription(`Hand web work to Rook in your Chrome profiles.

With one connected profile, --profile is optional. Otherwise use its email or ROOK_PROFILE. If none is connected, rook opens that Chrome profile or the Chrome Web Store and explains the remaining setup.

Without a terminal, ask and wait stop waiting after 100s. --timeout 0 waits indefinitely. A timeout or Ctrl-C leaves browser work running: resume with rook wait ID, or stop it with rook stop ID. Use ask --id UUID to safely repeat a submission. A valid TRACEPARENT parents each command's span, OTEL_TRACES_EXPORTER=otlp with an OTLP endpoint exports those spans, and ask and run carry the trace on to Rook.

Exit codes: 0 done, 1 failed, 2 usage, 3 needs a human, 4 token, 5 relay or profile unavailable, 6 stopped, 124 still running. rook bash returns its script's status.`),
  Command.withSubcommands([
    ask,
    wait,
    showCommand,
    stop,
    list,
    ps,
    remove,
    rename,
    bash,
    run,
    toolsCommand,
    call,
    modelCommand,
    serve,
    guide,
    skill,
  ]),
  Command.provideEffectDiscard(
    Effect.fnUntraced(function* ({ json }) {
      const output = yield* CliSession;
      yield* output.configure({ json });
    }),
  ),
);
