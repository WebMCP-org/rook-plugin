// `rook serve`'s model relay (ADR 0082). A profile's openai-compatible source
// points at /<upstream>/v1 on serve, and each call goes on to the upstream of
// that name in ~/.rook/model.json, read per call so `rook model` needs no
// restart: ChatGPT through this machine's Codex sign-in, any URL with the
// headers it needs. Calls go on as the extension made them. The benchmarks run
// the codex upstream alone (scripts/responses-relay.ts), so this module loads
// under plain `node`.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { createOpenAIOAuthTransport } from "@openai-oauth/core";
import { openaiCredentials } from "@openai-oauth/local";
import { z } from "zod";
import { connectNodeWebSocket, responsesOverWebSocket } from "./wire/responses-socket.ts";

/** serve's upstreams and what `rook model` chose, in ROOK_HOME. */
export const MODEL_FILE = "model.json";

/** A header an upstream needs: a value, an environment variable of serve's, or a command's output. */
const headerSourceSchema = z.union([
  z.strictObject({ name: z.string().min(1), value: z.string() }),
  z.strictObject({
    name: z.string().min(1),
    env: z.string().min(1),
    prefix: z.string().optional(),
    // Codex's env_http_headers: sent only when the variable is set.
    optional: z.boolean().optional(),
  }),
  z.strictObject({
    name: z.string().min(1),
    command: z.string().min(1),
    prefix: z.string().optional(),
    /** Milliseconds before the command runs again; it always does after a 401. */
    ttl: z.number().positive().optional(),
  }),
]);

export type HeaderSource = z.infer<typeof headerSourceSchema>;

const upstreamSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("codex"), transport: z.enum(["ws", "http"]) }),
  z.strictObject({
    kind: z.literal("url"),
    // The URL that ends in /v1.
    baseUrl: z.url(),
    api: z.enum(["responses", "chat"]),
    transport: z.enum(["http", "ws"]),
    headers: z.array(headerSourceSchema),
    query: z.record(z.string(), z.string()),
  }),
]);

export type Upstream = z.infer<typeof upstreamSchema>;
type UrlUpstream = Extract<Upstream, { kind: "url" }>;

const choiceSchema = z.strictObject({
  upstream: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1).optional(),
});

/** A profile's model on serve: an upstream, a model, and an effort. */
export type Choice = z.infer<typeof choiceSchema>;

export const modelConfigSchema = z.strictObject({
  version: z.literal(1),
  upstreams: z.record(z.string(), upstreamSchema),
  // What a profile with no model gets when rook reaches it: null after
  // `rook model off`, unset until rook finds one in Codex's configuration.
  default: choiceSchema.nullable().optional(),
  // Profiles `rook model off` took off serve, which rook leaves without one.
  off: z.array(z.string()),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;

export function readConfig(home: string): ModelConfig {
  const file = join(home, MODEL_FILE);
  if (!existsSync(file)) return { version: 1, upstreams: {}, off: [] };
  return modelConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Answers one call; `path` is below what the caller mounted, query included. */
export type ModelEndpoint = (
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
) => Promise<void>;

type Log = (line: string) => void;

const FORWARDED_HEADERS = ["content-type", "session-id"];

// ── Calls ──────────────────────────────────────────────────────────────────

type Call = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string | undefined;
  signal: AbortSignal;
};

function answer(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { type: "rook_serve_error", message } }));
}

/** Runs `forward` for each call; a call it cannot make is answered with why. */
function endpoint(forward: (call: Call, response: ServerResponse) => Promise<void>, log: Log) {
  const serve: ModelEndpoint = async (request, response, path) => {
    // A client that gives up on a call cancels it upstream too.
    const disconnected = new AbortController();
    response.on("close", () => disconnected.abort());
    try {
      const body =
        request.method === "POST"
          ? Buffer.concat(await Array.fromAsync(request)).toString()
          : undefined;
      const call = {
        method: request.method ?? "GET",
        path,
        headers: request.headers,
        body,
        signal: disconnected.signal,
      };
      await forward(call, response);
    } catch (error) {
      if (disconnected.signal.aborted) return;
      log(String(error));
      // A stream that fails after its headers went out can only be cut off.
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const refused = error instanceof SyntaxError || error instanceof z.ZodError;
      answer(response, refused ? 400 : 502, error instanceof Error ? error.message : String(error));
    }
  };
  return serve;
}

function forwardedHeaders(headers: IncomingHttpHeaders): Headers {
  const forwarded = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = headers[name];
    if (value) forwarded.set(name, String(value));
  }
  return forwarded;
}

async function pipe(reply: Response, response: ServerResponse): Promise<void> {
  const headers = new Headers(reply.headers);
  // fetch decoded the body, which goes on with this server's own framing.
  for (const name of ["content-encoding", "content-length", "transfer-encoding"]) {
    headers.delete(name);
  }
  response.writeHead(reply.status, Object.fromEntries(headers));
  if (reply.body) for await (const chunk of reply.body) response.write(chunk);
  response.end();
}

