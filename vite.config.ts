import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp exec -- vp pack",
        input: [{ auto: true }, "!bin/**"],
        output: ["bin/**"],
      },
    },
  },
  // One self-contained file: the Agents SDK is a GitHub release tarball, not
  // an npm package. It is bin/rook because Claude Code puts an enabled
  // plugin's bin/ on the PATH.
  pack: {
    entry: { rook: "src/main.ts" },
    outDir: "bin",
    outExtensions: () => ({ js: "" }),
    format: ["esm"],
    platform: "node",
    target: "node22.19",
    clean: true,
    deps: { onlyBundle: false },
  },
  // Process tests spawn the packed binary; it is built once per run here.
  test: {
    globalSetup: ["src/testing/global-setup.ts"],
  },
});
