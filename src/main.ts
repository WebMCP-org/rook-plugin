#!/usr/bin/env node
// `rook`: hands web work to Rook, the agent in your Chrome profiles (ADR 0082).
// A run lives in Chrome; this process only starts it and watches it, so killing
// `rook` never stops one. Profiles are reached through `rook serve`, the
// companion relay on loopback, which the first command starts.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { text as readStream } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { MessageType, type IncomingMessage, type OutgoingMessage } from "agents/chat";
import { AgentClient } from "agents/client";
import {
  getToolName,
  isFileUIPart,
  isTextUIPart,
  isToolUIPart,
  type FileUIPart,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import packageJson from "../package.json" with { type: "json" };
import { chromeProfiles, openChrome, openUrl, STORE_URL, type ChromeProfile } from "./chrome";
import { adoptModel, duration, modelCommand, UsageError, type Profile } from "./model";
import { modelRelay } from "./relay";
import { LOCAL_RELAY_ORIGIN } from "./local-relay";
import { HOSTS_PATH, SERVE_HEADER, startLocalRelay } from "./serve";
import {
  AGENT_CALL_TIMEOUT_MS,
  AGENT_CLASS_NAME,
  AGENT_INSTANCE_NAME,
  CONVERSATION_AGENT_CLASS_NAME,
  executionTraceFile,
  mcpToolInputSchema,
  type McpToolDescriptor,
  type McpToolInput,
  type RookConversation,
  type RookConversationState,
  type RookDirectory,
  type RookDirectoryState,
  type WorkspaceExecutionResult,
} from "./wire/contracts";
import {
  companionSeatAgentsPrefix,
  LOCAL_RELAY_RECONNECT_MAX_MS,
  TUNNEL_CONNECT_TIMEOUT_MS,
  TUNNEL_HEARTBEAT_ACK,
  TUNNEL_HEARTBEAT_REQUEST,
} from "./wire/relay";

const AGENT_WAIT_MS = 100_000;
/** How long a Chrome that rook opened gets to start Rook and dial in. */
const CHROME_START_MS = 30_000;
/** How long a newly connected profile gets to learn who it is signed in as. */
const VERIFY_MS = 10_000;
const HOME = process.env.ROOK_HOME ?? join(homedir(), ".rook");
/** Where `rook serve` listens. */
const RELAY = new URL(LOCAL_RELAY_ORIGIN);

/** Every exit code, which SKILL.md's table lists (main.test.ts checks). A
 * script's own status passes through `rook bash`. */
export const EXIT = {
  done: 0,
  failed: 1,
  usage: 2,
  needsHuman: 3,
  token: 4,
  unavailable: 5,
  stopped: 6,
  running: 124,
} as const;

const USAGE = `rook ${packageJson.version}: hand web work to Rook in your Chrome profiles

  rook ask PROMPT|-   [--profile P] [--thread ID] [--id UUID] [--json] [--detach]
                      [--timeout DUR] [--wait-human]
  rook wait ID        [--json] [--timeout DUR] [--wait-human]
  rook show ID        [--tools] [--json]   the thread as the side panel shows it
  rook stop ID
  rook ls             [--json]   connected profiles
  rook ps             [--profile P] [--json]   threads
  rook bash SCRIPT    [--profile P]   Rook's shell on its workspace; pipes in and out
  rook run PATH       [--profile P] [--thread ID] [--args JSON] [--json]
                      [--timeout DUR]   an /automations script; prints what it returns
  rook tools          [--profile P] [--tab N] [--json]   open tabs' WebMCP and MCP server tools
  rook call NAME      [--profile P] [--tab N] [--server S] [--args JSON] [--json]
                      one tool, as Rook's code calls it; prints its result
  rook model [codex|url BASE|off]  [--profile P] [--model ID] [--effort E]
                      the model rook serve gives Rook; rook model -h for the rest
  rook serve          the relay on 127.0.0.1 (started on demand)
  rook skill print    the agent guide for this version

--profile takes a profile's email (or ROOK_PROFILE); with one profile it is optional.
--id makes an ask safe to repeat: a second ask with the same id reports the first.
When no profile is connected, rook opens Chrome (that profile, with --profile), or
Rook's Chrome Web Store page when Rook is not installed, and says what is left to do.
Without a terminal, ask and wait stop waiting after 100s; --timeout 0 waits on.

Exit codes: 0 done, 1 failed, 2 usage, 3 needs a human, 4 token,
5 relay or profile unavailable, 6 stopped, 124 still running (rook wait ID).
rook bash exits with its script's status.
`;

/** An expected failure: the message goes to stderr, the code is the exit. */
class Exit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

let cachedToken: string | undefined;

/** The relay's token. Mode 0600 confines it to this macOS user, which is the
 * boundary ADR 0082 accepts in place of the hosted relay's Google grant. */
function token(): string {
  if (cachedToken) return cachedToken;
  const path = join(HOME, "token");
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  return (cachedToken = readFileSync(path, "utf8").trim());
}

type Serve = { hosts: string[]; version: string; pid: number };

/** The running serve's online host ids, or undefined when no relay answers. */
async function onlineHosts(): Promise<Serve | undefined> {
  let response: Response;
  try {
    response = await fetch(new URL(HOSTS_PATH, RELAY), {
      headers: { authorization: `Bearer ${token()}` },
    });
  } catch {
    return undefined;
  }
  if (response.status === 401) {
    throw new Exit(EXIT.token, "the running rook serve holds another token; stop it and retry");
  }
  if (!response.ok) throw new Exit(EXIT.unavailable, `rook serve answered ${response.status}`);
  const [version = "", pid] = response.headers.get(SERVE_HEADER)?.split(" ") ?? [];
  // SAFETY: only a relay holding this token answers 200, and serve.ts writes
  // HOSTS_PATH as an array of { id }.
  const hosts = ((await response.json()) as Array<{ id: string }>).map(({ id }) => id);
  return { hosts, version, pid: Number(pid) };
}

/** Stops a serve of another version, which may speak an older protocol. */
async function stopStaleServe(serve: Serve): Promise<void> {
  process.kill(serve.pid, "SIGTERM");
  for (const deadline = Date.now() + 5_000; await onlineHosts(); await sleep(100)) {
    if (Date.now() >= deadline) {
      throw new Exit(
        EXIT.unavailable,
        `rook serve ${serve.version} (pid ${serve.pid}) did not stop`,
      );
    }
  }
  process.stderr.write(`stopped rook serve ${serve.version}; starting ${packageJson.version}\n`);
}

/** The relay's online host ids, starting `rook serve` when none answers. */
async function connectedHosts(): Promise<string[]> {
  let settled = Date.now();
  // A profile that lost its socket redials within one backoff ceiling.
  let deadline = settled + LOCAL_RELAY_RECONNECT_MAX_MS + 1_000;
  let running = await onlineHosts();
  if (running && running.version !== packageJson.version) {
    await stopStaleServe(running);
    running = undefined;
  }
  if (!running) {
    const log = openSync(join(HOME, "serve.log"), "a");
    const argv1 = process.argv[1] ?? "rook";
    spawn(process.execPath, [argv1, "serve"], {
      detached: true,
      stdio: ["ignore", log, log],
    }).unref();
    // Every opted-in profile redials within one backoff ceiling, so a list
    // taken after it is complete.
    settled += LOCAL_RELAY_RECONNECT_MAX_MS + 1_000;
    deadline = settled + 2_000;
    process.stderr.write("started rook serve; waiting for Chrome profiles to connect\n");
  }
  for (;;) {
    const hosts = (await onlineHosts())?.hosts;
    if (hosts?.length && Date.now() >= settled) return hosts;
    if (Date.now() >= deadline) {
      if (hosts) return [];
      throw new Exit(EXIT.unavailable, `rook serve did not start; see ${join(HOME, "serve.log")}`);
    }
    await sleep(500);
  }
}

/** The host ids beyond `known` once one comes online, or none after `ms`. */
async function newHosts(known: ReadonlySet<string>, ms: number): Promise<string[]> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const added = ((await onlineHosts())?.hosts ?? []).filter((id) => !known.has(id));
    if (added.length) return added;
    await sleep(500);
  }
  return [];
}

