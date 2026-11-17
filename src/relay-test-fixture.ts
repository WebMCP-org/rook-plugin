// Real ephemeral relay fixture shared by HTTP, socket and opt-in model tests.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigProvider, Effect, Layer } from "effect";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { RookConfig } from "./config";
import { MODEL_FILE, ModelSettings, modelConfigSchema, type ModelConfig } from "./model-settings";
import { scopedLocalRelay } from "./serve";

const platform = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp);

/** What `rook model`'s test request needs to reach a relay on `port` whose
 * token is `token`: the CLI's configuration over `home`, and HTTP. */
export function modelTestLayer(home: string, port: number, token: string) {
  writeFileSync(join(home, "token"), token, { mode: 0o600 });
  return RookConfig.layer.pipe(
    Layer.provideMerge(platform),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({ ROOK_HOME: home, ROOK_RELAY_PORT: String(port) }),
      ),
    ),
  );
}

export function writeModelFixture(home: string, config: ModelConfig): void {
  writeFileSync(join(home, MODEL_FILE), JSON.stringify(modelConfigSchema.parse(config)), {
    mode: 0o600,
  });
}

export function testRelay(options: { port: number; token: string; home?: string }) {
  return Effect.gen(function* () {
    const home = options.home ?? mkdtempSync(join(tmpdir(), "rook-relay-test-"));
    if (!options.home)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(home, { recursive: true, force: true })),
      );
    const services = yield* Layer.build(
      ModelSettings.layer.pipe(
        Layer.provideMerge(RookConfig.layer),
        Layer.provideMerge(platform),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              ...process.env,
              ROOK_HOME: home,
              CODEX_HOME: home,
            }),
          ),
        ),
      ),
    );
    return yield* scopedLocalRelay(options).pipe(Effect.provideContext(services));
  });
}
