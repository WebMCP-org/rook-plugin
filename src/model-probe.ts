// One test request to a candidate model before any profile is pointed at it.
import { randomUUID } from "node:crypto";
import { Effect, Option, Stream } from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientRequest } from "effect/http";
import { z } from "zod";
import { CommandError } from "./command";
import { RookConfig } from "./config";
import type { Selection } from "./model-settings";
import { MODEL_TEST_PATH } from "./serve";
import { parseJson } from "./wire/responses-socket";

const TEST_PROMPT = "Reply with the word ready.";
const TEST_TIMEOUT_MS = 120_000;

const testEventSchema = z.object({ type: z.string() });
/** What serve answers when it could not reach the upstream (`modelError`). */
const serveErrorSchema = z.object({
  error: z.object({ type: z.literal("rook_serve_error"), message: z.string() }),
});
const terminalTypes = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
  "error",
]);

const testFailed = (upstream: string) => (cause: unknown) =>
  CommandError.failed(`the ${upstream} upstream test failed: ${String(cause)}`, cause);

/** Waits for the first terminal Responses event; the stream may hold several. */
const terminalEvent = (stream: Stream.Stream<Uint8Array, unknown>) =>
  Stream.suspend(() => {
    let events: Sse.Event[] = [];
    // A probe waits for the current response. Retry hints do not mean the
    // model failed and must not reconnect or replay its request.
    const parser = Sse.makeParser(
      (event) => {
        if (event._tag === "Event") events.push(event);
      },
      { maxEventSize: Infinity },
    );
    return stream.pipe(
      Stream.decodeText(),
      Stream.mapEffect((chunk) =>
        Effect.suspend(() => {
          const error = parser.feed(chunk);
          const emitted = events;
          events = [];
          return error ? Effect.fail(error) : Effect.succeed(emitted);
        }),
      ),
      Stream.flattenIterable,
    );
  }).pipe(
    Stream.map((event) => ({
      type: parseJson(testEventSchema, event.data)?.type,
      data: event.data,
    })),
    Stream.filter(({ type }) => type !== undefined && terminalTypes.has(type)),
    Stream.runHead,
  );

/** Has the running `rook serve` send the test, so it reads the headers' variables
 * and commands, Codex's sign-in and its transports as real calls will, while the
 * candidate stays private to this operation. The caller has elected serve. */
export const testModel = Effect.fn("rook.model.test")(
  function* ({ upstream, choice }: Selection) {
    const { relayOrigin, token } = yield* RookConfig;
    const http = yield* HttpClient.HttpClient;
    const failed = testFailed(choice.upstream);
    const chat = upstream.kind === "url" && upstream.api === "chat";
    const body = chat
      ? {
          model: choice.model,
          messages: [{ role: "user", content: TEST_PROMPT }],
          reasoning_effort: choice.effort,
        }
      : {
          model: choice.model,
          input: [{ role: "user", content: [{ type: "input_text", text: TEST_PROMPT }] }],
          reasoning: choice.effort ? { effort: choice.effort } : undefined,
          store: false,
          stream: true,
        };
    const response = yield* http
      .execute(
        HttpClientRequest.post(new URL(MODEL_TEST_PATH, relayOrigin)).pipe(
          HttpClientRequest.bearerToken(yield* token),
          // A Responses WebSocket opens only for a conversation.
          HttpClientRequest.setHeader("session-id", randomUUID()),
          HttpClientRequest.bodyJsonUnsafe({
            upstream,
            path: chat ? "/chat/completions" : "/responses",
            body,
          }),
        ),
      )
      .pipe(Effect.mapError(failed));
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.mapError(failed));
      const own = parseJson(serveErrorSchema, text);
      if (own)
        return yield* CommandError.failed(
          `the ${choice.upstream} upstream test failed: ${own.error.message}`,
        );
      return yield* CommandError.failed(
        `the ${choice.upstream} upstream answered ${response.status}: ${text}`,
      );
    }
    if (chat) {
      yield* response.text.pipe(Effect.mapError(failed));
      return;
    }
    const terminal = yield* terminalEvent(response.stream).pipe(Effect.mapError(failed));
    if (Option.isNone(terminal)) {
      return yield* CommandError.failed(
        `the ${choice.upstream} upstream ended its stream before the response finished`,
      );
    }
    const { type, data } = terminal.value;
    if (type !== "response.completed" && type !== "response.incomplete") {
      return yield* CommandError.failed(`the ${choice.upstream} upstream failed: ${data}`);
    }
  },
  (effect, { choice }) =>
    effect.pipe(
      Effect.timeout(TEST_TIMEOUT_MS),
      Effect.catchTag("TimeoutError", (cause) => Effect.fail(testFailed(choice.upstream)(cause))),
      Effect.scoped,
    ),
);
