// The process lane's one fixture: the packed `rook` binary spawned as a real
// process against a fake peer that stands in for `rook serve` plus connected
// Chrome profiles. The peer is a local HTTP/WebSocket server answering the
// host list and the agent protocol; it never impersonates an internal CLI
// module or invokes a real model or Chrome. Every process gets its own
// ROOK_HOME/CODEX_HOME/HOME and the peer's ephemeral port, and a PATH holding
// only stubs for the browser launchers, so a CLI that finds no profile reads
// no real Chrome profile list and records a launch instead of opening one.
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, constants, createReadStream, openSync, readSync, writeSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MessageType, type OutgoingMessage } from "agents/chat";
import type { UIMessage } from "ai";
import { inject, TestRunner } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import packageJson from "../../package.json" with { type: "json" };
import { MODEL_FILE, modelConfigSchema, type ModelConfig } from "../model-settings";
import { HOSTS_PATH, LEASES_PATH, MODEL_TEST_PATH, SERVE_HEADER } from "../serve";
import type {
  RookConversation,
  RookDirectoryState,
  WorkspaceExecutionResult,
} from "../wire/contracts";
import { parseCompanionSeatAgentPath } from "../wire/relay";

export const THREAD = "lifecycle-thread";
export const PROFILE = "lifecycle-profile";
export const TOKEN = "peer-token";

/** The packed binary, built once per run by `global-setup.ts`. */
export const rookBinary = () => join(inject("rookPackage"), "bin", "rook");
/** The packed package root: `bin/rook` beside `guide.md` and `skills/`. */
export const rookPackage = () => inject("rookPackage");

// Vitest abandons a test at its timeout; the watchdog fires this much earlier
// so the child dies and the test reports its own assertion first.
const WATCHDOG_MARGIN_MS = 1_000;

/** The SIGKILL deadline for a process spawned by the running test. A
 * concurrent test passes its own `task.timeout`: the runner's current test is
 * one global, set by whichever concurrent test started last. */
export function watchdogMs(timeout = TestRunner.getCurrentTest()?.timeout): number {
  if (timeout === undefined) throw new Error("Spawn rook processes from inside a test");
  // A disabled test timeout (0) leaves the watchdog at setTimeout's maximum.
  if (timeout <= 0) return 2 ** 31 - 1;
  return Math.max(timeout - WATCHDOG_MARGIN_MS, timeout / 2);
}

const rpcSchema = z.object({
  type: z.literal("rpc"),
  id: z.string(),
  method: z.enum([
    "setOpenAiCompatibleModelSource",
    "listTools",
    "startThread",
    "runAutomation",
    "deleteThread",
    "renameThread",
    "turnOutcome",
    "inspectSubmission",
    "stopCurrentWork",
    "submitMessage",
    "getMessages",
  ]),
  args: z.array(z.unknown()),
  /** The caller's W3C context, when the CLI was given one. */
  traceparent: z.string().optional(),
});
const rpcFrameSchema = z.object({ type: z.literal("rpc") }).passthrough();
const modelSchema = z.object({ baseUrl: z.string(), modelId: z.string() }).passthrough();
const eventSchema = z
  .object({
    v: z.literal(1),
    ts: z.iso.datetime(),
    type: z.string(),
    thread: z.string().optional(),
    exit: z.number().optional(),
    status: z.string().optional(),
    text: z.string().optional(),
  })
  .passthrough();

/** Parses `--json` stdout into its event lines. */
export function events(stdout: string) {
  return stdout
    .trim()
    .split("\n")
    .map((line) => eventSchema.parse(JSON.parse(line)));
}

const LAUNCHERS = ["open", "xdg-open", "google-chrome"];

/** Puts the browser-launcher stubs in `home`/bin; `spawnRook` makes that the
 * whole PATH. Each stub appends its command line to `home`/opened. */
