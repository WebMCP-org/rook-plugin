import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer } from "effect";
import { RookConfig } from "./config";
import { expect, it, vi } from "vitest";
import { Chrome } from "./chrome";
import { ROOK_EXTENSION_IDS } from "./wire/contracts";

/** Chrome's service with its platform, configured with a throwaway ROOK_HOME. */
const chromeLayer = (
  layer: Layer.Layer<Chrome, never, RookConfig | NodeServices.NodeServices>,
  home: string,
) =>
  layer.pipe(
    Layer.provide(RookConfig.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ ROOK_HOME: home }))),
    Layer.provide(NodeServices.layer),
  );

it("reads each Chrome profile's account and whether Rook is installed in it", async () => {
  const root = mkdtempSync(join(tmpdir(), "rook-chrome-"));
  // Local State as Chrome writes it, trimmed to what rook reads.
  writeFileSync(
    join(root, "Local State"),
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Personal", user_name: "me@example.com" },
          "Profile 2": { name: "Work", user_name: "me@work.example" },
          "Profile 3": { name: "Guest-ish" },
        },
      },
    }),
  );
  mkdirSync(join(root, "Profile 2", "Extensions", ROOK_EXTENSION_IDS.production), {
    recursive: true,
  });
  // A staging build is Rook too.
  mkdirSync(join(root, "Default", "Extensions", ROOK_EXTENSION_IDS.staging), {
    recursive: true,
  });

  const read = (directory: string) =>
    Effect.runPromise(
      Chrome.use((chrome) => chrome.profiles).pipe(
        Effect.provide(chromeLayer(Chrome.layerAt(directory), join(root, "rook-home"))),
      ),
    );
  expect(await read(root)).toEqual([
    { dir: "Default", email: "me@example.com", rook: true },
    { dir: "Profile 2", email: "me@work.example", rook: true },
    { dir: "Profile 3", email: "", rook: false },
  ]);
  expect(await read(join(root, "missing"))).toEqual([]);
  writeFileSync(join(root, "Local State"), "partial write");
  expect(await read(root)).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

it.runIf(process.platform === "darwin" || process.platform === "linux")(
  "hands an opened Chrome process to the desktop before its scope closes",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "rook-chrome-handoff-"));
    const marker = join(root, "opened");
    const released = join(root, "scope-closed");
    const started = join(root, "started");
    // The platform executable is the external boundary. It waits until the
    // parent scope has closed before acknowledging the browser handoff.
    writeFileSync(
      join(root, process.platform === "darwin" ? "open" : "google-chrome"),
      `#!/bin/sh
: > '${started}'
while [ -d '${root}' ] && [ ! -f '${released}' ]; do /bin/sleep 0.01; done
[ -d '${root}' ] || exit 0
printf '%s\n' "$@" > '${marker}'
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", root);
    try {
      await Effect.runPromise(
        Chrome.use((chrome) =>
          chrome.open({ profile: "Profile 2", url: "https://example.com" }),
        ).pipe(
          // OS executable startup is independent of Effect's spawn event.
          // Observe a running child before testing what scope closure does.
          Effect.andThen(
            Effect.promise(() =>
              expect.poll(() => existsSync(started), { timeout: 4_000 }).toBe(true),
            ),
          ),
          Effect.scoped,
          Effect.provide(chromeLayer(Chrome.layer, join(root, "rook-home"))),
        ),
      );
      writeFileSync(released, "");
      await expect
        .poll(() => {
          try {
            return readFileSync(marker, "utf8");
          } catch {
            return "";
          }
        })
        .toContain("--profile-directory=Profile 2\nhttps://example.com");
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