function dial<Agent, State>(hostId: string, agent: string, name: string) {
  const authorization = `Bearer ${token()}`;
  // Node's WebSocket sends headers and no Origin, which is what the relay
  // admits; the companion PWA's tunnel heartbeat applies unchanged.
  class TokenWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, { protocols, headers: { authorization } });
      this.addEventListener("message", (event) => {
        if (event.data !== TUNNEL_HEARTBEAT_REQUEST) return;
        event.stopImmediatePropagation();
        this.send(TUNNEL_HEARTBEAT_ACK);
      });
    }
  }
  return new AgentClient<Agent, State>({
    agent,
    name,
    host: RELAY.host,
    protocol: "ws",
    prefix: companionSeatAgentsPrefix(hostId),
    WebSocket: TokenWebSocket,
    minReconnectionDelay: 250,
    maxReconnectionDelay: 1_000,
    connectionTimeout: TUNNEL_CONNECT_TIMEOUT_MS + 2_000,
    defaultCallTimeout: AGENT_CALL_TIMEOUT_MS,
  });
}

function within<T>(promise: Promise<T>, message: string): Promise<T> {
  const timeout = sleep(TUNNEL_CONNECT_TIMEOUT_MS * 2).then(() => {
    throw new Exit(EXIT.unavailable, message);
  });
  return Promise.race([promise, timeout]);
}

type Directory = AgentClient<RookDirectory, RookDirectoryState>;

/** The connected profiles, opening Chrome when the one wanted, or any, is not
 * connected. Discovery never changes a profile's model. */
async function profiles(wanted: string | undefined): Promise<Profile[]> {
  const hosts = await connectedHosts();
  const connected = await answering(hosts);
  if (matching(connected, wanted).length) return connected;
  // Chrome is open and Rook in it is stuck: opening Chrome again changes nothing.
  if (hosts.length && !connected.length) {
    throw new Exit(
      EXIT.unavailable,
      "no connected profile answered: ask the user to restart Chrome, then run this again",
    );
  }
  const chrome = chromeToOpen(wanted);
  const where = chrome.email ? ` profile ${chrome.email}` : "";
  openChrome({ profile: chrome.dir });
  process.stderr.write(`opened Chrome${where}; waiting for Rook to connect\n`);
  const known = new Set(hosts);
  const added = await newHosts(known, CHROME_START_MS);
  const reached = [...connected, ...(await answering(added))];
  if (matching(reached, wanted).length) return reached;
  throw new Exit(
    EXIT.unavailable,
    `opened Chrome${where}, but Rook did not connect: ask the user to open Rook's side panel there and keep Allow local agents on in its menu, then run this again`,
  );
}

