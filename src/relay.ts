// Model transport belongs to the daemon scope. HTTP routing and model selection
// share this service, so testing a candidate never publishes it to model.json.
import { createOpenAIOAuthTransport } from "@openai-oauth/core";
import { openaiCredentials } from "@openai-oauth/local";
import {
  Cache,
  Clock,
  Config,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Scope,
  ScopedCache,
} from "effect";
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpMethod,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { type HeaderSource, type Upstream, upstreamSchema } from "./model-settings.ts";
import { connectNodeWebSocket } from "./node-responses-socket.ts";
import { responsesOverWebSocket } from "./wire/responses-socket.ts";

class ModelTransportError extends Data.TaggedError("ModelTransportError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const transportError = (cause: unknown) =>
  new ModelTransportError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/** A header command's trimmed output and when its run finished. */
type Output = { readonly value: string; readonly at: number };

type Send = (
  upstream: Upstream,
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, ModelTransportError, Scope.Scope>;

/** How long a header command may run, and how long it has to exit once killed. */
const HEADER_COMMAND_TIMEOUT = "30 seconds";
const HEADER_COMMAND_KILL_GRACE = "1 second";
/** Request headers a model call keeps; serve's own authorization stays with serve. */
const FORWARDED_HEADERS = ["content-type", "session-id"];

/** The daemon's one model transport owner. */
export class ModelRelay extends Context.Service<ModelRelay, { readonly send: Send }>()(
  "rook/ModelRelay",
) {
  static readonly layer = Layer.effect(ModelRelay)(
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fetchClient = Context.get(
        yield* Layer.build(FetchHttpClient.layer),
        HttpClient.HttpClient,
      );
      // A command's output is shared by every header that runs it, process-wide,
      // and concurrent callers share one run. A failed run is not kept.
      const outputs = yield* Cache.makeWith(
        Effect.fnUntraced(function* (command: string) {
          const output = yield* processes
            .string(
              ChildProcess.make("/bin/sh", ["-c", command], {
                forceKillAfter: HEADER_COMMAND_KILL_GRACE,
              }),
            )
            .pipe(Effect.timeout(HEADER_COMMAND_TIMEOUT));
          const at = yield* Clock.currentTimeMillis;
          return { value: output.trim(), at };
        }),
        {
          capacity: Infinity,
          timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
        },
      );

      /** The command's output, run again when it is older than this source's
       * ttl or is the `stale` output an upstream refused. */
      const commandOutput = Effect.fnUntraced(function* (
        source: Extract<HeaderSource, { command: string }>,
        stale: Output | undefined,
      ) {
        const cached = yield* Cache.getSuccess(outputs, source.command);
        if (Option.isSome(cached)) {
          const current = cached.value;
          const now = yield* Clock.currentTimeMillis;
          if (current !== stale && (source.ttl === undefined || now - current.at < source.ttl)) {
            return current;
          }
          // Only the first caller to see this output retires it; the others
          // join the run it starts.
          yield* Cache.invalidateWhen(outputs, source.command, (output) => output === current);
        }
        return yield* Cache.get(outputs, source.command);
      });

      const header = Effect.fnUntraced(function* (
        source: HeaderSource,
        stale: ReadonlyMap<string, Output>,
        used: Map<string, Output>,
      ): Effect.fn.Return<readonly [string, string] | undefined, ModelTransportError> {
        if ("value" in source) return [source.name, source.value] as const;
        if ("command" in source) {
          const output = yield* commandOutput(source, stale.get(source.command)).pipe(
            Effect.mapError(transportError),
          );
          used.set(source.command, output);
          return [source.name, `${source.prefix ?? ""}${output.value}`] as const;
        }
        const value = yield* Config.String(source.env).pipe(
          Config.option,
          Effect.mapError(transportError),
        );
        if (Option.isSome(value))
          return [source.name, `${source.prefix ?? ""}${value.value}`] as const;
        if (source.optional) return undefined;
        return yield* new ModelTransportError({
          message: `rook serve has no ${source.env} in its environment for the ${source.name} header: export it, stop rook serve, and run rook again`,
        });
      });

      /** An HttpClient over the upstream's transport: plain HTTP, the shared
       * Responses WebSocket, and ChatGPT's OAuth for Codex. */
      const client = Effect.fnUntraced(function* (upstream: Upstream) {
        if (upstream.kind === "url" && upstream.transport === "http") return http;
        const wrapper =
          upstream.transport === "ws"
            ? yield* Effect.acquireRelease(
                Effect.sync(() => responsesOverWebSocket(connectNodeWebSocket)),
                (transport) => Effect.tryPromise(() => transport.dispose()).pipe(Effect.ignore),
              )
            : undefined;
        const socketFetch = wrapper?.(globalThis.fetch);
        const fetch: typeof globalThis.fetch = socketFetch
          ? (input, init) =>
              socketFetch(
                input,
                init?.body instanceof Uint8Array
                  ? { ...init, body: new TextDecoder().decode(init.body) }
                  : init,
              )
          : globalThis.fetch;
        const credentials = upstream.kind === "codex" ? openaiCredentials() : undefined;
        const oauth = credentials
          ? createOpenAIOAuthTransport({
              auth: () => credentials.getSession(),
              fetch,
              responsesState: false,
            })
          : undefined;
        const send: typeof globalThis.fetch = oauth
          ? (input, init) => {
              const url = new URL(String(input));
              return oauth.request(`${url.pathname}${url.search}`, init);
            }
          : fetch;
        // The SDK and shared Responses transport expose fetch. This is the
        // actual foreign boundary; requests and bodies stay Effect-native.
        return HttpClient.transform(fetchClient, (response) =>
          response.pipe(Effect.provideService(FetchHttpClient.Fetch, send)),
        );
      });

      // Keyed by the whole upstream: its transport, credentials and socket
      // conversations belong to that configuration and no other.
      const clients = yield* ScopedCache.make({
        capacity: Infinity,
        lookup: (key: string) =>
          Effect.try(() => upstreamSchema.parse(JSON.parse(key))).pipe(Effect.flatMap(client)),
      });

      const send: Send = Effect.fnUntraced(function* (upstream, request) {
        const upstreamClient = yield* ScopedCache.get(clients, JSON.stringify(upstream));
        const owner = yield* Effect.scope;
        const forwarded = Object.fromEntries(
          FORWARDED_HEADERS.flatMap((name) =>
            request.headers[name] === undefined ? [] : [[name, request.headers[name]]],
          ),
        );
        const prepared = request.pipe(
          HttpClientRequest.updateHeaders(() => Headers.fromInput(forwarded)),
          HttpClientRequest.prependUrl(
            upstream.kind === "codex" ? "https://chatgpt.com/v1" : upstream.baseUrl,
          ),
          (outgoing) =>
            HttpClientRequest.setUrl(outgoing, new URL(outgoing.url)).pipe(
              HttpClientRequest.appendUrlParams(outgoing.urlParams),
            ),
          HttpClientRequest.setUrlParams(upstream.kind === "url" ? upstream.query : {}),
        );
        // Each attempt owns a child scope, so a refused response can be
        // released before the retry while the accepted one lives with the caller.
        const attempt = Effect.fnUntraced(function* (stale: ReadonlyMap<string, Output>) {
          const used = new Map<string, Output>();
          const headers = yield* Effect.forEach(
            upstream.kind === "url" ? upstream.headers : [],
            (source) => header(source, stale, used),
          );
          const outgoing = HttpClientRequest.setHeaders(
            prepared,
            Object.fromEntries(headers.filter((entry) => entry !== undefined)),
          );
          const scope = yield* Scope.fork(owner);
          const response = yield* HttpClient.withScope(upstreamClient)
            .execute(outgoing)
            .pipe(Scope.provide(scope));
          return { response, scope, used };
        });
        const first = yield* attempt(new Map());
        if (
          first.response.status !== 401 ||
          upstream.kind !== "url" ||
          !upstream.headers.some((source) => "command" in source)
        ) {
          return first.response;
        }
        yield* Scope.close(first.scope, Exit.void);
        return (yield* attempt(first.used)).response;
      }, Effect.mapError(transportError));
      return { send };
    }),
  );
}

