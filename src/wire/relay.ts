// The relay's wire contract, shared by every end of it: the relay itself (the
// hosted companion Worker and Durable Object, or `rook serve` on loopback), the
// extension's offscreen relay client, and the web clients (the companion PWA,
// or the rook CLI). Everything the relay interprets is here; Agent frames are
// never parsed on any socket. The hosted relay's Google credential, seats,
// sessions and TURN credentials are its own, in the companion's
// shared/protocol.ts.
import { z } from "zod";

// ── Paths and subprotocols ──────────────────────────────────────────────────

export const CONTROL_PATH = "/companion/control";
export const TUNNEL_PATH = "/companion/tunnel";
export const AGENTS_PATH_PREFIX = "/agents/";
export const SEATS_PATH_PREFIX = "/seats/";
/** Default loopback endpoint. An isolated build and CLI may choose another port. */
export const LOCAL_RELAY_ORIGIN = "http://127.0.0.1:7391";

/** Port 0 asks `rook serve` for an OS-assigned port; clients use the reported port. */
export function localRelayOrigin(port?: string): string {
  if (port === undefined || port === "") return LOCAL_RELAY_ORIGIN;
  if (!/^\d+$/.test(port) || Number(port) > 65535) {
    throw new Error("ROOK_RELAY_PORT must be a TCP port between 0 and 65535");
  }
  return new URL(`http://127.0.0.1:${Number(port)}`).origin;
}
/** A profile's longest wait between redials of `rook serve`. A refused
 * loopback connect costs nothing, and the first `rook` command after login
 * starts the relay and then waits this long for every opted-in profile. */
export const LOCAL_RELAY_RECONNECT_MAX_MS = 5_000;

/** The web client's Agents `prefix` for one seat: a Google account on the
 * hosted relay, a profile's host id on `rook serve`. Every Agent this seat
 * addresses — the root directory and each conversation alike — is dialed as
 * `<prefix>/<agent-namespace>/<name>`, so one seat segment covers them all and
 * naming the actor stays with the caller. Upstream supplies the leading slash,
 * so this is `SEATS_PATH_PREFIX` onward: prefixed with one, it is exactly what
 * `parseCompanionSeatAgentPath` accepts back. */
export function companionSeatAgentsPrefix(subject: string): string {
  return `seats/${encodeURIComponent(subject)}/agents`;
}

export function parseCompanionSeatAgentPath(
  pathname: string,
): { agentPath: string; subject: string } | null {
  if (!pathname.startsWith(SEATS_PATH_PREFIX)) return null;
  const remaining = pathname.slice(SEATS_PATH_PREFIX.length);
  const slash = remaining.indexOf("/");
  if (slash <= 0) return null;
  const encodedSubject = remaining.slice(0, slash);
  let subject: string;
  try {
    subject = decodeURIComponent(encodedSubject);
  } catch {
    return null;
  }
  if (!subject || encodeURIComponent(subject) !== encodedSubject) return null;
  const agentPath = remaining.slice(slash);
  return agentPath.startsWith(AGENTS_PATH_PREFIX) ? { agentPath, subject } : null;
}

// Browser WebSockets cannot set an Authorization header and query strings
// reach request logs too easily, so credentials ride the subprotocol list.
// A browser client that offered protocols aborts the connection when the
// server selects none, so the 101 must echo the base subprotocol.
export const CONTROL_SUBPROTOCOL = "sigvelo-control-v1";
export const TUNNEL_SUBPROTOCOL = "sigvelo-tunnel-v1";
const TUNNEL_ID_PREFIX = "tunnel.";
// The local relay (`rook serve`) has no Google check: it routes by this
// profile-chosen host id, and admits only Rook extension origins on loopback.
const LOCAL_HOST_PREFIX = "host.";

// ── Close codes ─────────────────────────────────────────────────────────────

/** A newer extension control connection replaced this socket's host. */
export const CLOSE_HOST_REPLACED = 1012;
export const CLOSE_HOST_REPLACED_REASON = "extension host replaced";
/** Retryable: no live extension host for this subject right now. */
export const CLOSE_HOST_OFFLINE = 1013;
/** The paired peer socket closed; reconnect creates a fresh pairing. */
export const CLOSE_PEER_CLOSED = 1012;
/** Retryable: the relay dropped a control socket whose pings stopped. */
export const CLOSE_CONTROL_STALE = 1012;
/** A frame arrived that the control protocol does not define. */
export const CLOSE_PROTOCOL_VIOLATION = 4400;