export async function stubBrowsers(home: string) {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  for (const launcher of LAUNCHERS) {
    const stub = join(bin, launcher);
    await writeFile(stub, `#!/bin/sh\necho "${launcher} $*" >> "${join(home, "opened")}"\n`);
    await chmod(stub, 0o755);
  }
  return home;
}

/** Browser launches the processes spawned against `home` attempted. */
export const opened = (home: string) => readFile(join(home, "opened"), "utf8").catch(() => "");

/** A fresh ROOK_HOME holding the peer token and `model`. */
export async function rookHome(model: ModelConfig = NO_MODEL) {
  const home = await stubBrowsers(await mkdtemp(join(tmpdir(), "rook-peer-")));
  await writeFile(join(home, "token"), TOKEN);
  await writeFile(join(home, MODEL_FILE), JSON.stringify(modelConfigSchema.parse(model)));
  return home;
}

const NO_MODEL: ModelConfig = { version: 1, upstreams: {}, default: null, off: [] };

export type FakePeerOptions = {
  /** Profiles the host list advertises, in order. */
  profiles?: readonly string[];
  /** Threads every profile's roster lists; each answers as a conversation. */
  threads?: readonly string[];
  /** The model.json written to ROOK_HOME. */
  model?: ModelConfig;
  /** Advertise one more profile that greets with an identity but no state. */
  brokenProfile?: boolean;
  /** Every profile reports a human wait on THREAD. */
  human?: boolean;
  /** Stall the host list after its headers or partway through its body. */
  discovery?: "headers" | "body";
  /** Hold a conversation's greeting, or greet by resuming a stream. */
  greeting?: "held" | "resume";
  /** turnOutcome's answer, or "held" to leave it for `respond`; `setOutcome` changes it. */
  outcome?: Outcome | "held";
  /** The last turn's error, which a stream-resume request replays as Think does;
   * without it the peer answers that no stream exists. */
  terminal?: string;
  /** Leave stdout unread in a full kernel pipe until `resumeOutput`. */
  holdOutput?: boolean;
  // The CLI SIGTERMs the advertised pid when the advertised version is older
  // than its own. A test that advertises another version must pass the pid of
  // a process it owns, never the default (the test runner itself).
  /** The `rook-serve` header's version; defaults to this package's. */
  version?: string;
  /** The `rook-serve` header's pid, read per answer; defaults to the test runner's. */
  pid?: () => number;
  /** The running test's timeout, from its context when it runs concurrently. */
  timeout?: number;
  /** RPCs this Rook refuses before acting, each with the error it answers. */
  refuses?: Readonly<Record<string, string>>;
};

type Outcome = Awaited<ReturnType<RookConversation["turnOutcome"]>>;
type Submission = NonNullable<Awaited<ReturnType<RookConversation["inspectSubmission"]>>>;
type RpcResult =
  | Outcome
  | Submission
  | WorkspaceExecutionResult
  | readonly never[]
  | readonly UIMessage[]
  | boolean
  | null;
type Call = { socket: WebSocket; call: z.infer<typeof rpcSchema> };

