// `rook serve`: the companion relay on loopback (ADR 0082). Chrome profiles
// that turned on local agents dial it as hosts; the rook CLI dials it as the
// web client. The relay actor and wire contract are the hosted relay's. Only
// admission differs: an exact Rook extension origin for hosts, the token file
// for the CLI, and a loopback Host for both. Every other plain request is a
// model call, admitted the same way and answered by the model relay.
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  STATUS_CODES,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
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
import type { ModelEndpoint } from "./relay";

/** Lists the host ids with a live control socket; the CLI's only plain route. */
export const HOSTS_PATH = "/hosts";
/** Names the answering serve: `<version> <pid>`. */
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
  const { pathname, search } = new URL(target, "http://127.0.0.1");
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
    if (this.entries.size === 0) this.onEmpty();
  }
}

type LocalRelay = { port: number; close(): Promise<void> };

export async function startLocalRelay(options: {
  port: number;
  token: string;
  /** Answers model calls: every plain request but /hosts. */
  model: ModelEndpoint;
}): Promise<LocalRelay> {
  const { token } = options;
  let port = options.port;
  // Host ids are chosen by each profile, so a subject lives only while it
  // holds sockets.
  const subjects = new Map<string, LocalSubject>();
  const selectedProtocol = new WeakMap<IncomingMessage, string>();
  const sockets = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    handleProtocols: (_offered, request) => selectedProtocol.get(request) ?? false,
  });
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    const refusal =
      url !== HOSTS_PATH
        ? admitModel(request.headers, port, token)
        : request.method === "GET"
          ? admitCli(request.headers, port, token)
          : refuse(404, "not found");
    if (refusal) {
      response.writeHead(refusal.status).end(refusal.reason);
      return;
    }
    if (url !== HOSTS_PATH) {
      options.model(request, response, url).catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500);
        response.end(String(error));
      });
      return;
    }
    const hosts = [...subjects]
      .filter(([, subject]) => subject.actor.online())
      .map(([id]) => ({ id }));
    response
      .writeHead(200, {
        "content-type": "application/json",
        // The CLI restarts a serve left behind by another version.
        [SERVE_HEADER]: `${packageJson.version} ${process.pid}`,
      })
      .end(JSON.stringify(hosts));
  });
  const upgraded = new Set<Duplex>();
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    socket.on("error", () => socket.destroy());
    const admission = admitUpgrade(request.url ?? "/", request.headers, port, token);
    if (!admission.ok) {
      writeRefusal(socket, admission.status, admission.reason);
      return;
    }
    if (admission.protocol) selectedProtocol.set(request, admission.protocol);
    let subject = subjects.get(admission.subject);
    if (!subject) {
      const created = new LocalSubject(() => {
        if (subjects.get(admission.subject) === created) subjects.delete(admission.subject);
      });
      subjects.set(admission.subject, created);
      subject = created;
    }
    void subject.actor
      .upgrade(admission.upgrade, subject.acceptor(sockets, request, socket, head))
      .then(async (answer) => {
        if (answer) writeRefusal(socket, answer.status, await answer.text());
      });
  });
  server.listen(options.port, "127.0.0.1");
  await once(server, "listening");
  // SAFETY: a server listening on a TCP port reports AddressInfo, never a pipe name.
  port = (server.address() as AddressInfo).port;
  return {
    port,
    close: async () => {
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/** A refused upgrade is answered on the raw socket, which then closes. */
function writeRefusal(socket: Duplex, status: number, reason: string): void {
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