/** The Chrome profile to open for `wanted`, or for anyone when it is omitted. */
function chromeToOpen(wanted: string | undefined): ChromeProfile {
  const chrome = chromeProfiles();
  const withRook = chrome.filter(({ rook }) => rook);
  const names = withRook.map(({ dir, email }) => email || dir).join(", ");
  if (!wanted && withRook.length > 1) {
    throw new Exit(
      EXIT.usage,
      `Rook is in Chrome profiles ${names} and none is connected: ask the user which one, then pass --profile <email> on every rook call; rook opens that profile`,
    );
  }
  const target = wanted
    ? chrome.find(({ email }) => email.toLowerCase() === wanted.toLowerCase())
    : withRook[0];
  if (wanted && !target) {
    throw new Exit(
      EXIT.usage,
      `no connected profile or Chrome profile is ${wanted}${names ? `; Chrome profiles with Rook: ${names}` : ""}`,
    );
  }
  if (target?.rook) return target;
  // Installing takes the user's click, so the store page comes to the front.
  if (chrome.length) openChrome({ profile: target?.dir, url: STORE_URL });
  else openUrl(STORE_URL);
  throw new Exit(
    EXIT.unavailable,
    chrome.length
      ? `Rook is not installed in Chrome${target?.email ? ` profile ${target.email}` : ""}. Opened ${STORE_URL} in Chrome: ask the user to click Add to Chrome and follow Rook's setup tab, then run this again`
      : `found no Google Chrome profile here. Opened ${STORE_URL}: ask the user to install or open Chrome, add Rook from that page if it isn't there and follow Rook's setup tab, then run this again`,
  );
}

/** The profiles behind these hosts that answer; one that hangs is skipped, not fatal. */
async function answering(hosts: readonly string[]): Promise<Profile[]> {
  const settled = await Promise.allSettled(
    hosts.map(async (id) => {
      const root: Directory = dial(id, AGENT_CLASS_NAME, AGENT_INSTANCE_NAME);
      await within(root.ready, `profile ${id.slice(0, 8)} did not answer`);
      // A profile Chrome just started is still checking who it is signed in as.
      const until = Date.now() + VERIFY_MS;
      while (directory(root).profileVerification.status === "unknown" && Date.now() < until) {
        await sleep(200);
      }
      return { id, root, label: label(id, directory(root)) };
    }),
  );
  const answered: Profile[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") answered.push(result.value);
    else process.stderr.write(`rook: skipped ${String(result.reason?.message ?? result.reason)}\n`);
  }
  return answered;
}

function directory(root: Directory): RookDirectoryState {
  if (!root.state) throw new Exit(EXIT.unavailable, "the profile sent no state");
  return root.state;
}

function label(id: string, state: RookDirectoryState): string {
  if (state.profileVerification.status === "verified") return state.profileVerification.email;
  if (state.operatingIdentity.kind === "employee") return state.operatingIdentity.email;
  return id.slice(0, 8);
}

/** The profiles `wanted` names by label (any case) or host-id prefix; all of
 * them when it is omitted. */
function matching(all: Profile[], wanted: string | undefined): Profile[] {
  return wanted
    ? all.filter(
        ({ id, label }) => label.toLowerCase() === wanted.toLowerCase() || id.startsWith(wanted),
      )
    : all;
}

/** The profile `wanted` names; omitted, the only profile online. */
function pick(all: Profile[], wanted: string | undefined): Profile {
  const matches = matching(all, wanted);
  const [only] = matches;
  if (only && matches.length === 1) return only;
  const choices = all.map(({ label }) => label).join(", ");
  // A name that matches nothing is usually a profile that is closed or opted out.
  if (wanted && !matches.length) {
    throw new Exit(
      EXIT.unavailable,
      `no connected profile matches ${wanted}; connected: ${choices}`,
    );
  }
  throw new Exit(
    EXIT.usage,
    `${all.length} profiles are connected: ${choices}. Ask the user which one, then pass --profile <email> on every rook call`,
  );
}

/** Provision only the uniquely selected profile, after ambiguity is resolved. */
async function selectProfile(all: Profile[], wanted: string | undefined): Promise<Profile> {
  const profile = pick(all, wanted);
  await adoptModel(profile, HOME);
  return profile;
}

/** A thread id or unique prefix, searched in every profile unless one is named. */
function locate(all: Profile[], wanted: string | undefined, prefix: string) {
  const candidates = wanted ? [pick(all, wanted)] : all;
  const found = candidates.flatMap((profile) =>
    directory(profile.root)
      .threads.filter(({ id }) => id.startsWith(prefix))
      .map(({ id }) => ({ profile, threadId: id })),
  );
  const [only] = found;
  if (only && found.length === 1) return only;
  throw new Exit(
    EXIT.usage,
    found.length
      ? `${prefix} matches ${found.map(({ threadId }) => threadId).join(", ")}`
      : `no thread ${prefix}`,
  );
}

/** What the side panel shows of Rook's reply to the last user message: its
 * text and files. Tool calls and reasoning stay behind `rook show --tools`. */
export type Reply = { text: string; files: FileUIPart[] };

