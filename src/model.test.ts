import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  statSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexDefault } from "./codex-config";
import {
  codexCommand,
  codexSelection,
  needsModel,
  servedSource,
  urlCommand,
  urlSelection,
} from "./model";
import {
  MODEL_FILE,
  ModelSettings,
  redacted,
  type ModelConfig,
  type Selection,
} from "./model-settings";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { ConfigProvider, Effect, Exit, Layer, Scope } from "effect";
import { CliError, CliOutput, Command } from "effect/cli";
import { CommandError, EXIT } from "./command";
import { Chrome } from "./chrome";
import { RookConfig } from "./config";
import { CliSession } from "./output";
import { testRelay } from "./relay-test-fixture";
import { RookSessions } from "./session";
import { DEFAULT_CHATGPT_REASONING_EFFORT, type RookDirectoryState } from "./wire/contracts";
import { LOCAL_RELAY_ORIGIN } from "./wire/relay";

// A new profile's state, as far as rook reads it.
const NEW_PROFILE: RookDirectoryState = {
  threads: [],
  browser: { waits: {} },
  operatingIdentity: { kind: "personal" },
  profileVerification: { status: "signed-out" },
  model: { kind: "chatgpt-oauth", status: "signed-out" },
  managedPolicy: null,
};
const profile = (changes: Partial<RookDirectoryState>) => ({ ...NEW_PROFILE, ...changes });

it("gives serve's model only to a profile with none, never over a chosen or managed one", () => {
  expect(needsModel(NEW_PROFILE)).toBe(true);
  for (const chosen of [
    { model: { kind: "chatgpt-oauth", status: "signed-in" } },
    { model: { kind: "chatgpt-oauth", status: "error" } },
    {
      model: {
        kind: "chatgpt-oauth",
        status: "signed-out",
        config: { modelId: "gpt-6-luna", reasoningEffort: "high" },
      },
    },
    {
      model: {
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:7391/codex/v1",
        modelId: "gpt-6-luna",
      },
    },
    { managedPolicy: { modelBaseUrl: "https://models.example.com/v1", modelId: "org-model" } },
  ] satisfies Partial<RookDirectoryState>[]) {
    expect(needsModel(profile(chosen))).toBe(false);
  }
});

let home: string;
beforeEach(() => {
  // A machine with no Codex configuration of its own.
  home = mkdtempSync(join(tmpdir(), "rook-model-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("ROOK_HOME", join(home, ".rook"));
  for (const name of ["CODEX_HOME"]) {
    vi.stubEnv(name, undefined);
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const services = () =>
  RookConfig.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(process.env))),
  );
const settings = () => ModelSettings.layer.pipe(Layer.provideMerge(services()));
const BASE = "https://llm.corp.example/v1";

/** The selection the real subcommand parses from `args`, without probing or assigning it. */
const chosen = (kind: "codex" | "url", args: string[]) => {
  let parsed: Selection | undefined;
  const keep = (selection: Selection) =>
    Effect.sync(() => {
      parsed = selection;
    });
  const run =
    kind === "codex"
      ? Command.runWith(
          Command.withHandler(codexCommand, (input) =>
            codexSelection(input).pipe(Effect.flatMap(keep)),
          ),
          { version: "test" },
        )(args)
      : Command.runWith(
          Command.withHandler(urlCommand, (input) =>
            urlSelection(input).pipe(Effect.flatMap(keep)),
          ),
          { version: "test" },
        )(args);
  return Effect.runPromise(
    run.pipe(
      Effect.map(() => parsed),
      Effect.provide(services()),
      Effect.provide(CliOutput.layerPresenter({ present: () => Effect.void })),
    ),
  );
};
const defaultModel = () => Effect.runPromise(codexDefault.pipe(Effect.provide(services())));

describe("the first default", () => {
  it("is Codex's custom provider as its active profile picks it, with the headers and query Codex sends", async () => {
    write(
      join(home, ".codex", "config.toml"),
      `model = "gpt-6-sol"
profile = "work"

[profiles.work]
model = "corp-model"
model_provider = "corp"
model_reasoning_effort = "high"

[model_providers.corp]
name = "Corp"
base_url = "https://llm.corp.example/v1"
env_key = "CORP_KEY"
http_headers = { "X-Team" = "rook" }
env_http_headers = { "X-Trace" = "CORP_TRACE" }
query_params = { "api-version" = "2026-01-01" }
`,
    );
    expect(await defaultModel()).toEqual({
      upstream: {
        kind: "url",
        baseUrl: "https://llm.corp.example/v1",
        api: "responses",
        transport: "http",
        headers: [
          { name: "Authorization", env: "CORP_KEY", prefix: "Bearer " },
          { name: "X-Team", value: "rook" },
          { name: "X-Trace", env: "CORP_TRACE", optional: true },
        ],
        query: { "api-version": "2026-01-01" },
      },
      choice: { upstream: "url", model: "corp-model", effort: "high" },
    });
  });

  it("runs a Codex provider's auth command as a bearer token, quoted for the shell", async () => {
    vi.stubEnv("CODEX_HOME", join(home, "codex"));
    write(
      join(home, "codex", "config.toml"),
      `model = "corp-model"
model_provider = "sso"

[model_providers.sso]
base_url = "https://llm.corp.example/v1"
wire_api = "chat"

[model_providers.sso.auth]
command = "printf"
args = ["%s", "it's"]
refresh_interval_ms = 0
`,
    );
    const command = `'printf' '%s' 'it'\\''s'`;
    expect(await defaultModel()).toEqual({
      upstream: {
        kind: "url",
        baseUrl: "https://llm.corp.example/v1",
        api: "chat",
        transport: "http",
        // Codex's 0 reruns it only when a request is refused.
        headers: [{ name: "Authorization", command, prefix: "Bearer " }],
        query: {},
      },
      choice: { upstream: "url", model: "corp-model" },
    });
    expect(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })).toBe("it's");
  });

  it("is ChatGPT over a WebSocket once Codex is signed in here", async () => {
    write(join(home, ".codex", "config.toml"), 'model = "gpt-6-luna"\n');
    expect(await defaultModel()).toBeUndefined();
    write(join(home, ".codex", "auth.json"), "{}");
    expect(await defaultModel()).toEqual({
      upstream: { kind: "codex", transport: "ws" },
      choice: { upstream: "codex", model: "gpt-6-luna", effort: DEFAULT_CHATGPT_REASONING_EFFORT },
    });
  });
});