export async function fakePeer(options: FakePeerOptions = {}) {
  const profiles = options.profiles ?? [PROFILE];
  const threads = options.threads ?? [THREAD];
  const home = await rookHome(options.model);
  const states = new Map<string, RookDirectoryState>(
    profiles.map((id): [string, RookDirectoryState] => [
      id,
      {
        threads: threads.map((thread) => ({
          id: thread,
          title: "Lifecycle",
          updatedAt: Date.now(),
          status: "idle",
        })),
        browser: {
          waits: options.human
            ? {
                wait: {
                  threadId: THREAD,
                  tabId: 7,
                  reason: "Sign in",
                  expiresAt: Date.now() + 60_000,
                },
              }
            : {},
        },
        operatingIdentity: { kind: "personal" },
        profileVerification: { status: "signed-out" },
        model: { kind: "chatgpt-oauth", status: "signed-out" },
        managedPolicy: null,
      },
    ]),
  );
  const calls: Call[] = [];
  const writes: string[] = [];
  const discovered = new Set<string>();
  const execution = Promise.withResolvers<WorkspaceExecutionResult>();
  const executionFailure = Promise.withResolvers<string>();
  // Conversations answer for the configured threads and for those a run mints;
  // a deleted thread's socket closes and its reconnects are refused.
  const known = [...threads];
  const deleted = new Set<string>();
  const conversationThreads = new Map<WebSocket, string>();
  let executionResult: WorkspaceExecutionResult | undefined;
  const roots = new Map<WebSocket, RookDirectoryState>();
  const conversations = new Set<WebSocket>();
  const received: unknown[] = [];
  let discoveries = 0;
  let disconnected = 0;
  /** Test requests the CLI asked serve to send: the candidate upstream, the
   * request body, and the response this peer answers as that upstream. */
  const probes: Array<{ upstream: unknown; body: unknown; response: ServerResponse }> = [];
  const leases: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === MODEL_TEST_PATH && request.headers.authorization === `Bearer ${TOKEN}`) {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        const test = z
          .object({ upstream: z.unknown(), body: z.unknown() })
          .parse(JSON.parse(body));
        probes.push({ ...test, response });
      });
      return;
    }
    // One process per test: every lease is free, as on an idle daemon.
    if (request.url?.startsWith(LEASES_PATH) && request.headers.authorization === `Bearer ${TOKEN}`) {
      leases.push(`${request.method} ${request.url.split("?")[0]}`);
      if (request.method === "DELETE") response.writeHead(204).end();
      else
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ id: randomUUID() }));
      return;
    }
    if (request.url !== HOSTS_PATH || request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(403).end();
      return;
    }
    discoveries++;
    if (options.discovery === "headers") return;
    response.writeHead(200, {
      "content-type": "application/json",
      [SERVE_HEADER]: `${options.version ?? packageJson.version} ${options.pid?.() ?? process.pid}`,
    });
    if (options.discovery === "body") {
      response.write("[");
      return;
    }
    response.end(
      JSON.stringify([
        ...profiles.map((id) => ({ id })),
        ...(options.brokenProfile ? [{ id: "broken-profile" }] : []),
      ]),
    );
  });
  const sockets = new WebSocketServer({ server });
  let outcome = options.outcome;
  const messages: UIMessage[] = [
    { id: "user", role: "user", parts: [{ type: "text", text: "hello" }] },
    { id: "assistant", role: "assistant", parts: [{ type: "text", text: "Finished." }] },
  ];
  const transcript = (): OutgoingMessage => ({
    type: MessageType.CF_AGENT_CHAT_MESSAGES,
    messages,
  });
  // Think's submission records by id, as inspectSubmission answers them.
  const submissions = new Map<string, Submission>();
  const FAILED_TURN = "failed-turn";
  const greet = (socket: WebSocket) => socket.send(JSON.stringify(transcript()));
  const answer = (socket: WebSocket, id: string, result: RpcResult) =>
    socket.send(JSON.stringify({ type: "rpc", id, success: true, result }));
  const publish = (state: RookDirectoryState) => {
    for (const [socket, rootState] of roots)
      if (rootState === state) socket.send(JSON.stringify({ type: "cf_agent_state", state }));
  };
  sockets.on("connection", (socket, request) => {
    const route = parseCompanionSeatAgentPath(new URL(request.url!, "http://localhost").pathname);
    socket.on("close", () => disconnected++);
    if (options.brokenProfile && route?.subject === "broken-profile") {
      socket.send(
        JSON.stringify({ type: "cf_agent_identity", agent: "browser-think-agent", name: "think" }),
      );
      return;
    }
    const profile = route?.subject;
    const state = profile && states.get(profile);
    if (!profile || !state) throw new Error("Unexpected profile route");
    discovered.add(profile);
    const thread = known.find((id) => route.agentPath.endsWith(`/${id}`));
    if (thread && deleted.has(thread)) {
      socket.close();
      return;
    }
    socket.send(
      JSON.stringify({
        type: "cf_agent_identity",
        agent: thread ? "browser-think-conversation" : "browser-think-agent",
        name: thread ?? "think",
        stateFollows: true,
      }),
    );
    socket.send(
      JSON.stringify({
        type: "cf_agent_state",
        state: thread ? { executionTrace: { executionId: "execution" } } : state,
      }),
    );
    socket.on("message", (bytes) => {
      const frame: unknown = JSON.parse(String(bytes));
      received.push(frame);
      const resume = z.object({ type: z.string(), id: z.string().optional() }).safeParse(frame);
      if (resume.success && resume.data.type === MessageType.CF_AGENT_STREAM_RESUME_REQUEST) {
        const reply: OutgoingMessage =
          options.terminal === undefined
            ? { type: MessageType.CF_AGENT_STREAM_RESUME_NONE }
            : { type: MessageType.CF_AGENT_STREAM_RESUMING, id: FAILED_TURN };
        socket.send(JSON.stringify(reply));
        return;
      }
      if (
        resume.success &&
        resume.data.type === MessageType.CF_AGENT_STREAM_RESUME_ACK &&
        resume.data.id === FAILED_TURN &&
        options.terminal !== undefined
      ) {
        // The failed turn's own output replays first, then its error.
        const frames: OutgoingMessage[] = [
          {
            type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
            id: FAILED_TURN,
            done: false,
            replay: true,
            body: JSON.stringify({ type: "text-delta", id: "replayed", delta: "Partial." }),
          },
          {
            type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
            id: FAILED_TURN,
            done: false,
            replay: true,
            body: JSON.stringify({ type: "text-end", id: "replayed" }),
          },
          {
            type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
            id: FAILED_TURN,
            done: true,
            error: true,
            body: options.terminal,
          },
        ];
        for (const reply of frames) socket.send(JSON.stringify(reply));
        return;
      }
      if (!rpcFrameSchema.safeParse(frame).success) return;
      // An RPC the peer does not model fails the run rather than hanging it.
      const call = rpcSchema.parse(frame);
      calls.push({ socket, call });
      const error = options.refuses?.[call.method];
      if (error !== undefined) {
        socket.send(JSON.stringify({ type: "rpc", id: call.id, success: false, error }));
        return;
      }
      if (call.method === "setOpenAiCompatibleModelSource") {
        writes.push(profile);
        const [source] = call.args;
        state.model =
          source === null
            ? { kind: "chatgpt-oauth", status: "signed-out" }
            : { ...modelSchema.parse(source), kind: "openai-compatible" };
        socket.send(JSON.stringify({ type: "cf_agent_state", state }));
        answer(socket, call.id, null);
      }
      if (call.method === "listTools") answer(socket, call.id, []);
      if (call.method === "startThread") answer(socket, call.id, null);
      if (call.method === "runAutomation") {
        // As Rook does, a run in a new thread mints it, titled for its script.
        const [threadId, path] = z
          .tuple([z.string(), z.string()])
          .rest(z.unknown())
          .parse(call.args);
        if (!state.threads.some(({ id }) => id === threadId)) {
          known.push(threadId);
          state.threads = [
            ...state.threads,
            {
              id: threadId,
              title: path.split("/").at(-1) ?? path,
              updatedAt: Date.now(),
              status: "running",
            },
          ];
          publish(state);
        }
        void execution.promise.then((result) => {
          executionResult = result;
          if (socket.readyState === WebSocket.OPEN) answer(socket, call.id, result);
        });
        void executionFailure.promise.then((error) => {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: "rpc", id: call.id, success: false, error }));
        });
      }
      if (call.method === "deleteThread") {
        const [threadId] = z.tuple([z.string()]).parse(call.args);
        deleted.add(threadId);
        for (const [conversation, id] of conversationThreads)
          if (id === threadId) conversation.close();
        state.threads = state.threads.filter(({ id }) => id !== threadId);
        publish(state);
        answer(socket, call.id, null);
      }
      if (call.method === "renameThread") {
        const [threadId, title] = z.tuple([z.string(), z.string()]).parse(call.args);
        state.threads = state.threads.map((thread) =>
          thread.id === threadId ? { ...thread, title } : thread,
        );
        publish(state);
        answer(socket, call.id, null);
      }
      if (call.method === "turnOutcome" && outcome !== "held") {
        answer(socket, call.id, outcome ?? "completed");
      }
      if (call.method === "getMessages") answer(socket, call.id, messages);
      if (call.method === "inspectSubmission") {
        const [id] = z.tuple([z.string()]).parse(call.args);
        answer(socket, call.id, submissions.get(id) ?? null);
      }
      if (call.method === "submitMessage") {
        const [, messageId] = z.tuple([z.string(), z.string(), z.string()]).parse(call.args);
        answer(socket, call.id, !submissions.has(messageId));
        if (!submissions.has(messageId)) submissions.set(messageId, { status: "pending" });
      }
    });
    if (thread) {
      conversations.add(socket);
      conversationThreads.set(socket, thread);
      if (options.greeting === "resume") {
        const frame: OutgoingMessage = { type: MessageType.CF_AGENT_STREAM_RESUMING, id: "turn" };
        socket.send(JSON.stringify(frame));
      } else if (options.greeting !== "held") greet(socket);
    } else roots.set(socket, state);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const children: ReturnType<typeof spawnRook>[] = [];
  return {
    calls,
    home,
    states,
    /** Every conversation's transcript, which getMessages answers; mutate it. */
    messages,
    /** Submission records by message id; set one to change what inspectSubmission answers. */
    submissions,
    /** Changes what later turnOutcome calls answer. */
    setOutcome: (next: Outcome) => {
      outcome = next;
    },
    /** The first profile's state; mutate it, then `publishState`. */
    state: states.get(profiles[0]!)!,
    /** Profiles that received a model write, in order. */
    writes,
    /** Lease requests, as `<method> <path>`. */
    leases,
    /** Profiles the CLI opened a socket to. */
    discovered,
    origin: `http://127.0.0.1:${port}`,
    probes,
    candidate: `http://127.0.0.1:${port}/candidate/v1`,
    finishExecution: execution.resolve,
    /** Fails every pending and later runAutomation call with `error`. */
    failExecution: executionFailure.resolve,
    get executionResult() {
      return executionResult;
    },
    conversations,
    received,
    get discoveries() {
      return discoveries;
    },
    get disconnected() {
      return disconnected;
    },
    /** Sends every conversation the transcript, as Think does when a turn starts or ends. */
    greet: () => {
      for (const socket of conversations) greet(socket);
    },
    publishState: async () => {
      await Promise.all(
        [...roots].map(async ([socket, state]) => {
          socket.send(JSON.stringify({ type: "cf_agent_state", state }));
          const pong = once(socket, "pong");
          // Receiving the later ping confirms the client consumed the state
          // frame before the test releases its unrelated filesystem operation.
          socket.ping();
          await pong;
        }),
      );
    },
    /** Streams `messages` as one turn under request `id`, then the transcript. */
    stream: (messages: readonly string[] = ["Finished."], id = "turn") => {
      const frames: OutgoingMessage[] = messages.flatMap((text, index) => [
        {
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
          id,
          done: false,
          body: JSON.stringify({ type: "text-delta", id: `text-${index}`, delta: text }),
        },
        {
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
          id,
          done: false,
          body: JSON.stringify({ type: "text-end", id: `text-${index}` }),
        },
      ]);
      for (const socket of conversations) {
        for (const frame of [...frames, transcript()]) socket.send(JSON.stringify(frame));
      }
    },
    respond: (method: string, result: "completed" | "aborted" | null) => {
      for (const { socket, call } of calls.filter(({ call }) => call.method === method)) {
        answer(socket, call.id, result);
      }
    },
    /** Spawns rook; the handle exposes the child and its settled result. */
    start: (...args: string[]) => {
      const running = spawnRook(home, port, args, options.holdOutput, options.timeout);
      children.push(running);
      return running;
    },
    /** Runs rook to completion; rejects with `code`/`stderr` on a nonzero exit. */
    run: (...args: string[]) =>
      promisify(execFile)(process.execPath, [rookBinary(), ...args], {
        env: rookEnv(home, port),
        timeout: watchdogMs(options.timeout),
      }),
    close: async () => {
      for (const running of children) {
        running.resumeOutput();
        const { child } = running;
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, "close");
          child.kill("SIGKILL");
          await closed;
        }
      }
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    },
  };
}