export function reply(messages: readonly UIMessage[]): Reply {
  const turn = messages.slice(messages.findLastIndex(({ role }) => role === "user") + 1);
  const parts = turn.flatMap(({ role, parts }) => (role === "assistant" ? parts : []));
  return {
    text: parts
      .flatMap((part) => (isTextUIPart(part) && part.text.trim() ? [part.text.trim()] : []))
      .join("\n\n"),
    files: parts.filter(isFileUIPart),
  };
}

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

/** Saves data-URL files under ~/.rook/files/<id>/ and returns where each is:
 * that path, or the URL a file already lives at. */
function saveFiles(id: string, files: readonly FileUIPart[]): string[] {
  return files.map((file, index) => {
    const data = /^data:[^,]*;base64,(.*)$/su.exec(file.url)?.[1];
    if (data === undefined) return file.url;
    const extension = /^[\w.+-]+\/([\w]+)/u.exec(file.mediaType)?.[1] ?? "bin";
    const dir = join(HOME, "files", id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, basename(file.filename || `${index + 1}.${extension}`));
    writeFileSync(path, Buffer.from(data, "base64"));
    return path;
  });
}

/** `--json` output, one line each. A run's last line is its `result`. A
 * failure of `rook` itself is not one of these: the top-level handler writes
 * it as an `error` line carrying `exit` and no `thread`. */
type RookEvent =
  | { type: "run.started"; profile: { id: string; label: string }; new: boolean }
  | { type: "message"; role?: UIMessage["role"]; text: string; files?: string[] }
  | { type: "needs_human"; reason: string; tab: number; expiresAt: string }
  | { type: "error"; code: string; message?: string }
  | {
      type: "result";
      status: Status;
      exit: number;
      text: string;
      files: string[];
    }
  | ({ type: "execution"; exit: number } & WorkspaceExecutionResult);

function emit(thread: string, event: RookEvent): void {
  const line = { v: 1, ts: new Date().toISOString(), thread, ...event };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function dim(text: string): string {
  return process.stderr.isTTY && !process.env.NO_COLOR ? `\x1b[2m${text}\x1b[0m` : text;
}

type Status = "completed" | "failed" | "stopped" | "needs_human" | "running";
const STATUS_EXIT = {
  completed: EXIT.done,
  failed: EXIT.failed,
  needs_human: EXIT.needsHuman,
  stopped: EXIT.stopped,
  running: EXIT.running,
} satisfies Record<Status, number>;
/** What the conversation recorded for its latest turn or run. */
const OUTCOME = {
  completed: "completed",
  error: "failed",
  aborted: "stopped",
} as const satisfies Record<string, Status>;

type FollowOptions = {
  /** Only a status change at or after this counts as the outcome; 0 takes
   * the thread as it stands. */
  since: number;
  /** Prints the reply as it streams, to a terminal or as `message` lines. */
  stream: boolean;
  json: boolean;
  waitHuman: boolean;
  /** 0 waits until the thread settles. */
  timeoutMs: number;
};

type Outcome = {
  profile: Profile;
  threadId: string;
  status: Status;
  text: string;
  files: string[];
  /** Why it failed, or what the human must do. */
  detail?: string;
  /** The reply already reached the terminal as it streamed. */
  streamed: boolean;
};

let signalled: number | undefined;

function conversation(profile: Profile, threadId: string) {
  return dial<RookConversation, RookConversationState>(
    profile.id,
    CONVERSATION_AGENT_CLASS_NAME,
    threadId,
  );
}

type Conversation = ReturnType<typeof conversation>;

/** Runs `fn` on a thread's conversation once it answers, then hangs up. */
async function withConversation<T>(
  profile: Profile,
  threadId: string,
  fn: (chat: Conversation) => Promise<T>,
): Promise<T> {
  const chat = conversation(profile, threadId);
  try {
    await within(chat.ready, `thread ${threadId} did not answer`);
    return await fn(chat);
  } finally {
    chat.close();
  }
}

/** Calls `handle` with each chat frame a conversation sends. */
function onFrame(chat: Conversation, handle: (frame: OutgoingMessage) => void): void {
  chat.addEventListener("message", (event: MessageEvent) => {
    let frame: OutgoingMessage;
    try {
      // SAFETY: the conversation Agent's chat frames are the SDK's own
      // OutgoingMessage; frames of the Agent's other protocols share the
      // socket and fall through the caller's checks untouched.
      frame = JSON.parse(String(event.data)) as OutgoingMessage;
    } catch {
      return;
    }
    handle(frame);
  });
}

/** Exit 5: this profile's Rook predates what rook calls. */
function outdated(profile: Profile): Exit {
  return new Exit(
    EXIT.unavailable,
    `Rook in ${profile.label} is older than rook ${packageJson.version}: ask the user to update Rook (chrome://extensions, Update), then run this again`,
  );
}

/** Rethrows a failed call, as `outdated` when this Rook predates the callable. */
function rethrow(profile: Profile, error: unknown): never {
  throw /is not callable/u.test(String(error)) ? outdated(profile) : error;
}

/** Whether Rook took the message; false when `messageId` was already submitted. */
async function submitted(profile: Profile, threadId: string, messageId: string, text: string) {
  const taken = await profile.root.stub
    .submitMessage(threadId, messageId, text)
    .catch((error: unknown) => rethrow(profile, error));
  // An older Rook's submitMessage resolves nothing, which would read as a repeat.
  if (taken === undefined) throw outdated(profile);
  return taken;
}

/** How the thread's latest turn or run ended, or "running". */
async function turnOutcome(profile: Profile, chat: Conversation): Promise<Status> {
  type Recorded = Awaited<ReturnType<RookConversation["turnOutcome"]>>;
  const outcome: Recorded = await chat.stub
    .turnOutcome()
    .catch((error: unknown) => rethrow(profile, error));
  return outcome === "running" ? "running" : OUTCOME[outcome];
}

/** `--tab`, a tab id as `rook tools` prints it. */
function tabId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (/^\d+$/u.test(value)) return Number(value);
  throw new Exit(EXIT.usage, "--tab takes a tab id, as rook tools prints it");
}