// ── Headers ────────────────────────────────────────────────────────────────

const run = promisify(execFile);
// ponytail: one value per command for the whole process, rerun after its ttl or a 401.
const commandOutputs = new Map<string, { value: string; at: number }>();

async function commandOutput(
  source: Extract<HeaderSource, { command: string }>,
  refresh: boolean,
): Promise<string> {
  const cached = commandOutputs.get(source.command);
  const fresh = cached && (source.ttl === undefined || Date.now() - cached.at < source.ttl);
  if (cached && fresh && !refresh) return cached.value;
  const { stdout } = await run("/bin/sh", ["-c", source.command], { timeout: 30_000 });
  const value = stdout.trim();
  commandOutputs.set(source.command, { value, at: Date.now() });
  return value;
}

async function addHeaders(
  headers: Headers,
  sources: readonly HeaderSource[],
  refresh: boolean,
): Promise<void> {
  for (const source of sources) {
    if ("value" in source) {
      headers.set(source.name, source.value);
    } else if ("env" in source) {
      const value = process.env[source.env];
      if (value === undefined) {
        if (source.optional) continue;
        throw new Error(
          `rook serve has no ${source.env} in its environment for the ${source.name} header: export it, stop rook serve, and run rook again`,
        );
      }
      headers.set(source.name, `${source.prefix ?? ""}${value}`);
    } else {
      headers.set(source.name, `${source.prefix ?? ""}${await commandOutput(source, refresh)}`);
    }
  }
}

// ── Responses and chat ─────────────────────────────────────────────────────

function codexEndpoint(transport: "ws" | "http", log: Log): ModelEndpoint {
  const credentials = openaiCredentials();
  const oauth = createOpenAIOAuthTransport({
    auth: () => credentials.getSession(),
    fetch: transport === "ws" ? responsesOverWebSocket(connectNodeWebSocket, log)(fetch) : fetch,
    responsesState: false,
  });
  return endpoint(async (call, response) => {
    const reply = await oauth.request(`/v1${call.path}`, {
      method: call.method,
      headers: forwardedHeaders(call.headers),
      body: call.body,
      signal: call.signal,
    });
    await pipe(reply, response);
  }, log);
}

function urlEndpoint(upstream: UrlUpstream, log: Log): ModelEndpoint {
  const send =
    upstream.transport === "ws" ? responsesOverWebSocket(connectNodeWebSocket, log)(fetch) : fetch;
  // A header from a command is fetched again after a 401.
  const refreshes = upstream.headers.some((source) => "command" in source);
  return endpoint(async (call, response) => {
    const url = new URL(`${upstream.baseUrl.replace(/\/$/, "")}${call.path}`);
    for (const [name, value] of Object.entries(upstream.query)) url.searchParams.set(name, value);
    const attempt = async (refresh: boolean) => {
      const headers = forwardedHeaders(call.headers);
      await addHeaders(headers, upstream.headers, refresh);
      return send(url, { method: call.method, headers, body: call.body, signal: call.signal });
    };
    let reply = await attempt(false);
    if (reply.status === 401 && refreshes) {
      await reply.body?.cancel();
      reply = await attempt(true);
    }
    await pipe(reply, response);
  }, log);
}

// ── serve ──────────────────────────────────────────────────────────────────

/** Calls to one upstream; `path` is below its /v1, such as /responses. */
export function upstreamEndpoint(upstream: Upstream, log: Log): ModelEndpoint {
  if (upstream.kind === "codex") return codexEndpoint(upstream.transport, log);
  return urlEndpoint(upstream, log);
}

function readUpstream(home: string, name: string): Upstream | undefined {
  const { upstreams } = readConfig(home);
  return Object.hasOwn(upstreams, name) ? upstreams[name] : undefined;
}

/** serve's model calls: /<upstream>/v1/..., to the upstream of that name in ROOK_HOME's model.json. */
export function modelRelay(
  home: string,
  log: Log = (line) => console.log(`[model] ${line}`),
): ModelEndpoint {
  // An upstream keeps its endpoint, and so its sockets, until its settings change.
  // ponytail: a replaced upstream's endpoint stays until serve exits.
  const endpoints = new Map<string, ModelEndpoint>();
  return async (request, response, path) => {
    const { pathname, search } = new URL(path, "http://127.0.0.1");
    const [, name = "", version, ...rest] = pathname.split("/");
    let upstream: Upstream | undefined;
    try {
      upstream = version === "v1" ? readUpstream(home, name) : undefined;
    } catch (error) {
      answer(response, 500, `${join(home, MODEL_FILE)}: ${String(error)}`);
      return;
    }
    if (!upstream) {
      answer(response, 404, `rook serve has no model upstream at /${name}/v1: run rook model`);
      return;
    }
    const key = JSON.stringify(upstream);
    let forward = endpoints.get(key);
    if (!forward) {
      forward = upstreamEndpoint(upstream, log);
      endpoints.set(key, forward);
    }
    await forward(request, response, `/${rest.join("/")}${search}`);
  };
}
