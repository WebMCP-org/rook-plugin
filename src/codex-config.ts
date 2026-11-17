// Codex's own configuration on this machine, read without changing its files:
// where Codex sends requests, and whether it is signed in to ChatGPT.
import { resolveAuthFileCandidates } from "@openai-oauth/local/auth-file";
import { Effect, FileSystem, Path } from "effect";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { CommandError } from "./command";
import { RookConfig } from "./config";
import { SettingsError, type HeaderSource, type Selection, type Upstream } from "./model-settings";
import { DEFAULT_CHATGPT_MODEL_ID, DEFAULT_CHATGPT_REASONING_EFFORT } from "./wire/contracts";

const codexSelectionSchema = z.object({
  model: z.string().optional(),
  model_provider: z.string().optional(),
  model_reasoning_effort: z.string().optional(),
});

// The parts of Codex's config.toml that say where it sends requests.
const codexConfigSchema = codexSelectionSchema.extend({
  profile: z.string().optional(),
  profiles: z.record(z.string(), codexSelectionSchema).default({}),
  model_providers: z
    .record(
      z.string(),
      z.object({
        base_url: z.url().optional(),
        // Codex dropped chat; an older config may still name it.
        wire_api: z.enum(["responses", "chat"]).default("responses"),
        env_key: z.string().optional(),
        http_headers: z.record(z.string(), z.string()).default({}),
        env_http_headers: z.record(z.string(), z.string()).default({}),
        query_params: z.record(z.string(), z.string()).default({}),
        auth: z
          .object({
            command: z.string(),
            args: z.array(z.string()).default([]),
            refresh_interval_ms: z.number().default(300_000),
          })
          .optional(),
      }),
    )
    .default({}),
});

type CodexProvider = z.infer<typeof codexConfigSchema>["model_providers"][string];

const quoted = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/** A Codex model provider as serve's url upstream, its key and headers as Codex sends them. */
function providerUpstream(provider: CodexProvider, baseUrl: string): Upstream {
  const headers: HeaderSource[] = [];
  if (provider.env_key) {
    headers.push({ name: "Authorization", env: provider.env_key, prefix: "Bearer " });
  }
  if (provider.auth) {
    headers.push({
      name: "Authorization",
      command: [provider.auth.command, ...provider.auth.args].map(quoted).join(" "),
      prefix: "Bearer ",
      // Codex's 0 refreshes only when a request is refused.
      ttl: provider.auth.refresh_interval_ms || undefined,
    });
  }
  for (const [name, value] of Object.entries(provider.http_headers)) {
    headers.push({ name, value });
  }
  // Codex sends these only when the variable is set.
  for (const [name, env] of Object.entries(provider.env_http_headers)) {
    headers.push({ name, env, optional: true });
  }
  return {
    kind: "url",
    baseUrl,
    api: provider.wire_api,
    transport: "http",
    headers,
    query: provider.query_params,
  };
}

/** ChatGPT through this machine's Codex sign-in, at its defaults where unset. */
export function chatgptSelection(
  transport: "ws" | "http",
  model: string | undefined,
  effort: string | undefined,
): Selection {
  return {
    upstream: { kind: "codex", transport },
    choice: {
      upstream: "codex",
      model: model ?? DEFAULT_CHATGPT_MODEL_ID,
      effort: effort ?? DEFAULT_CHATGPT_REASONING_EFFORT,
    },
  };
}

/** Codex's config.toml under CODEX_HOME; a missing file is an empty configuration. */
export const codexConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { codexHome } = yield* RookConfig;
  const file = path.join(codexHome, "config.toml");
  const text = yield* fs
    .readFileString(file)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed("")
          : Effect.fail(new SettingsError({ operation: "read", path: file, cause: error })),
      ),
    );
  const config = yield* Effect.try({
    try: () => codexConfigSchema.parse(parseToml(text)),
    catch: (cause) => new SettingsError({ operation: "read", path: file, cause }),
  });
  const active =
    config.profile !== undefined && Object.hasOwn(config.profiles, config.profile)
      ? config.profiles[config.profile]
      : {};
  return {
    config,
    provider: active.model_provider ?? config.model_provider ?? "openai",
    model: active.model ?? config.model,
    effort: active.model_reasoning_effort ?? config.model_reasoning_effort,
  };
});

/** Discovers the user's existing Codex provider without changing its files. */
export const codexDefault = Effect.gen(function* () {
  const { config, provider, model, effort } = yield* codexConfig;
  if (provider === "openai") {
    const fs = yield* FileSystem.FileSystem;
    const found = yield* Effect.forEach(resolveAuthFileCandidates(), (file) =>
      fs.exists(file),
    ).pipe(
      Effect.mapError((cause) =>
        CommandError.failed("could not inspect Codex authentication", cause),
      ),
    );
    return found.some(Boolean) ? chatgptSelection("ws", model, effort) : undefined;
  }
  const custom = Object.hasOwn(config.model_providers, provider)
    ? config.model_providers[provider]
    : undefined;
  if (!custom?.base_url || !model) return undefined;
  const selection: Selection = {
    upstream: providerUpstream(custom, custom.base_url),
    choice: { upstream: "url", model, effort },
  };
  return selection;
});