describe("rook model's command line", () => {
  it("asks ChatGPT for Codex's own model, flags first", async () => {
    write(
      join(home, ".codex", "config.toml"),
      'model = "gpt-6-luna"\nmodel_reasoning_effort = "xhigh"\n',
    );
    expect(await chosen("codex", [])).toEqual({
      upstream: { kind: "codex", transport: "ws" },
      choice: { upstream: "codex", model: "gpt-6-luna", effort: "xhigh" },
    });
    expect(
      await chosen("codex", ["--transport", "http", "--model", "gpt-6-sol", "--effort", "low"]),
    ).toEqual({
      upstream: { kind: "codex", transport: "http" },
      choice: { upstream: "codex", model: "gpt-6-sol", effort: "low" },
    });
  });

  it("reads a url upstream's headers: values, variables with a prefix, and commands", async () => {
    expect(
      await chosen("url", [
        BASE,
        ...["--api", "responses", "--transport", "ws", "--model", "corp-model"],
        ...["--effort", "low", "--header-ttl", "60s", "--header", "X-Team: rook"],
        ...["--header-env", "Authorization=Bearer CORP_KEY", "--header-env", "X-Key=KEY"],
        ...["--header-cmd", "X-Token=corp-token --audience llm"],
      ]),
    ).toEqual({
      upstream: {
        kind: "url",
        baseUrl: BASE,
        api: "responses",
        transport: "ws",
        headers: [
          { name: "X-Team", value: "rook" },
          { name: "Authorization", env: "CORP_KEY", prefix: "Bearer " },
          { name: "X-Key", env: "KEY" },
          { name: "X-Token", command: "corp-token --audience llm", ttl: 60_000 },
        ],
        query: {},
      },
      choice: { upstream: "url", model: "corp-model", effort: "low" },
    });
  });

  it.each([
    ["url", [BASE, "--model", "m"]],
    ["url", [BASE, "--api", "chat", "--transport", "ws", "--model", "m"]],
    ["url", [BASE, "--api", "chat"]],
    ["url", ["llm.corp.example", "--api", "chat", "--model", "m"]],
    ["url", [BASE, "--api", "chat", "--model", "m", "--header", "X-Team rook"]],
    ["url", [BASE, "--api", "chat", "--model", "m", "--header-env", "X="]],
    ["url", [BASE, "--api", "chat", "--model", "m", "--header-cmd", "X=a", "--header-ttl", "0"]],
    ["url", [BASE, "--api", "chat", "--model", "m", "--effort", ""]],
    ["codex", ["--transport", "sse"]],
  ] satisfies ["codex" | "url", string[]][])("refuses %s %j as usage", async (kind, args) => {
    const error: unknown = await chosen(kind, args).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    // Parse failures are CliErrors and the rest usage CommandErrors: both exit 2.
    expect(
      CliError.isCliError(error) || (error instanceof CommandError && error.code === EXIT.usage),
      String(error),
    ).toBe(true);
  });
});

