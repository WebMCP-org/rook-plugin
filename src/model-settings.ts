import { Context, Data, Effect, FileSystem, Layer, Path, Runtime } from "effect";
import { z } from "zod";
import { EXIT } from "./command.ts";
import { RookConfig } from "./config.ts";

export const MODEL_FILE = "model.json";

/** A header an upstream needs: a value, an environment variable of serve's, or a command's output. */
const headerSourceSchema = z.union([
  z.strictObject({ name: z.string().min(1), value: z.string() }),
  z.strictObject({
    name: z.string().min(1),
    env: z.string().min(1),
    prefix: z.string().optional(),
    // Codex's env_http_headers: sent only when the variable is set.
    optional: z.boolean().optional(),
  }),
  z.strictObject({
    name: z.string().min(1),
    command: z.string().min(1),
    prefix: z.string().optional(),
    /** Milliseconds before the command runs again; it always does after a 401. */
    ttl: z.number().positive().optional(),
  }),
]);

export type HeaderSource = z.infer<typeof headerSourceSchema>;

export const upstreamSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("codex"), transport: z.enum(["ws", "http"]) }),
  z.strictObject({
    kind: z.literal("url"),
    // The URL that ends in /v1.
    baseUrl: z.url(),
    api: z.enum(["responses", "chat"]),
    transport: z.enum(["http", "ws"]),
    headers: z.array(headerSourceSchema),
    query: z.record(z.string(), z.string()),
  }),
]);

export type Upstream = z.infer<typeof upstreamSchema>;

const choiceSchema = z.strictObject({
  upstream: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1).optional(),
});

/** A profile's model on serve: an upstream, a model, and an effort. */
export type Choice = z.infer<typeof choiceSchema>;

export const modelConfigSchema = z.strictObject({
  version: z.literal(1),
  upstreams: z.record(z.string(), upstreamSchema),
  // What a profile with no model gets when rook reaches it: null after
  // `rook model off`, unset until rook finds one in Codex's configuration.
  default: choiceSchema.nullable().optional(),
  // Profiles `rook model off` took off serve, which rook leaves without one:
  // each by its verified email in lower case, or else its host id.
  off: z.array(z.string()),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;

/** An upstream and what a profile asks it for. */
export const selectionSchema = z.object({ upstream: upstreamSchema, choice: choiceSchema });
export type Selection = z.infer<typeof selectionSchema>;

const REDACTED = "<redacted>";

/** The config without literal header or query values, which may be credentials. */
export function redacted(config: ModelConfig): ModelConfig {
  const upstreams = Object.fromEntries(
    Object.entries(config.upstreams).map(([name, upstream]) => [name, redactedUpstream(upstream)]),
  );
  return { ...config, upstreams };
}

function redactedUpstream(upstream: Upstream): Upstream {
  if (upstream.kind === "codex") return upstream;
  const headers = upstream.headers.map((header) =>
    "value" in header ? { ...header, value: REDACTED } : header,
  );
  const query = Object.fromEntries(Object.keys(upstream.query).map((name) => [name, REDACTED]));
  return { ...upstream, headers, query };
}

export class SettingsError extends Data.TaggedError("SettingsError")<{
  operation: string;
  path: string;
  cause: unknown;
}> {
  readonly [Runtime.errorExitCode] = EXIT.failed;
  override get message() {
    return `${this.operation} ${this.path}: ${String(this.cause)}`;
  }
}

/** The released version-one model file. An update merges the latest read and
 * replaces the file atomically; callers serialise updates across processes
 * with `RookSessions.exclusive("model", …)`. */
export class ModelSettings extends Context.Service<
  ModelSettings,
  {
    readonly read: Effect.Effect<ModelConfig, SettingsError>;
    readonly update: (
      change: (latest: ModelConfig) => ModelConfig,
    ) => Effect.Effect<ModelConfig, SettingsError>;
  }
>()("rook/ModelSettings") {
  static readonly layer = Layer.effect(
    ModelSettings,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home } = yield* RookConfig;
      const file = path.join(home, MODEL_FILE);
      const failure = (operation: string) => (cause: unknown) =>
        new SettingsError({ operation, path: file, cause });
      const read = fs.readFileString(file).pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed('{"version":1,"upstreams":{},"off":[]}')
            : Effect.fail(failure("read")(error)),
        ),
        Effect.flatMap((text) =>
          Effect.try({
            try: () => modelConfigSchema.parse(JSON.parse(text)),
            // JSON.parse quotes the text it stopped in, which can be a header value.
            catch: (cause) =>
              failure("read")(cause instanceof SyntaxError ? "the file is not valid JSON" : cause),
          }),
        ),
      );
      const write = Effect.fnUntraced(
        function* (next: ModelConfig) {
          yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 });
          const temporary = yield* fs.makeTempFileScoped({ directory: home, prefix: "model-" });
          yield* fs.chmod(temporary, 0o600);
          yield* fs.writeFileString(temporary, `${JSON.stringify(next, null, 2)}\n`);
          yield* fs.rename(temporary, file).pipe(Effect.uninterruptible);
        },
        Effect.scoped,
        Effect.mapError(failure("write")),
      );
      const update = Effect.fnUntraced(function* (change: (latest: ModelConfig) => ModelConfig) {
        const latest = yield* read;
        const next = yield* Effect.try({
          try: () => modelConfigSchema.parse(change(latest)),
          catch: failure("update"),
        });
        yield* write(next);
        return next;
      });
      return { read, update };
    }),
  );
}