// The developer's own trace settings never reach a test's rook: dropped as the
// runner loads, so only what a test sets itself (`vi.stubEnv`) is passed on.
for (const name of Object.keys(process.env))
  if (name === "TRACEPARENT" || name.startsWith("OTEL_")) delete process.env[name];

/** The environment of a rook process: `home` stands in for every home it could
 * read, and PATH holds only `stubBrowsers`' launchers. */
export function rookEnv(home: string, port: number | string) {
  return {
    ...process.env,
    HOME: home,
    PATH: join(home, "bin"),
    ROOK_HOME: home,
    CODEX_HOME: home,
    ROOK_PROFILE: "",
    ROOK_RELAY_PORT: String(port),
  };
}

/** Spawns the packed rook against `home` and relay `port` (0 binds an ephemeral
 * one); `timeout` is the spawning test's, as `watchdogMs` takes it. */
export function spawnRook(
  home: string,
  port: number,
  args: string[],
  holdOutput = false,
  timeout?: number,
) {
  // Node's ordinary "pipe" is a socket on Unix. Use a real pipe for this
  // regression so three sub-high-water-mark writes exceed its kernel buffer.
  let reader: number | undefined;
  let writer: number | undefined;
  let pipeCapacity = 0;
  if (holdOutput) {
    const fifo = join(home, "stdout.fifo");
    execFileSync("mkfifo", [fifo]);
    const bootstrap = openSync(fifo, "r+");
    reader = openSync(fifo, "r");
    writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    closeSync(bootstrap);
    const block = Buffer.alloc(4096);
    for (;;) {
      try {
        pipeCapacity += writeSync(writer, block);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EAGAIN") break;
        throw error;
      }
    }
    for (let remaining = pipeCapacity; remaining > 0;) {
      remaining -= readSync(reader, block, 0, Math.min(block.length, remaining), null);
    }
  }
  const deadline = watchdogMs(timeout);
  const child = spawn(process.execPath, [rookBinary(), ...args], {
    env: rookEnv(home, port),
    stdio: ["ignore", writer ?? "pipe", "pipe"],
  });
  if (writer !== undefined) closeSync(writer);
  let stdout = "";
  let stderr = "";
  const outputDone = Promise.withResolvers<void>();
  const collect = (stream: NodeJS.ReadableStream) => {
    stream.on("data", (chunk) => {
      stdout += String(chunk);
    });
    stream.on("end", () => outputDone.resolve());
    stream.on("error", outputDone.reject);
  };
  const resumeOutput = () => {
    if (reader === undefined) return;
    collect(createReadStream("", { fd: reader }));
    reader = undefined;
  };
  if (child.stdout) collect(child.stdout);
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  // A broken deadline must fail the assertion, not strand a child after
  // Vitest abandons the test. Every successful run clears this watchdog.
  const watchdog = setTimeout(() => child.kill("SIGKILL"), deadline);
  const result = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(watchdog);
      outputDone.promise.then(() => resolve({ code, signal, stdout, stderr }), reject);
    });
  });
  return {
    child,
    result,
    resumeOutput,
    pipeCapacity,
    get stderr() {
      return stderr;
    },
  };
}
