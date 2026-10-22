import { z } from "zod";

/**
 * Opens a WebSocket whose upgrade request carries `headers`, or resolves
 * undefined when the handshake fails. Node's WebSocket takes headers in its
 * init; a browser needs the extension to add them on the network.
 */
export type ConnectWebSocket = (url: string, headers: Headers) => Promise<WebSocket | undefined>;

/** The relay's and tests' connector: Node's WebSocket (undici) takes handshake headers in its init. */
export const connectNodeWebSocket: ConnectWebSocket = async (url, headers) => {
  // The DOM declaration this package compiles against has no such overload.
  const socket: WebSocket = Reflect.construct(WebSocket, [
    url,
    { headers: Object.fromEntries(headers) },
  ]);
  const opened = await new Promise<boolean>((resolve) => {
    socket.addEventListener("open", () => resolve(true), { once: true });
    socket.addEventListener("error", () => resolve(false), { once: true });
  });
  return opened ? socket : undefined;
};

// openai/codex codex-rs/core/src/client.rs RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE.
const WEBSOCKET_BETA = "responses_websockets=2026-02-06";
// A refused handshake keeps its conversation on HTTP this long, then tries again.
const REFUSED_COOLDOWN_MS = 5 * 60_000;
// ChatGPT answers `response.create` with `response.created` at once; silence
// this long means the socket is dead, and the request still has HTTP.
const FIRST_EVENT_TIMEOUT_MS = 30_000;
const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
]);

const requestBodySchema = z.record(z.string(), z.json());
const itemsSchema = z.array(z.json());
const outputTextSchema = z.object({ type: z.literal("output_text"), text: z.string() });
// Codex's WrappedWebsocketErrorEvent: an `error` event can carry the HTTP
// status and headers the same failure would have had over HTTP.
const eventSchema = z
  .object({
    type: z.string(),
    item: z.json().optional(),
    response: z.object({ id: z.string() }).loose().nullish(),
    status: z.number().optional(),
    headers: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    error: z.object({ code: z.string().nullish() }).loose().nullish(),
  })
  .loose();

type RequestBody = z.infer<typeof requestBodySchema>;
type Item = z.infer<typeof itemsSchema>[number];
// What ChatGPT holds for this socket: the last request and the items it returned.
type Previous = { request: RequestBody; output: Item[]; responseId: string };
type Conversation = {
  socket: Promise<WebSocket | undefined>;
  // The ChatGPT account the socket authenticated as; another one needs its own
  // socket. A refreshed token keeps it: the socket is already authenticated.
  account: string | null;
  busy: boolean;
  previous?: Previous;
};

/**
 * Sends Responses requests over Responses WebSocket mode, as Codex does on the
 * same ChatGPT backend: one socket per conversation (keyed by `session-id`),
 * so its requests reach the backend that holds its prompt cache, and a request
 * that extends the previous one sends only its new items with
 * `previous_response_id`. Anything the socket cannot carry goes to `fetch`
 * unchanged: a request without a `session-id` or `stream: true`, one
 * arriving while its conversation's socket is busy, one whose socket drops or
 * hits ChatGPT's connection limit before answering, and a conversation's
 * requests for a few minutes after a refused handshake. The returned wrapper keeps the sockets,
 * so a caller holds one per process and wraps each model's fetch with it.
 */
