// `rook serve`: the companion relay on loopback (ADR 0082). Chrome profiles
// that turned on local agents dial it as hosts; the rook CLI dials it as the
// web client. The relay actor and wire contract are the hosted relay's. Only
// admission differs: an exact Rook extension origin for hosts, the token file
// for the CLI, and a loopback Host for both. The CLI's plain routes are the
// host list, leases (ADR 0092) and a candidate model's test request; every
// other plain request is a model call, admitted the same way and answered by
// the model relay.
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  STATUS_CODES,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import type { Duplex } from "node:stream";
import { Clock, Effect, FiberSet, Layer, Tracer } from "effect";
import { HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import {
  RelayActor,
  type AcceptSocket,
  type RelaySocket,
  type RelaySocketHost,
  type RelayUpgrade,
  type SocketAttachment,
} from "./wire/relay-actor";
import {
  CONTROL_PATH,
  CONTROL_PING,
  CONTROL_PONG,
  CONTROL_SUBPROTOCOL,
  decodeLocalHostProtocol,
  decodeTunnelIdProtocol,
  parseCompanionSeatAgentPath,
  parseSubprotocolHeader,
  TUNNEL_CONNECT_TIMEOUT_MS,
  TUNNEL_PATH,
  TUNNEL_SUBPROTOCOL,
} from "./wire/relay";
import packageJson from "../package.json" with { type: "json" };
import { ROOK_EXTENSION_IDS } from "./wire/contracts";
import { forwardModelCall, ModelRelay, modelError, relayModelCall } from "./relay";
import { ModelSettings, upstreamSchema } from "./model-settings";
import { CommandError } from "./command";

/** Lists the host ids with a live control socket. */
export const HOSTS_PATH = "/hosts";
/** `POST /leases/<name>?ms=<n>` grants `{ id }` or answers 409 while another
 * holds it; `DELETE /leases/<name>?id=<id>` releases it. The daemon is the one
 * elected process, so it arbitrates what concurrent CLIs must do only once. */
export const LEASES_PATH = "/leases/";
/** A lease outlives a holder that died by at most this long. */
const LEASE_MAX_MS = 60_000;
/** `POST /model-test` with `{ upstream, path, body }` sends that one request to
 * a candidate upstream that no model.json names yet, from serve's environment
 * and through the transport its model calls use, and streams the answer back. */
export const MODEL_TEST_PATH = "/model-test";
/** Names the answering serve: `<version> <pid> <startedAtMs>`. */
export const SERVE_HEADER = "rook-serve";

const EXTENSION_ORIGINS = new Set(
  Object.values(ROOK_EXTENSION_IDS).map((id) => `chrome-extension://${id}`),
);

type Refusal = { ok: false; status: number; reason: string };
type Admission = { ok: true; subject: string; upgrade: RelayUpgrade; protocol?: string } | Refusal;

function refuse(status: number, reason: string): Refusal {
  return { ok: false, status, reason };
}

// A page on a rebinding name that resolves to 127.0.0.1 still names itself here.
function loopbackHost(headers: IncomingHttpHeaders, port: number): boolean {
  return (
    headers.host === `127.0.0.1:${port}` ||
    headers.host === `localhost:${port}` ||
    (port === 80 && (headers.host === "127.0.0.1" || headers.host === "localhost"))
  );
}

/** The CLI: no browser Origin, and the token from the token file. */
function admitCli(headers: IncomingHttpHeaders, port: number, token: string): Refusal | null {
  if (!loopbackHost(headers, port)) return refuse(403, "Host is not loopback");
  // Every browser request carries Origin and the CLI sends none, so no page
  // reaches the token check even if it somehow held the token.
  if (headers.origin !== undefined) return refuse(403, "browsers cannot use the local relay");
  const offered = Buffer.from(headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
    return refuse(401, "missing or wrong token");
  }
  return null;
}

/** Rook's model calls: a Rook extension on loopback, or the CLI. */
export function admitModel(
  headers: IncomingHttpHeaders,
  port: number,
  token: string,
): Refusal | null {
  if (!EXTENSION_ORIGINS.has(headers.origin ?? "")) return admitCli(headers, port, token);
  return loopbackHost(headers, port) ? null : refuse(403, "Host is not loopback");
}

/** Who may make this upgrade, and as what. */
export function admitUpgrade(
  target: string,
  headers: IncomingHttpHeaders,
  port: number,
  token: string,
): Admission {
  const parsed = URL.parse(target, "http://127.0.0.1");
  if (!parsed) return refuse(400, "invalid request target");
  const { pathname, search } = parsed;
  if (pathname === CONTROL_PATH || pathname === TUNNEL_PATH) {
    if (!loopbackHost(headers, port)) return refuse(403, "Host is not loopback");
    // Chrome sets Origin on extension sockets and pages cannot forge it; a
    // local process can, which is why driving a profile takes the token.
    if (!EXTENSION_ORIGINS.has(headers.origin ?? "")) return refuse(403, "not a Rook extension");
    const offered = parseSubprotocolHeader(headers["sec-websocket-protocol"] ?? null);
    const protocol = pathname === CONTROL_PATH ? CONTROL_SUBPROTOCOL : TUNNEL_SUBPROTOCOL;
    const subject = decodeLocalHostProtocol(offered);
    if (!offered.includes(protocol) || !subject)
      return refuse(400, "missing subprotocol or host id");
    if (pathname === CONTROL_PATH)
      return { ok: true, subject, upgrade: { role: "control" }, protocol };
    const tunnelId = decodeTunnelIdProtocol(offered);
    if (!tunnelId) return refuse(400, "missing tunnel id");
    return { ok: true, subject, upgrade: { role: "tunnel", tunnelId }, protocol };
  }
  const refusal = admitCli(headers, port, token);
  if (refusal) return refusal;
  const route = parseCompanionSeatAgentPath(pathname);
  if (!route) return refuse(404, "not found");
  return {
    ok: true,
    subject: route.subject,
    upgrade: { role: "web", url: route.agentPath + search },
  };
}

type Entry = { tags: readonly string[]; attachment: SocketAttachment; lastPongAt?: number };

/** One profile's relay actor, its sockets held in memory. */
class LocalSubject implements RelaySocketHost<RelaySocket> {
  private readonly entries = new Map<RelaySocket, Entry>();
  private pendingUpgrades = 0;
  readonly actor = new RelayActor<RelaySocket, null>(this, TUNNEL_CONNECT_TIMEOUT_MS);

  constructor(private readonly onEmpty: () => void) {}

  sockets(tag?: string): RelaySocket[] {
    return [...this.entries]
      .filter(([, entry]) => tag === undefined || entry.tags.includes(tag))
      .map(([socket]) => socket);
  }

  attachment(socket: RelaySocket): SocketAttachment | null {
    return this.entries.get(socket)?.attachment ?? null;
  }

  lastPongAt(socket: RelaySocket): number | undefined {
    return this.entries.get(socket)?.lastPongAt;
  }

  /** Pending web upgrades still own the actor after its last socket closes. */
  async upgrade(upgrade: RelayUpgrade, accept: AcceptSocket<RelaySocket, null>) {
    this.pendingUpgrades++;
    try {
      return await this.actor.upgrade(upgrade, accept);
    } finally {
      this.pendingUpgrades--;
      if (this.entries.size === 0 && this.pendingUpgrades === 0) this.onEmpty();
    }
  }

  /** Completes the handshake of the one upgrade being answered. */
  acceptor(
    server: WebSocketServer,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): AcceptSocket<RelaySocket, null> {
    return (tags, attachment) => {
      let accepted: WebSocket | undefined;
      // Synchronous unless the client already left, which never calls back.
      server.handleUpgrade(request, socket, head, (ws) => {
        accepted = ws;
      });
      if (!accepted) {
        // A web client that left while its upgrade waited for a tunnel.
        const closed: RelaySocket = { readyState: 3, send() {}, close() {} };
        this.entries.set(closed, { tags, attachment });
        queueMicrotask(() => this.closed(closed, 1006, ""));
        return { socket: closed, accepted: null };
      }
      const ws = accepted;
      const entry: Entry = { tags, attachment };
      this.entries.set(ws, entry);
      ws.binaryType = "arraybuffer";
      ws.on("message", (data) => {
        // ws hands text over as a Buffer whatever binaryType says.
        const message =
          data instanceof ArrayBuffer ? data : Buffer.isBuffer(data) ? data.toString() : undefined;
        if (message === undefined) return;
        // What Cloudflare's WebSocket auto-response does for the hosted relay.
        if (message === CONTROL_PING) {
          entry.lastPongAt = Date.now();
          ws.send(CONTROL_PONG);
          return;
        }
        this.actor.message(ws, message);
      });
      ws.on("close", (code, reason) => this.closed(ws, code, reason.toString()));
      ws.on("error", () => this.actor.error(ws));
      return { socket: ws, accepted: null };
    };
  }

  private closed(socket: RelaySocket, code: number, reason: string): void {
    this.actor.close(socket, code, reason);
    this.entries.delete(socket);
    if (this.entries.size === 0 && this.pendingUpgrades === 0) this.onEmpty();
  }
}

/** A model call to `/<upstream>/v1/…`, routed by the upstreams in model.json. */
const modelResponse = Effect.fnUntraced(
  function* (request: HttpServerRequest.HttpServerRequest) {
    const parsed = URL.parse(request.url, "http://127.0.0.1");
    if (!parsed) return HttpServerResponse.text("invalid request target", { status: 400 });
    const [, name = "", version, ...rest] = parsed.pathname.split("/");
    const settings = yield* ModelSettings;
    const { upstreams } = yield* settings.read;
    const upstream =
      version === "v1" && Object.hasOwn(upstreams, name) ? upstreams[name] : undefined;
    if (!upstream)
      return modelError(404, `rook serve has no model upstream at /${name}/v1: run rook model`);
    return yield* forwardModelCall(request, upstream, `/${rest.join("/")}${parsed.search}`);
  },
  Effect.catchTag("SettingsError", (error) => Effect.succeed(modelError(500, error.message))),
);

const modelTestSchema = z.strictObject({
  upstream: upstreamSchema,
  path: z.enum(["/responses", "/chat/completions"]),
  body: z.json(),
});

/** A candidate's test request, which stays private to the CLI that sent it. */
const modelTestResponse = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const parsed = modelTestSchema.safeParse(
    yield* request.json.pipe(Effect.orElseSucceed(() => null)),
  );
  if (!parsed.success) return modelError(400, `invalid model test: ${parsed.error.message}`);
  const { upstream, path, body } = parsed.data;
  // The request's own headers carry its session-id; the relay keeps only those it forwards.
  const call = HttpClientRequest.post(path, { headers: request.headers }).pipe(
    HttpClientRequest.bodyJsonUnsafe(body),
  );
  return yield* relayModelCall(call, upstream);
});