/** The tools Rook's code reaches in this profile, on `tab` when one is given. */
async function tools(profile: Profile, tab: number | undefined): Promise<McpToolDescriptor[]> {
  const all = await profile.root.stub
    .listTools()
    .catch((error: unknown) => rethrow(profile, error));
  return tab === undefined ? all : all.filter((tool) => tool.tabId === tab);
}

/** Where a tool is, as the flags of `rook call` name it. */
function source(tool: McpToolDescriptor): string {
  return tool.tabId === undefined ? `server ${tool.serverId}` : `tab ${tool.tabId} ${tool.url}`;
}

/** `--args`: the JSON object a tool or script takes, `{}` when omitted. */
export function toolInput(args: string | undefined): McpToolInput {
  let json: unknown;
  try {
    json = args === undefined ? {} : JSON.parse(args);
  } catch (error) {
    throw new Exit(EXIT.usage, `--args is not JSON: ${String(error)}`);
  }
  const parsed = mcpToolInputSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  throw new Exit(EXIT.usage, "--args must be a JSON object");
}

/** The id of the run going on in a thread, whose record holds its status,
 * result and logs once it ends. */
function runningExecution(profile: Profile, threadId: string) {
  return withConversation(profile, threadId, async (chat) => {
    for (let tries = 0; !chat.state && tries < 25; tries++) await sleep(200);
    return chat.state?.executionTrace?.executionId;
  });
}

/** Watches a thread until it settles, blocks on a human, or times out. */
async function follow(
  profile: Profile,
  threadId: string,
  options: FollowOptions,
): Promise<Outcome> {
  const onSignal = (signal: NodeJS.Signals) => (signalled = signal === "SIGINT" ? 130 : 143);
  process.once("SIGINT", onSignal).once("SIGTERM", onSignal);
  const live = options.stream && !options.json && process.stdout.isTTY;
  const events = options.stream && options.json;
  const chat = conversation(profile, threadId);
  // Think broadcasts the persisted transcript before the turn's `done` frame
  // and reports the status to the root only after that, so the snapshot held
  // when the root says the thread settled is the final one.
  let messages: readonly UIMessage[] = [];
  // Think greets each connection with the transcript, or with a resume offer
  // while a turn streams. A settled thread is read only after that greeting.
  let greeted = () => {};
  const greeting = new Promise<void>((resolve) => (greeted = resolve));
  let failure: string | undefined;
  let streamed = false;
  let partText = "";
  const progress = (chunk: UIMessageChunk) => {
    switch (chunk.type) {
      case "text-delta":
        partText += chunk.delta;
        if (live) process.stdout.write(chunk.delta);
        streamed ||= live;
        break;
      case "text-end":
        if (live) process.stdout.write("\n");
        if (events && partText.trim()) emit(threadId, { type: "message", text: partText });
        partText = "";
        break;
      case "tool-input-available":
        if (live) process.stderr.write(dim(`· ${chunk.title ?? chunk.toolName}\n`));
    }
  };
  onFrame(chat, (frame) => {
    switch (frame.type) {
      case MessageType.CF_AGENT_CHAT_MESSAGES:
        messages = frame.messages;
        greeted();
        break;
      // Live chunks skip a connection until it acknowledges the resume; the
      // replay then starts the turn over from its first chunk.
      // ponytail: a reconnect mid-turn replays it, so a TTY may print it twice.
      case MessageType.CF_AGENT_STREAM_RESUMING:
        chat.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
            id: frame.id,
          } satisfies IncomingMessage),
        );
        greeted();
        break;
      case MessageType.CF_AGENT_USE_CHAT_RESPONSE:
        if (frame.error) failure = frame.body;
        else if (frame.body) {
          // SAFETY: a chat response body that is not an error is one
          // serialized AI SDK UIMessageChunk.
          progress(JSON.parse(frame.body) as UIMessageChunk);
        }
    }
  });
  await within(greeting, `thread ${threadId} did not answer`);

  // From launch, so starting serve and Chrome stays inside a caller's time limit.
  const deadline = options.timeoutMs ? performance.timeOrigin + options.timeoutMs : Infinity;
  let sawRunning = false;
  let status: Status | undefined;
  let detail: string | undefined;
  while (!status) {
    const state = directory(profile.root);
    const thread = state.threads.find(({ id }) => id === threadId);
    const wait = Object.values(state.browser.waits).find((entry) => entry.threadId === threadId);
    if (wait && !options.waitHuman) {
      status = "needs_human";
      detail = wait.reason;
      if (options.json) {
        emit(threadId, {
          type: "needs_human",
          reason: wait.reason,
          tab: wait.tabId,
          expiresAt: new Date(wait.expiresAt).toISOString(),
        });
      }
    } else if (
      thread &&
      thread.status !== "running" &&
      // A new thread sits idle until its turn starts.
      (thread.status === "idle"
        ? sawRunning || options.since === 0
        : thread.updatedAt >= options.since)
    ) {
      // The roster's status drops stop and error once the thread is viewed
      // or Rook restarts; the conversation's own record keeps them.
      const outcome = await turnOutcome(profile, chat);
      if (outcome !== "running") status = outcome;
    } else if (signalled || Date.now() >= deadline) {
      status = "running";
    }
    sawRunning ||= thread?.status === "running";
    if (!status) await sleep(200);
  }
  chat.close();

  const { text, files } = status === "completed" ? reply(messages) : { text: "", files: [] };
  if (status === "completed" && !text && !files.length) {
    status = "failed";
    detail = `Rook finished without a reply; read the thread: rook show ${threadId} --tools`;
  }
  if (status === "failed") detail ??= failure ?? "see the thread in Chrome";
  return {
    profile,
    threadId,
    status,
    text,
    files: saveFiles(threadId, files),
    detail,
    streamed,
  };
}