export function responsesOverWebSocket(
  connect: ConnectWebSocket,
  log: (line: string) => void = () => {},
): (fetch: typeof globalThis.fetch) => typeof globalThis.fetch {
  const conversations = new Map<string, Conversation>();
  const refusedUntil = new Map<string, number>();

  function forget(sessionId: string, conversation: Conversation) {
    if (conversations.get(sessionId) === conversation) conversations.delete(sessionId);
  }

  // Check-and-set with no await between, so concurrent first requests share one handshake.
  function open(sessionId: string, url: string, headers: Headers) {
    const account = headers.get("chatgpt-account-id");
    const current = conversations.get(sessionId);
    if (current && (current.account === account || current.busy)) return current;
    if (current) {
      forget(sessionId, current);
      void current.socket.then((socket) => socket?.close());
    }
    const handshake = new Headers(headers);
    handshake.delete("content-type");
    handshake.set("openai-beta", WEBSOCKET_BETA);
    const conversation: Conversation = { socket: Promise.resolve(undefined), account, busy: false };
    conversation.socket = connect(url.replace(/^http/u, "ws"), handshake).then(
      (socket) => {
        if (!socket) return refused(sessionId, conversation, "ChatGPT refused the WebSocket");
        socket.addEventListener("close", () => forget(sessionId, conversation));
        return socket;
      },
      (error: Error) =>
        refused(sessionId, conversation, `WebSocket connect failed: ${error.message}`),
    );
    conversations.set(sessionId, conversation);
    return conversation;
  }

  function refused(sessionId: string, conversation: Conversation, reason: string) {
    forget(sessionId, conversation);
    refusedUntil.set(sessionId, Date.now() + REFUSED_COOLDOWN_MS);
    log(`${sessionId.slice(0, 8)} ${reason}; HTTP for ${REFUSED_COOLDOWN_MS / 60_000} minutes`);
    return undefined;
  }

  return (fetch) => async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const sessionId = headers.get("session-id");
    // A query (Azure's api-version) rides along to the socket's URL.
    if (!sessionId || !URL.parse(url)?.pathname.endsWith("/responses") || init?.signal?.aborted) {
      return fetch(input, init);
    }
    if ((refusedUntil.get(sessionId) ?? 0) > Date.now()) return fetch(input, init);
    const parsed = parseJson(requestBodySchema, String(init?.body));
    // Only a streamed request has a socket equivalent.
    if (parsed?.stream !== true) return fetch(input, init);
    // Transport fields of the HTTP request; a socket message carries neither.
    const { stream: _stream, background: _background, ...body } = parsed;
    let conversation = open(sessionId, url, headers);
    let socket = await conversation.socket;
    // A socket whose Agent context ended reads CLOSED without a close event,
    // and a response it was serving never settles, so its conversation can
    // still read busy. Every other failure clears busy before it drops.
    if (socket && socket.readyState >= WebSocket.CLOSING) {
      forget(sessionId, conversation);
      conversation = open(sessionId, url, headers);
      socket = await conversation.socket;
    }
    // ponytail: one response per socket; a concurrent request (a compaction
    // summary) goes over HTTP rather than a second lane.
    if (socket?.readyState !== WebSocket.OPEN || conversation.busy) return fetch(input, init);
    // A socket that fails is forgotten at once, so the next request opens another.
    const drop = () => {
      forget(sessionId, conversation);
      socket.close();
    };
    const label = sessionId.slice(0, 8);
    const response = await respond(conversation, socket, drop, label, body, init?.signal, log);
    return response ?? fetch(input, init);
  };
}

/**
 * Sends one request on the socket and resolves its event stream once ChatGPT
 * starts answering, or undefined when the socket cannot answer it (closed,
 * silent, at its connection limit, aborted) so the caller sends it over HTTP.
 * An error ChatGPT reports with a status resolves as that HTTP error, so the
 * AI SDK retries and backs off exactly as it does over HTTP.
 */
