// Benchmark-only endpoint: the same transport as rook serve, without admission.
import { createServer } from "node:http";
import { Config, Effect, Layer } from "effect";
import { HttpServerRequest } from "effect/http";
import { NodeHttpClient, NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { forwardModelCall, ModelRelay } from "../src/relay.ts";

const program = Effect.gen(function* () {
  const port = yield* Config.Number("RELAY_PORT").pipe(Config.withDefault(10531));
  const transport = yield* Config.String("RELAY_TRANSPORT").pipe(Config.withDefault("ws"));
  const upstream = { kind: "codex", transport: transport === "http" ? "http" : "ws" } as const;
  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const path = request.url.startsWith("/v1/") ? request.url.slice(3) : request.url;
    return yield* forwardModelCall(request, upstream, path);
  });
  const server = yield* NodeHttpServer.make(createServer, { port, host: "127.0.0.1" });
  yield* server.serve(app.pipe(Effect.interruptible));
  yield* Effect.log(`http://127.0.0.1:${port}/v1 → ChatGPT over ${upstream.transport}`);
  return yield* Effect.never;
});

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(ModelRelay.layer),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
    Effect.scoped,
  ),
);