/** Prints an outcome as `ask` and `wait` do and returns its exit code. */
function report(outcome: Outcome, json: boolean) {
  const { threadId, status, text, files, detail } = outcome;
  const exit: number = status === "running" && signalled ? signalled : STATUS_EXIT[status];
  const problem = status === "failed" ? detail : undefined;
  if (json) {
    if (problem) emit(threadId, { type: "error", code: "run_failed", message: problem });
    emit(threadId, { type: "result", status, exit, text, files });
    return exit;
  }
  if (text && !outcome.streamed) process.stdout.write(`${text}\n`);
  for (const file of files) process.stdout.write(`file: ${file}\n`);
  if (problem) process.stderr.write(`failed: ${problem}\n`);
  if (status === "stopped") process.stderr.write("stopped\n");
  if (status === "needs_human") {
    process.stderr.write(
      `needs a human in ${outcome.profile.label}: ${detail}\ntell the user, then: rook wait ${threadId} --wait-human\n`,
    );
  }
  if (status === "running") {
    process.stderr.write(`still running: rook wait ${threadId}   stop: rook stop ${threadId}\n`);
  }
  return exit;
}

/** `rook show`: the thread as the side panel shows it. */
async function show(
  profile: Profile,
  threadId: string,
  options: { json: boolean; tools: boolean },
) {
  const chat = conversation(profile, threadId);
  const messages = await within(
    new Promise<readonly UIMessage[]>((resolve) =>
      onFrame(chat, (frame) => {
        if (frame.type === MessageType.CF_AGENT_CHAT_MESSAGES) resolve(frame.messages);
      }),
    ),
    `thread ${threadId} did not answer`,
  );
  chat.close();
  for (const message of messages) {
    const lines = message.parts.flatMap((part) =>
      isTextUIPart(part) && part.text.trim()
        ? [part.text.trim()]
        : options.tools && isToolUIPart(part)
          ? [`· ${getToolName(part)} ${part.state}`]
          : [],
    );
    const files = saveFiles(threadId, message.parts.filter(isFileUIPart));
    if (!lines.length && !files.length) continue;
    if (options.json) {
      emit(threadId, { type: "message", role: message.role, text: lines.join("\n\n"), files });
      continue;
    }
    process.stdout.write(`## ${message.role === "user" ? "you" : "rook"}\n\n`);
    for (const line of [...lines, ...files.map((file) => `file: ${file}`)]) {
      process.stdout.write(`${line}\n\n`);
    }
  }
  return EXIT.done;
}

/** Prints rows as JSON lines with --json, otherwise as `line` writes each. */
function printRows<T>(rows: readonly T[], json: boolean, line: (row: T) => string): void {
  process.stdout.write(rows.map((row) => `${json ? JSON.stringify(row) : line(row)}\n`).join(""));
}

/** The thread `--thread` names, or a new one (`--id`'s, if given) on the
 * profile `--profile` picks. The id is out before the run starts: a harness
 * that kills this process still has what `rook wait` needs. */