function respond(
  conversation: Conversation,
  socket: WebSocket,
  drop: () => void,
  label: string,
  body: RequestBody,
  signal: AbortSignal | null | undefined,
  log: (line: string) => void,
): Promise<Response | undefined> {
  conversation.busy = true;
  const plan = continuation(conversation.previous, body);
  conversation.previous = undefined;
  let continued = "items" in plan;
  const output: Item[] = [];
  const send = (message: RequestBody) =>
    socket.send(JSON.stringify({ type: "response.create", ...message }));
  const encoder = new TextEncoder();
  const done = new AbortController();
  const listening = { signal: done.signal };
  return new Promise((resolve) => {
    const events = new ReadableStream<Uint8Array>({
      start(controller) {
        let streaming = false;
        const finish = () => {
          conversation.busy = false;
          clearTimeout(silence);
          done.abort();
        };
        // Codex drops the connection on any failure; before the first event
        // the request still has HTTP, after it the turn sees the error.
        const fail = (error: Error) => {
          finish();
          drop();
          if (streaming) {
            controller.error(error);
            return;
          }
          log(`${label} ${error.message}; using HTTP`);
          resolve(undefined);
        };
        const silence = setTimeout(
          () => fail(new Error("ChatGPT sent nothing on the WebSocket")),
          FIRST_EVENT_TIMEOUT_MS,
        );
        const onMessage = (message: MessageEvent) => {
          const data = String(message.data);
          const event = parseJson(eventSchema, data);
          if (!event) {
            fail(new Error(`ChatGPT sent an unreadable WebSocket frame: ${data.slice(0, 200)}`));
            return;
          }
          const code = event.error?.code;
          // The socket's cache lost the response (an evicting error): replay
          // the whole request before the caller sees anything.
          if (continued && code === "previous_response_not_found") {
            continued = false;
            log(`${label} previous response gone; sending in full`);
            send(body);
            return;
          }
          if (!streaming && code === "websocket_connection_limit_reached") {
            fail(new Error("ChatGPT ended the WebSocket at its connection limit"));
            return;
          }
          if (!streaming && event.type === "error" && event.status && event.status >= 400) {
            finish();
            drop();
            const headers = Object.fromEntries(
              Object.entries(event.headers ?? {}).map(([name, value]) => [name, String(value)]),
            );
            resolve(Response.json({ error: event.error }, { status: event.status, headers }));
            return;
          }
          // ChatGPT's `codex.*` preamble precedes an error as well as a
          // response, so only the response's own first event starts the stream.
          if (!streaming && !event.type.startsWith("codex.")) {
            streaming = true;
            clearTimeout(silence);
            resolve(new Response(events, { headers: { "content-type": "text/event-stream" } }));
          }
          if (event.type === "response.output_item.done" && event.item !== undefined) {
            output.push(event.item);
          }
          if (event.type === "response.completed" && event.response) {
            conversation.previous = { request: body, output, responseId: event.response.id };
          }
          // ChatGPT pretty-prints its error frames; SSE carries each line on its own `data:`.
          const lines = data.replaceAll("\n", "\ndata: ");
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${lines}\n\n`));
          if (TERMINAL_EVENTS.has(event.type)) {
            finish();
            controller.close();
            if (event.type === "error") drop();
          }
        };
        socket.addEventListener("message", onMessage, listening);
        socket.addEventListener(
          "close",
          () => fail(new Error("ChatGPT closed the WebSocket mid-response")),
          listening,
        );
        // A cancelled turn drops the connection, as Codex does: the socket's
        // cache is only good for the response it was serving.
        const aborted = () => fail(new Error("The request was aborted", { cause: signal?.reason }));
        if (signal?.aborted) {
          aborted();
          return;
        }
        signal?.addEventListener("abort", aborted, listening);
        if ("items" in plan) {
          send({ ...body, previous_response_id: plan.responseId, input: plan.items });
          log(`${label} appended ${plan.items.length} items`);
        } else {
          send(body);
          log(`${label} sent in full: ${plan.reason}`);
        }
      },
      cancel() {
        conversation.busy = false;
        done.abort();
        drop();
      },
    });
  });
}

export function parseJson<T extends z.ZodType>(schema: T, text: string): z.output<T> | undefined {
  try {
    return schema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

/**
 * Codex's continuation rule (`get_incremental_items` in openai/codex
 * codex-rs/core/src/client.rs): when every field but `input` is unchanged and
 * the new input starts with the previous input followed by the items ChatGPT
 * returned, only the rest is new.
 */
function continuation(
  previous: Previous | undefined,
  body: RequestBody,
): { items: Item[]; responseId: string } | { reason: string } {
  if (!previous) return { reason: "no previous response on this socket" };
  // ChatGPT answers a continued request that forces a tool call (structured
  // output's `required`) with a 400 claiming it has no tools. Codex never
  // forces one, so the full request is the shape the backend is known to take.
  if (body.tool_choice !== undefined && body.tool_choice !== "auto") {
    return { reason: "ChatGPT does not continue a forced tool choice" };
  }
  const { input: before, ...beforeFields } = previous.request;
  const { input: after, ...afterFields } = body;
  const changed = Object.keys({ ...beforeFields, ...afterFields }).filter(
    (key) => canonical(beforeFields[key]) !== canonical(afterFields[key]),
  );
  if (changed.length > 0) return { reason: `changed ${changed.join(", ")}` };
  const baseline = [...itemsSchema.parse(before), ...previous.output];
  const current = itemsSchema.parse(after);
  const mismatch = baseline.findIndex(
    (item, index) => canonical(replayed(item)) !== canonical(replayed(current[index])),
  );
  if (mismatch >= 0) {
    const show = (item: Item | undefined) => JSON.stringify(item ?? null).slice(0, 240);
    return {
      reason: `item ${mismatch} of ${baseline.length} differs: sent ${show(current[mismatch])}, held ${show(baseline[mismatch])}`,
    };
  }
  return { items: current.slice(baseline.length), responseId: previous.responseId };
}

// With store=false the AI SDK replays an output item without the `id` and
// `status` ChatGPT gave it or its empty arrays, and an assistant message as
// plain text rather than `output_text` parts. Rook's stored history also loses
// a message's `phase` and replays a call's arguments with its tool's schema
// defaults filled in. None of that is a change the model should see: ChatGPT's
// copy is what the model wrote, so an appended request that keeps it is the
// more faithful one. A call is the same call when its `call_id` matches.
function replayed(item: Item | undefined) {
  const object = requestBodySchema.safeParse(item).data;
  if (!object) return item;
  const { id: _id, status: _status, phase: _phase, ...fields } = object;
  if (fields.type === "function_call") {
    const { arguments: _arguments, ...call } = fields;
    return call;
  }
  const rest = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => !Array.isArray(value) || value.length > 0),
  );
  const { type, content, ...message } = rest;
  if (type !== undefined && type !== "message") return rest;
  const parts = itemsSchema.safeParse(content).data;
  const texts = parts?.map((part) => outputTextSchema.safeParse(part).data?.text);
  if (!texts?.every((text) => text !== undefined)) return { ...message, content };
  return { ...message, content: texts.join("") };
}

// JSON with every object's keys sorted, so key order never reads as a change.
function canonical(value: Item | undefined): string | undefined {
  return JSON.stringify(value, (_key, nested: Item) =>
    nested instanceof Object && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : 1)))
      : nested,
  );
}