/** Platform HTTP owns request fibers; the concrete ws adapter owns actor upgrades. */
export const scopedLocalRelay = Effect.fnUntraced(
  function* (options: { port: number; token: string }) {
    const { token } = options;
    let port = options.port;
    // Fixed before the bind, so the first request already carries it.
    const identity = `${packageJson.version} ${process.pid} ${yield* Clock.currentTimeMillis}`;
    const subjects = new Map<string, LocalSubject>();
    const selectedProtocol = new WeakMap<IncomingMessage, string>();
    const sockets = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      handleProtocols: (_offered, request) => selectedProtocol.get(request) ?? false,
    });
    const upgraded = new Set<Duplex>();
    const scope = yield* Effect.scope;
    // Model transport lives as long as the daemon, never in a CLI command.
    const relay = yield* Layer.build(ModelRelay.layer);
    // A daemon restart forgets every lease, which only lets a CLI repeat once.
    const leases = new Map<string, { id: string; expires: number }>();
    const lease = Effect.fnUntraced(function* (method: string, name: string, query: URLSearchParams) {
      const held = leases.get(name);
      if (method === "DELETE") {
        if (held && held.id === query.get("id")) leases.delete(name);
        return HttpServerResponse.empty({ status: 204 });
      }
      const now = yield* Clock.currentTimeMillis;
      if (held && held.expires > now) return HttpServerResponse.text("held", { status: 409 });
      const ms = Number(query.get("ms"));
      if (!(ms > 0)) return HttpServerResponse.text("ms must be positive", { status: 400 });
      const id = randomUUID();
      leases.set(name, { id, expires: now + Math.min(ms, LEASE_MAX_MS) });
      return HttpServerResponse.jsonUnsafe({ id });
    });
    const app = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const target = URL.parse(request.url, "http://127.0.0.1");
      // One encoded path segment: a model upstream named "leases" has /v1/… after it.
      const leased = target?.pathname.startsWith(LEASES_PATH)
        ? /^[^/]+$/u.exec(target.pathname.slice(LEASES_PATH.length))?.[0]
        : undefined;
      const cliRoute = leased
        ? ["POST", "DELETE"]
        : request.url === HOSTS_PATH
          ? ["GET"]
          : request.url === MODEL_TEST_PATH
            ? ["POST"]
            : undefined;
      const refusal = !cliRoute
        ? admitModel(request.headers, port, token)
        : cliRoute.includes(request.method)
          ? admitCli(request.headers, port, token)
          : refuse(404, "not found");
      if (refusal) return HttpServerResponse.text(refusal.reason, { status: refusal.status });
      if (leased && target) return yield* lease(request.method, leased, target.searchParams);
      if (request.url === MODEL_TEST_PATH) return yield* modelTestResponse(request);
      if (request.url !== HOSTS_PATH) return yield* modelResponse(request);
      return HttpServerResponse.jsonUnsafe(
        [...subjects].filter(([, subject]) => subject.actor.online()).map(([id]) => ({ id })),
        { headers: { [SERVE_HEADER]: identity } },
      );
    });
    // The platform masks its response writer; application work must remain interruptible.
    const handler = yield* NodeHttpServer.makeHandler(
      app.pipe(Effect.provideContext(relay), Effect.interruptible),
      { scope },
    );
    const server = createServer(handler);
    const bound = yield* NodeHttpServer.make(() => server, {
      port: options.port,
      host: "127.0.0.1",
      disablePreemptiveShutdown: true,
    }).pipe(
      // Losing the port is how a racing daemon learns another one was elected.
      Effect.mapError((error) =>
        error.cause instanceof Error && "code" in error.cause && error.cause.code === "EADDRINUSE"
          ? CommandError.unavailable(`port ${options.port} is already taken`, error.cause)
          : error,
      ),
    );
    // The server is explicitly TCP; its platform address carries the bound port.
    if (bound.address._tag === "UnixPathAddress")
      return yield* Effect.die("local relay bound a Unix socket");
    port = bound.address.port;
    const runUpgrade = yield* FiberSet.makeRuntime<never, void, never>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const subject of subjects.values()) subject.actor.dispose();
        for (const socket of upgraded) socket.destroy();
        sockets.close();
        server.closeAllConnections();
      }),
    );
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      upgraded.add(socket);
      socket.on("close", () => upgraded.delete(socket));
      socket.on("error", () => socket.destroy());
      const admission = admitUpgrade(request.url ?? "/", request.headers, port, token);
      if (!admission.ok) return writeRefusal(socket, admission.status, admission.reason);
      if (admission.protocol) selectedProtocol.set(request, admission.protocol);
      let subject = subjects.get(admission.subject);
      if (!subject) {
        const created = new LocalSubject(() => {
          if (subjects.get(admission.subject) === created) subjects.delete(admission.subject);
        });
        subjects.set(admission.subject, created);
        subject = created;
      }
      const owner = subject;
      runUpgrade(
        Effect.gen(function* () {
          const answer = yield* Effect.tryPromise(() =>
            owner.upgrade(admission.upgrade, owner.acceptor(sockets, request, socket, head)),
          );
          if (!answer) return;
          const reason = yield* Effect.tryPromise(() => answer.text());
          writeRefusal(socket, answer.status, reason);
        }).pipe(
          Effect.catch(() => Effect.sync(() => writeRefusal(socket, 500, "relay upgrade failed"))),
        ),
      );
    });
    return { port };
  },
  // The relay is not a traced operation: it records no spans, and the model
  // calls it forwards carry only the caller's headers. A disabled tracer alone
  // still writes a "noop" traceparent; DisablePropagation removes the headers.
  Effect.withTracerEnabled(false),
  Effect.provideService(Tracer.DisablePropagation, true),
);

/** A refused upgrade is answered on the raw socket, which then closes. */
function writeRefusal(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  const body = Buffer.from(reason);
  socket.end(
    Buffer.concat([
      Buffer.from(
        `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\ncontent-length: ${body.byteLength}\r\nconnection: close\r\n\r\n`,
      ),
      body,
    ]),
  );
}