async function target(
  all: Profile[],
  flags: { profile?: string; thread?: string; id?: string; json: boolean },
) {
  const found = flags.thread
    ? locate(all, flags.profile, flags.thread)
    : { profile: pick(all, flags.profile), threadId: flags.id ?? randomUUID() };
  await adoptModel(found.profile, HOME);
  if (!flags.json) process.stderr.write(`thread ${found.threadId} on ${found.profile.label}\n`);
  return found;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "model") {
    return modelCommand(argv.slice(1), {
      home: HOME,
      token,
      // `rook model` sets profiles' models itself.
      profiles: async (wanted) => matching(await profiles(wanted), wanted),
    });
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      profile: { type: "string", default: process.env.ROOK_PROFILE },
      thread: { type: "string" },
      id: { type: "string" },
      args: { type: "string" },
      json: { type: "boolean", default: false },
      tools: { type: "boolean", default: false },
      detach: { type: "boolean", default: false },
      timeout: { type: "string" },
      tab: { type: "string" },
      server: { type: "string" },
      "wait-human": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.version) {
    process.stdout.write(`rook ${packageJson.version} (${packageJson.name})\n`);
    return EXIT.done;
  }
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? EXIT.done : EXIT.usage;
  }
  // An agent's shell gives up at two minutes (Claude Code's default), so a
  // caller without a terminal gets 124 and `rook wait ID` well before that.
  // `--timeout 0` waits as long as it takes.
  const timeoutMs = duration(values.timeout) ?? (process.stdout.isTTY ? 0 : AGENT_WAIT_MS);
  const watch = {
    json: values.json,
    waitHuman: values["wait-human"],
    timeoutMs,
  };

  switch (command) {
    case "serve": {
      const port = Number(RELAY.port || "80");
      const options = { port, token: token(), model: modelRelay(HOME) };
      const relay = await startLocalRelay(options).catch((error: NodeJS.ErrnoException) => {
        throw error.code === "EADDRINUSE"
          ? new Exit(EXIT.unavailable, `port ${port} is taken; is rook serve already running?`)
          : error;
      });
      process.stderr.write(
        `rook serve ${packageJson.version} listening on http://127.0.0.1:${relay.port}\n`,
      );
      return new Promise<number>(() => {});
    }
    case "skill": {
      if (rest[0] !== "print") throw new Exit(EXIT.usage, "usage: rook skill print");
      const skill = new URL("../skills/rook-browser/SKILL.md", import.meta.url);
      process.stdout.write(readFileSync(skill, "utf8"));
      return EXIT.done;
    }
    case "ls": {
      const rows = matching(await profiles(values.profile), values.profile).map(
        ({ id, label, root }) => ({
          id,
          label,
          running: directory(root).threads.filter(({ status }) => status === "running").length,
        }),
      );
      printRows(rows, values.json, (row) => `${row.label}\t${row.id}\t${row.running} running`);
      return EXIT.done;
    }
    case "ps": {
      const all = await profiles(values.profile);
      const shown = values.profile ? [pick(all, values.profile)] : all;
      const rows = shown.flatMap(({ label, root }) => {
        const state = directory(root);
        const waiting = new Set(Object.values(state.browser.waits).map((wait) => wait.threadId));
        return state.threads.map((thread) => ({
          profile: label,
          id: thread.id,
          status: waiting.has(thread.id) ? "needs_human" : thread.status,
          updatedAt: new Date(thread.updatedAt).toISOString(),
          title: thread.title,
        }));
      });
      rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      printRows(
        rows,
        values.json,
        (row) => `${row.id}\t${row.status}\t${row.profile}\t${row.title}`,
      );
      return EXIT.done;
    }
    case "ask": {
      const given = rest.join(" ");
      const typed =
        given && given !== "-"
          ? given
          : process.stdin.isTTY
            ? ""
            : (await readStream(process.stdin)).trim();
      if (!typed) {
        throw new Exit(EXIT.usage, "usage: rook ask PROMPT (or pipe the prompt on stdin)");
      }
      const { profile, threadId } = await target(await profiles(values.profile), values);
      // A repeated --id was already submitted; report the thread as it is.
      const since = Date.now();
      const repeat = values.thread
        ? !(await submitted(profile, threadId, values.id ?? randomUUID(), typed))
        : directory(profile.root).threads.some(({ id }) => id === threadId);
      if (!values.thread && !repeat) {
        await profile.root.stub.startThread(threadId, { text: typed, files: [] });
      }
      if (values.json) {
        emit(threadId, {
          type: "run.started",
          profile: { id: profile.id, label: profile.label },
          new: !values.thread && !repeat,
        });
      }
      if (values.detach) {
        if (!values.json) process.stdout.write(`${threadId}\n`);
        return EXIT.done;
      }
      const outcome = await follow(profile, threadId, {
        ...watch,
        since: repeat ? 0 : since,
        stream: true,
      });
      return report(outcome, values.json);
    }
    case "wait": {
      if (!rest[0]) throw new Exit(EXIT.usage, "usage: rook wait ID");
      const { profile, threadId } = locate(await profiles(values.profile), values.profile, rest[0]);
      const outcome = await follow(profile, threadId, { ...watch, since: 0, stream: false });
      return report(outcome, values.json);
    }
    case "show": {
      if (!rest[0]) throw new Exit(EXIT.usage, "usage: rook show ID");
      const { profile, threadId } = locate(await profiles(values.profile), values.profile, rest[0]);
      return show(profile, threadId, { json: values.json, tools: values.tools });
    }
    case "stop": {
      if (!rest[0]) throw new Exit(EXIT.usage, "usage: rook stop ID");
      const { profile, threadId } = locate(await profiles(values.profile), values.profile, rest[0]);
      // Resolves once the turn and its scripts have stopped.
      await withConversation(profile, threadId, (chat) => chat.stub.stopCurrentWork());
      return EXIT.done;
    }
    case "bash": {
      const script = rest.join(" ");
      if (!script) throw new Exit(EXIT.usage, "usage: rook bash SCRIPT");
      const profile = await selectProfile(await profiles(values.profile), values.profile);
      // A shell pipe or a redirected file feeds the script. A terminal,
      // /dev/null or a socket feeds nothing, because Node-based harnesses can
      // hand their commands a socket they hold open.
      // ponytail: so a Node caller's `input` goes unread; it pipes through a
      // shell or a file until a flag earns its keep. A harness holding a pipe
      // open makes this wait for EOF; `< /dev/null` gets out.
      const stdin = fstatSync(0);
      const input = stdin.isFIFO() || stdin.isFile() ? await readStream(process.stdin) : "";
      const { stdout, stderr, exitCode } = await profile.root.stub
        .runBash(script, input)
        .catch((error: unknown) => rethrow(profile, error));
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      return exitCode;
    }
    case "run": {
      if (!rest[0]) throw new Exit(EXIT.usage, "usage: rook run PATH [--args JSON]");
      if (values.id) throw new Exit(EXIT.usage, "--id is for rook ask; a script runs each time");
      const args = toolInput(values.args);
      const { profile, threadId } = await target(await profiles(values.profile), values);
      // The side panel's Run button: the script runs in Chrome, so giving up
      // here, on --timeout or Ctrl-C, leaves it running.
      // Rook checks the path, as for the Run button, before minting a thread.
      const run = profile.root.call("runAutomation", [threadId, rest[0], args], { timeout: 0 });
      // A script's return value reaches only the caller waiting on it, so
      // only an explicit --timeout gives up on one.
      const runTimeoutMs = duration(values.timeout);
      let execution: WorkspaceExecutionResult;
      try {
        execution = await (!runTimeoutMs
          ? run
          : Promise.race([
              run,
              sleep(runTimeoutMs).then(async () => {
                const id = await runningExecution(profile, threadId).catch(() => undefined);
                const record = id
                  ? `; when it ends, its result is in ${executionTraceFile(id)}: rook bash 'cat ${executionTraceFile(id)}'`
                  : "";
                throw new Exit(
                  EXIT.running,
                  `still running in ${profile.label}, thread ${threadId}${record}; stop: rook stop ${threadId}`,
                );
              }),
            ]));
      } catch (error) {
        if (error instanceof Exit) throw error;
        // A stopped script rejects like a failed one; the conversation knows which.
        const outcome = await withConversation(profile, threadId, (chat) =>
          turnOutcome(profile, chat),
        ).catch(() => "failed" as const);
        throw new Exit(
          outcome === "stopped" ? EXIT.stopped : EXIT.failed,
          error instanceof Error ? error.message : String(error),
        );
      }
      if (values.json) {
        emit(threadId, { type: "execution", exit: EXIT.done, ...execution });
        return EXIT.done;
      }
      process.stderr.write(`execution ${execution.executionId}\n`);
      for (const line of execution.logs) process.stderr.write(`${line}\n`);
      for (const file of execution.files) process.stderr.write(`${file.label}: ${file.path}\n`);
      if (execution.result !== undefined) {
        process.stdout.write(`${JSON.stringify(execution.result)}\n`);
      }
      return EXIT.done;
    }
    case "tools": {
      const tab = tabId(values.tab);
      const profile = await selectProfile(await profiles(values.profile), values.profile);
      printRows(await tools(profile, tab), values.json, (tool) => {
        const about = tool.description?.replace(/\s+/gu, " ").trim() ?? "";
        return `${tool.name}\t${source(tool)}\t${about}`;
      });
      return EXIT.done;
    }
    case "call": {
      const [name] = rest;
      if (!name) throw new Exit(EXIT.usage, "usage: rook call NAME [--tab N] [--server S]");
      const input = toolInput(values.args);
      const tab = tabId(values.tab);
      const profile = await selectProfile(await profiles(values.profile), values.profile);
      const found = (await tools(profile, tab)).filter(
        (tool) =>
          tool.name === name && (values.server === undefined || tool.serverId === values.server),
      );
      const [only] = found;
      if (!only || found.length > 1) {
        throw new Exit(
          EXIT.usage,
          only
            ? `${name} is on ${found.map(source).join(", ")}: pass --tab N or --server S`
            : `no tool ${name} here; rook tools lists them`,
        );
      }
      const result = await profile.root.stub
        .callTool(only.serverId, name, input)
        .catch((error: unknown) => rethrow(profile, error));
      if (values.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return result.isError ? EXIT.failed : EXIT.done;
      }
      const { text, files } = toolReply(result);
      if (result.isError) throw new Exit(EXIT.failed, text || `${name} failed`);
      if (text) process.stdout.write(`${text}\n`);
      for (const file of saveFiles(randomUUID(), files)) process.stdout.write(`file: ${file}\n`);
      return EXIT.done;
    }
    default:
      throw new Exit(EXIT.usage, `unknown command ${command}\n\n${USAGE}`);
  }
}

if (import.meta.main) {
  const json = process.argv.includes("--json");
  void main(process.argv.slice(2))
    .catch((error: unknown) => {
      const usage =
        error instanceof UsageError ||
        (error instanceof Error &&
          "code" in error &&
          String(error.code).startsWith("ERR_PARSE_ARGS"));
      const code = error instanceof Exit ? error.code : usage ? EXIT.usage : EXIT.failed;
      const message = error instanceof Error ? error.message : String(error);
      const line = { v: 1, ts: new Date().toISOString(), type: "error", exit: code, message };
      if (json) process.stdout.write(`${JSON.stringify(line)}\n`);
      else process.stderr.write(`rook: ${message}\n`);
      return code;
    })
    // Pipes flush asynchronously; exit only once both streams have drained.
    .then((code) =>
      process.stderr.write("", () => process.stdout.write("", () => process.exit(code))),
    );
}
