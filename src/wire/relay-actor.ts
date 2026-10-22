// One relay actor per subject: a Google account on the hosted relay, a Chrome
// profile's host id on `rook serve`. The actor owns no durable storage and no
// in-memory registries: its complete state is the accepted WebSockets
// themselves, with their tags and attachments, which the runtime keeps (on
// Cloudflare, across hibernation). When every socket closes, the topology
// disappears with them. Agent frames are copied between peers without being
// parsed. The actor reaches sockets only through `RelaySocketHost`; the
// Cloudflare and Node adapters implement it.
import { z } from "zod";
import {
  AGENTS_PATH_PREFIX,
  CLOSE_CONTROL_STALE,
  CLOSE_HOST_OFFLINE,
  CLOSE_HOST_REPLACED,
  CLOSE_HOST_REPLACED_REASON,
  CLOSE_PEER_CLOSED,
  CLOSE_PROTOCOL_VIOLATION,
  CONTROL_STALE_MS,
  type RelayControlMessage,
} from "./relay";

// Roles are immutable facts assigned at acceptance, queried through tags.
const CONTROL_TAG = "role:control";
const WEB_TAG = "role:web";
const TUNNEL_TAG = "role:tunnel";
const pairTag = (tunnelId: string) => `pair:${tunnelId}`;

const OPEN = 1;

export const socketAttachmentSchema = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("control"), acceptedAt: z.number() }),
  z.strictObject({ role: z.literal("offline") }),
  z.strictObject({
    role: z.literal("web"),
    tunnelId: z.string().min(1),
    url: z.string().startsWith(AGENTS_PATH_PREFIX),
  }),
  z.strictObject({
    role: z.literal("tunnel"),
    tunnelId: z.string().min(1),
  }),
]);

export type SocketAttachment = z.infer<typeof socketAttachmentSchema>;

/** The server end of one accepted WebSocket. */
export type RelaySocket = {
  readonly readyState: number;
  send(message: string | ArrayBuffer): void;
  /** May throw on a socket that is already closing. */
  close(code: number, reason: string): void;
};

/** What the actor needs from its runtime: the accepted sockets, by tag. */
export type RelaySocketHost<Socket extends RelaySocket> = {
  sockets(tag?: string): Socket[];
  /** The socket's current-version attachment, or null when what the runtime
   * holds is not one. */
  attachment(socket: Socket): SocketAttachment | null;
  /** When the runtime last answered a `CONTROL_PING` on this socket. */
  lastPongAt(socket: Socket): number | undefined;
};

/** Completes the upgrade that is being answered and accepts its server end
 * under `tags`. `Accepted` is what the adapter hands back to its runtime. */
export type AcceptSocket<Socket extends RelaySocket, Accepted> = (
  tags: string[],
  attachment: SocketAttachment,
) => { socket: Socket; accepted: Accepted };

/** An upgrade the router already authenticated. */
export type RelayUpgrade =
  | { role: "control" }
  /** `url` is the Agent path and query the host dials. */
  | { role: "web"; url: string }
  | { role: "tunnel"; tunnelId: string };

export class RelayActor<Socket extends RelaySocket, Accepted> {
  // Each entry only spans its own in-flight web upgrade request, which pins
  // the actor in memory; nothing here must survive hibernation. The pending
  // pairing IS the awaiting request.
  private pendingTunnels = new Map<string, (tunnel: Socket | null) => void>();

  constructor(
    private readonly host: RelaySocketHost<Socket>,
    private readonly tunnelConnectTimeoutMs: number,
  ) {}

  async upgrade(
    upgrade: RelayUpgrade,
    accept: AcceptSocket<Socket, Accepted>,
  ): Promise<Response | Accepted> {
    switch (upgrade.role) {
      case "control":
        return this.acceptControl(accept);
      case "web":
        return this.acceptWeb(upgrade.url, accept);
      case "tunnel":
        return this.acceptTunnel(upgrade.tunnelId, accept);
    }
  }

