import WebSocket from "ws";
import type { ConnectWebSocket } from "./wire/responses-socket.ts";
import { TUNNEL_CONNECT_TIMEOUT_MS } from "./wire/relay.ts";

/** Node owns the physical socket, so abort can terminate an unanswered upgrade. */
export const connectNodeWebSocket: ConnectWebSocket = async (url, headers, signal) => {
  if (signal?.aborted) return undefined;
  // An upstream that accepts TCP but never answers the upgrade fails like a
  // refused one, within the relay's own connect bound.
  const socket = new WebSocket(url, {
    headers: Object.fromEntries(headers),
    handshakeTimeout: TUNNEL_CONNECT_TIMEOUT_MS,
  });
  const opened = await new Promise<boolean>((resolve) => {
    const finish = (opened: boolean) => {
      socket.off("open", onOpen).off("close", onClose);
      signal?.removeEventListener("abort", abort);
      resolve(opened);
    };
    const onOpen = () => finish(true);
    const onClose = () => finish(false);
    const abort = () => socket.terminate();
    socket.once("open", onOpen).once("close", onClose);
    // ws reports errors as events before close; close owns failed acquisition.
    socket.on("error", () => {});
    signal?.addEventListener("abort", abort, { once: true });
  });
  return opened ? socket : undefined;
};