// ── Pairing ─────────────────────────────────────────────────────────────────

/** How long the relay holds a web upgrade open for the extension to dial the
 * paired tunnel before closing host-offline. The Worker env's
 * TUNNEL_CONNECT_TIMEOUT_MS overrides it (tests shorten the wait); a web
 * client's connect timeout must outlive this window or no attempt against a
 * live host can ever complete. */
export const TUNNEL_CONNECT_TIMEOUT_MS = 10_000;

// ── Control liveness ────────────────────────────────────────────────────────
// A silently dead TCP peer leaves a WebSocket reporting OPEN indefinitely on
// both ends, and browser sockets cannot send protocol-level pings. So the
// extension sends this literal text frame on the control socket — immediately
// on open, then on an interval — and the relay answers it through the
// WebSocket auto-response, which replies and stamps a per-socket timestamp
// without waking the hosted Durable Object. The extension reconnects on a
// missed pong; the relay treats a control socket with no recent stamp as
// offline.

export const CONTROL_PING = "ping";
export const CONTROL_PONG = "pong";
export const CONTROL_PING_INTERVAL_MS = 25_000;
/** How long the extension waits for a pong before redialing control. */
export const CONTROL_PONG_TIMEOUT_MS = 10_000;
/** Two missed ping intervals plus the pong grace: presumed dead beyond this. */
export const CONTROL_STALE_MS = 2 * CONTROL_PING_INTERVAL_MS + CONTROL_PONG_TIMEOUT_MS;

// ── Tunnel liveness ────────────────────────────────────────────────────────
// These application frames deliberately differ from the control socket's
// auto-response literals. The relay forwards them untouched so an
// acknowledgement proves the companion JavaScript itself is still reachable.

export const TUNNEL_HEARTBEAT_REQUEST = "@rook/companion:tunnel-heartbeat:request:v1";
export const TUNNEL_HEARTBEAT_ACK = "@rook/companion:tunnel-heartbeat:ack:v1";
export const TUNNEL_HEARTBEAT_INTERVAL_MS = 25_000;
export const TUNNEL_HEARTBEAT_TIMEOUT_MS = 10_000;

// ── Control messages (relay → extension) ────────────────────────────────────

export const relayControlMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("open"),
    tunnelId: z.string().min(1),
    /** Path and query of the web client's requested Agent URL, verbatim. */
    url: z.string().startsWith(AGENTS_PATH_PREFIX),
  }),
]);

export type RelayControlMessage = z.infer<typeof relayControlMessageSchema>;

// ── Subprotocol credential encoding ─────────────────────────────────────────
// Base64url is unpadded: "=" is not valid in the Sec-WebSocket-Protocol token
// grammar. btoa is available in Node, the Workers runtime, and the browser.

/** One subprotocol entry carrying `value` under `prefix`. */
export function encodePrefixedProtocol(prefix: string, value: string): string {
  const encoded = btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${prefix}${encoded}`;
}

export function encodeLocalHostProtocol(hostId: string): string {
  return encodePrefixedProtocol(LOCAL_HOST_PREFIX, hostId);
}

export function encodeTunnelIdProtocol(tunnelId: string): string {
  return encodePrefixedProtocol(TUNNEL_ID_PREFIX, tunnelId);
}

/** Split a Sec-WebSocket-Protocol header into its offered entries. */
export function parseSubprotocolHeader(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The value offered under `prefix`, if exactly one entry carries it. */
export function decodePrefixedProtocol(entries: string[], prefix: string): string | null {
  const matches = entries.filter((entry) => entry.startsWith(prefix));
  if (matches.length !== 1) return null;
  const padded = matches[0].slice(prefix.length).replaceAll("-", "+").replaceAll("_", "/");
  try {
    const decoded = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/** The tunnel id offered on a tunnel upgrade, if exactly one. */
export function decodeTunnelIdProtocol(entries: string[]): string | null {
  return decodePrefixedProtocol(entries, TUNNEL_ID_PREFIX);
}

/** The host id offered on a local relay upgrade, if exactly one. */
export function decodeLocalHostProtocol(entries: string[]): string | null {
  return decodePrefixedProtocol(entries, LOCAL_HOST_PREFIX);
}