  /** Whether one live extension host holds this subject; a stale control is
   * closed on the way, as any upgrade would. */
  online(): boolean {
    return this.controlSocket() !== undefined;
  }

  private openSockets(tag?: string): Socket[] {
    return this.host.sockets(tag).filter((ws) => ws.readyState === OPEN);
  }

  private attachmentOf(ws: Socket): SocketAttachment | null {
    const attachment = this.host.attachment(ws);
    if (attachment) return attachment;
    this.closeProtocolViolation(ws, "invalid socket attachment");
    return null;
  }

  /** close() throws on a socket that is already closing; every relay-initiated
   * close treats that as already done. */
  private closeSocket(ws: Socket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  private closeProtocolViolation(ws: Socket, reason: string): void {
    this.closeSocket(ws, CLOSE_PROTOCOL_VIOLATION, reason);
  }

  private controlSocket(): Socket | undefined {
    const controls = this.openSockets(CONTROL_TAG);
    if (controls.length !== 1) {
      for (const control of controls) {
        this.closeProtocolViolation(control, "invalid control topology");
      }
      return undefined;
    }
    const control = controls[0];
    const attachment = this.attachmentOf(control);
    if (attachment?.role !== "control") {
      if (attachment) this.closeProtocolViolation(control, "invalid control attachment");
      return undefined;
    }
    // OPEN proves nothing about a silently dead peer, so liveness comes from
    // the auto-response clock: the runtime stamps the socket on every ping it
    // answers, and the extension pings on open, so a fresh socket is covered
    // by its acceptance time until the first stamp lands.
    const lastPong = this.host.lastPongAt(control);
    if (Date.now() - (lastPong ?? attachment.acceptedAt) > CONTROL_STALE_MS) {
      this.closeSocket(control, CLOSE_CONTROL_STALE, "control unresponsive");
      return undefined;
    }
    return control;
  }

  // The current relay contract permits one active extension host per subject: accepting a
  // new control socket closes every other socket in the actor — the old
  // control, its tunnels, and all web sockets, paired or pending. Pending
  // web upgrades must fail too: their tunnel ids were disclosed to the
  // replaced host, which must not connect those stale tunnels later.
  private acceptControl(accept: AcceptSocket<Socket, Accepted>): Accepted {
    for (const ws of this.host.sockets()) {
      this.closeSocket(ws, CLOSE_HOST_REPLACED, CLOSE_HOST_REPLACED_REASON);
    }
    for (const resolve of this.pendingTunnels.values()) resolve(null);
    const { accepted } = accept([CONTROL_TAG], { role: "control", acceptedAt: Date.now() });
    console.info("[companion-relay] control accepted");
    return accepted;
  }

  // The web upgrade completes only after its tunnel is paired, so the web
  // client's open event cannot race the extension's dial — no frame is ever
  // sent to a peerless socket, and nothing needs buffering.
  private async acceptWeb(url: string, accept: AcceptSocket<Socket, Accepted>): Promise<Accepted> {
    const control = this.controlSocket();
    if (!control) return this.closeAsOffline(accept);

    const tunnelId = crypto.randomUUID();
    control.send(JSON.stringify({ type: "open", tunnelId, url } satisfies RelayControlMessage));

    const tunnel = await new Promise<Socket | null>((resolve) => {
      const timer = setTimeout(() => settle(null), this.tunnelConnectTimeoutMs);
      const settle = (ws: Socket | null) => {
        clearTimeout(timer);
        this.pendingTunnels.delete(tunnelId);
        resolve(ws);
      };
      this.pendingTunnels.set(tunnelId, settle);
    });
    if (!tunnel) return this.closeAsOffline(accept);

    const { accepted } = accept([WEB_TAG, pairTag(tunnelId)], { role: "web", tunnelId, url });
    console.info("[companion-relay] pairing established");
    return accepted;
  }

  private acceptTunnel(
    tunnelId: string,
    accept: AcceptSocket<Socket, Accepted>,
  ): Response | Accepted {
    const settle = this.pendingTunnels.get(tunnelId);
    const conflicts = tunnelId ? this.openSockets(pairTag(tunnelId)) : [];
    if (!settle || conflicts.length > 0) {
      // Unknown, consumed, or conflicting tunnel id. A conflict means the id
      // leaked past its one pairing: collapse everything that carries it.
      for (const ws of conflicts) this.closeProtocolViolation(ws, "tunnel id conflict");
      return new Response("unknown or consumed tunnel id", { status: 409 });
    }
    const { socket, accepted } = accept([TUNNEL_TAG, pairTag(tunnelId)], {
      role: "tunnel",
      tunnelId,
    });
    settle(socket);
    return accepted;
  }

  // Explicit retryable host-offline signal: accept, then close with the
  // reason the PWA renders. A failed upgrade would look like a network error.
  private closeAsOffline(accept: AcceptSocket<Socket, Accepted>): Accepted {
    const { socket, accepted } = accept([WEB_TAG], { role: "offline" });
    this.closeSocket(socket, CLOSE_HOST_OFFLINE, "Rook is offline");
    return accepted;
  }

  /** The paired peer, recovered from tags alone — valid after hibernation. */
  private peerOf(attachment: SocketAttachment, ws: Socket): Socket | undefined {
    if (attachment.role === "control" || attachment.role === "offline") return undefined;
    const peers = this.openSockets(pairTag(attachment.tunnelId)).filter((peer) => peer !== ws);
    if (peers.length === 0) return undefined;
    if (peers.length !== 1) {
      this.closeProtocolViolation(ws, "invalid tunnel topology");
      for (const peer of peers) this.closeProtocolViolation(peer, "invalid tunnel topology");
      return undefined;
    }
    const peer = peers[0];
    const peerAttachment = this.attachmentOf(peer);
    const complementary =
      attachment.role === "web"
        ? peerAttachment?.role === "tunnel" && peerAttachment.tunnelId === attachment.tunnelId
        : peerAttachment?.role === "web" && peerAttachment.tunnelId === attachment.tunnelId;
    if (!complementary) {
      this.closeProtocolViolation(ws, "invalid paired socket attachment");
      if (peerAttachment) {
        this.closeProtocolViolation(peer, "invalid paired socket attachment");
      }
      return undefined;
    }
    return peer;
  }

  message(ws: Socket, message: string | ArrayBuffer): void {
    const attachment = this.attachmentOf(ws);
    if (!attachment) return;
    if (attachment.role === "control" || attachment.role === "offline") {
      // The current relay contract defines no frames on these sockets.
      this.closeProtocolViolation(ws, "unexpected control frame");
      return;
    }
    const peer = this.peerOf(attachment, ws);
    if (!peer) {
      this.closeSocket(ws, CLOSE_PEER_CLOSED, "no live peer");
      return;
    }
    peer.send(message);
  }

  close(ws: Socket, code: number, reason: string): void {
    const attachment = this.attachmentOf(ws);
    if (!attachment) return;
    if (attachment.role === "control") {
      // Established pairs keep flowing through their own tunnels; new web
      // connections fail host-offline until a control socket returns.
      console.info(`[companion-relay] control closed (${code})`);
      return;
    }
    const peer = this.peerOf(attachment, ws);
    if (!peer) return;
    // Preserve application-terminal close codes from the local Agent;
    // transport loss remains the retryable peer-closed signal.
    if (attachment.role === "tunnel" && code >= 4000 && code <= 4999) {
      this.closeSocket(peer, code, reason);
      return;
    }
    this.closeSocket(peer, CLOSE_PEER_CLOSED, "peer closed");
  }

  error(ws: Socket): void {
    this.closeSocket(ws, CLOSE_PEER_CLOSED, "socket error");
  }
}
