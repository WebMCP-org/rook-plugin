import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  codexDefault,
  needsModel,
  parseFlags,
  redacted,
  selection,
  servedSource,
  UsageError,
  writeConfig,
} from "./model";
import { MODEL_FILE, readConfig, type ModelConfig } from "./relay";
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
  for (const name of ["CODEX_HOME"]) {
    vi.stubEnv(name, undefined);
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** What `rook model …` chooses for this command line. */
function chosen(...argv: string[]) {
  const { values, positionals } = parseFlags(argv);
  const [kind = "", ...rest] = positionals;
  return selection(kind, rest, values, 60_000);
}

describe("the first default", () => {
  it("is Codex's custom provider as its active profile picks it, with the headers and query Codex sends", () => {
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
    expect(codexDefault()).toEqual({
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

  it("runs a Codex provider's auth command as a bearer token, quoted for the shell", () => {
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
    expect(codexDefault()).toEqual({
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

  it("is ChatGPT over a WebSocket once Codex is signed in here", () => {
    write(join(home, ".codex", "config.toml"), 'model = "gpt-6-luna"\n');
    expect(codexDefault()).toBeUndefined();
    write(join(home, ".codex", "auth.json"), "{}");
    expect(codexDefault()).toEqual({
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
    expect(await chosen("codex")).toEqual({
      upstream: { kind: "codex", transport: "ws" },
      choice: { upstream: "codex", model: "gpt-6-luna", effort: "xhigh" },
    });
    expect(
      await chosen("codex", "--transport", "http", "--model", "gpt-6-sol", "--effort", "low"),
    ).toEqual({
      upstream: { kind: "codex", transport: "http" },
      choice: { upstream: "codex", model: "gpt-6-sol", effort: "low" },
    });
  });

  it("reads a url upstream's headers: values, variables with a prefix, and commands", async () => {
    expect(
      await chosen(
        "url",
        "https://llm.corp.example/v1",
        "--api",
        "responses",
        "--transport",
        "ws",
        "--model",
        "corp-model",
        "--effort",
        "low",
        "--header",
        "X-Team: rook",
        "--header-env",
        "Authorization=Bearer CORP_KEY",
        "--header-env",
        "X-Key=KEY",
        "--header-cmd",
        "X-Token=corp-token --audience llm",
      ),
    ).toEqual({
      upstream: {
        kind: "url",
        baseUrl: "https://llm.corp.example/v1",
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
    const base = "https://llm.corp.example/v1";
    for (const argv of [
      ["url", base, "--model", "m"],
      ["url", base, "--api", "chat", "--transport", "ws", "--model", "m"],
      ["url", base, "--api", "chat"],
      ["url", "llm.corp.example", "--api", "chat", "--model", "m"],
      ["url", base, "--api", "chat", "--model", "m", "--header", "X-Team rook"],
      ["codex", "--transport", "sse"],
      ["gemini"],
    ]) {
      await expect(chosen(...argv)).rejects.toBeInstanceOf(UsageError);
    }
  });
});

describe("model.json", () => {
  it("is readable by this user only, and reads as empty before rook writes it", () => {
    const rook = join(home, ".rook");
    expect(readConfig(rook)).toEqual({ version: 1, upstreams: {}, off: [] });
    const config: ModelConfig = {
      version: 1,
      upstreams: { codex: { kind: "codex", transport: "http" } },
      default: null,
      off: ["work"],
    };
    writeConfig(rook, config);
    expect(readConfig(rook)).toEqual(config);
    expect(statSync(join(rook, MODEL_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(rook).mode & 0o777).toBe(0o700);
    writeFileSync(join(rook, MODEL_FILE), '{"version":2}');
    expect(() => readConfig(rook)).toThrow();
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
    servedSource({
      upstream: { kind: "codex", transport: "ws" },
      choice: { upstream: "codex", model: "gpt-6-sol", effort: "high" },
    }),
    servedSource({
      upstream: {
        kind: "url",
        baseUrl: "https://llm.corp.example/v1",
        api: "chat",
        transport: "http",
        headers: [],
        query: {},
      },
      choice: { upstream: "url", model: "corp-model" },
    }),
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