describe("model.json", () => {
  it("preserves version one, private permissions and removes temporary files after replacement", async () => {
    const rook = join(home, ".rook");
    const config: ModelConfig = {
      version: 1,
      upstreams: { codex: { kind: "codex", transport: "http" } },
      default: null,
      off: ["work"],
    };
    await Effect.runPromise(
      ModelSettings.use((store) =>
        store.read.pipe(
          Effect.tap((initial) =>
            Effect.sync(() => {
              expect(initial).toEqual({ version: 1, upstreams: {}, off: [] });
            }),
          ),
          Effect.andThen(store.update(() => config)),
          Effect.andThen(store.read),
          Effect.tap((saved) =>
            Effect.sync(() => {
              expect(saved).toEqual(config);
            }),
          ),
        ),
      ).pipe(Effect.provide(settings())),
    );
    expect(statSync(join(rook, MODEL_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(rook).mode & 0o777).toBe(0o700);
    expect(readdirSync(rook)).toEqual([MODEL_FILE]);
  });

  it("loses no update when separate rooks change it at once through one rook serve", async () => {
    const rook = join(home, ".rook");
    write(join(rook, "token"), "lease-token");
    const scope = Scope.makeUnsafe();
    try {
      const relay = await Effect.runPromise(
        Scope.provide(testRelay({ port: 0, token: "lease-token", home: rook }), scope),
      );
      // Each run builds its own services, as a separate rook process does.
      const rookAt = () =>
        Layer.mergeAll(RookSessions.layer, ModelSettings.layer).pipe(
          Layer.provideMerge(Layer.mergeAll(CliSession.layer, Chrome.layerAt(join(home, "none")))),
          Layer.provideMerge(RookConfig.layer),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnvRecord({ ...process.env, ROOK_RELAY_PORT: String(relay.port) }),
            ),
          ),
        );
      const names = Array.from({ length: 8 }, (_, index) => `upstream-${index}`);
      await Promise.all(
        names.map((name) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const sessions = yield* RookSessions;
              const store = yield* ModelSettings;
              yield* sessions.exclusive(
                "model",
                store.update((latest) => ({
                  ...latest,
                  upstreams: { ...latest.upstreams, [name]: { kind: "codex", transport: "ws" } },
                })),
              );
            }).pipe(Effect.provide(rookAt())),
          ),
        ),
      );
      const saved = await Effect.runPromise(
        ModelSettings.use((store) => store.read).pipe(Effect.provide(settings())),
      );
      expect(Object.keys(saved.upstreams).sort()).toEqual(names);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("leaves a rejected released file unchanged, and reports directories instead of treating them as missing", async () => {
    const file = join(home, ".rook", MODEL_FILE);
    write(file, '{"version":2}');
    await expect(
      Effect.runPromise(
        ModelSettings.use((store) => store.update((latest) => ({ ...latest, off: [] }))).pipe(
          Effect.provide(settings()),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "SettingsError" });
    expect(readFileSync(file, "utf8")).toBe('{"version":2}');
    // A malformed file is named, never quoted: it can hold a literal header value.
    write(file, '{"upstreams":{"url":{"headers":[{"value":"sk-secret"');
    const malformed = Effect.runPromise(
      ModelSettings.use((store) => store.read).pipe(Effect.provide(settings())),
    );
    await expect(malformed).rejects.toThrow(`read ${file}: the file is not valid JSON`);
    await expect(malformed).rejects.not.toThrow("sk-secret");
    rmSync(file);
    mkdirSync(file);
    await expect(
      Effect.runPromise(ModelSettings.use((store) => store.read).pipe(Effect.provide(settings()))),
    ).rejects.toMatchObject({ _tag: "SettingsError" });
  });

  it("shows header commands and variables but not literal header or query values", () => {
    const config: ModelConfig = {
      version: 1,
      off: [],
      default: { upstream: "url", model: "corp-model" },
      upstreams: {
        codex: { kind: "codex", transport: "ws" },
        url: {
          kind: "url",
          baseUrl: "https://llm.corp.example/v1",
          api: "chat",
          transport: "http",
          headers: [
            { name: "Authorization", value: "Bearer secret" },
            { name: "X-Key", env: "KEY" },
            { name: "X-Token", command: "corp-token" },
          ],
          query: { key: "secret" },
        },
      },
    };
    const shown = redacted(config);
    expect(JSON.stringify(shown)).not.toContain("secret");
    expect(shown).toEqual({
      ...config,
      upstreams: {
        codex: config.upstreams.codex,
        url: {
          ...config.upstreams.url,
          headers: [
            { name: "Authorization", value: "<redacted>" },
            { name: "X-Key", env: "KEY" },
            { name: "X-Token", command: "corp-token" },
          ],
          query: { key: "<redacted>" },
        },
      },
    });
  });
});

it("points a profile at serve's /<upstream>/v1 with its model and effort, declaring what ChatGPT reads", () => {
  const sources = [
    servedSource(
      {
        upstream: { kind: "codex", transport: "ws" },
        choice: { upstream: "codex", model: "gpt-6-sol", effort: "high" },
      },
      LOCAL_RELAY_ORIGIN,
    ),
    servedSource(
      {
        upstream: {
          kind: "url",
          baseUrl: "https://llm.corp.example/v1",
          api: "chat",
          transport: "http",
          headers: [],
          query: {},
        },
        choice: { upstream: "url", model: "corp-model" },
      },
      LOCAL_RELAY_ORIGIN,
    ),
  ];
  expect(sources).toEqual([
    {
      api: "responses",
      baseUrl: `${LOCAL_RELAY_ORIGIN}/codex/v1`,
      modelId: "gpt-6-sol",
      reasoningEffort: "high",
      acceptsImages: true,
      acceptsPdfs: true,
    },
    // Another endpoint's model is looked up.
    { api: "chat-completions", baseUrl: `${LOCAL_RELAY_ORIGIN}/url/v1`, modelId: "corp-model" },
  ]);
});
