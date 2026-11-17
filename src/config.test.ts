import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { RookConfig } from "./config";

/** One process's view of `home`: its own RookConfig layer, as a fresh `rook` builds it. */
const readToken = (home: string) =>
  Effect.gen(function* () {
    const config = yield* RookConfig;
    return yield* config.token;
  }).pipe(
    Effect.provide(
      RookConfig.layer.pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ ROOK_HOME: join(home, "rook") })),
        ),
      ),
    ),
  );

it("gives every first run racing on one home the same non-empty private token", async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const home = await mkdtemp(join(tmpdir(), "rook-token-"));
    try {
      const tokens = await Effect.runPromise(
        Effect.all(
          Array.from({ length: 16 }, () => readToken(home)),
          { concurrency: "unbounded" },
        ),
      );
      expect(tokens[0]).toMatch(/^[\w-]{43}$/u);
      expect(new Set(tokens).size).toBe(1);
      expect(await readdir(join(home, "rook"))).toEqual(["token"]);
      expect((await stat(join(home, "rook", "token"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, "rook"))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});