/** A model call serve answers itself, shaped like an upstream's error. */
export const modelError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { type: "rook_serve_error", message } }, { status });

/** Framing headers that describe the upstream's body, not the stream served from it. */
const HOP_HEADERS = ["content-encoding", "content-length", "transfer-encoding"];

/** Sends `call` (its path is what follows the upstream's /v1) and streams the
 * answer back. A transport failure is the upstream's, 502. */
export const relayModelCall = Effect.fnUntraced(
  function* (call: HttpClientRequest.HttpClientRequest, upstream: Upstream) {
    const relay = yield* ModelRelay;
    const reply = yield* relay.send(upstream, call);
    return HttpServerResponse.stream(reply.stream, {
      status: reply.status,
      headers: Headers.removeMany(reply.headers, HOP_HEADERS),
    });
  },
  Effect.catch((error) => Effect.succeed(modelError(502, error.message))),
);

/** Forwards one server request to `upstream` at `path`. A method HTTP does not
 * define is refused with 405, as the request's fault. */
export const forwardModelCall = Effect.fnUntraced(
  function* (request: HttpServerRequest.HttpServerRequest, upstream: Upstream, path: string) {
    const method = request.method;
    if (!HttpMethod.isHttpMethod(method)) return modelError(405, `unsupported method ${method}`);
    const outgoing = HttpClientRequest.make(method)(path, { headers: request.headers });
    const call =
      method === "POST"
        ? HttpClientRequest.bodyText(
            outgoing,
            yield* request.text,
            request.headers["content-type"] ?? "application/json",
          )
        : outgoing;
    return yield* relayModelCall(call, upstream);
  },
  Effect.catch((error) => Effect.succeed(modelError(502, error.message))),
);
