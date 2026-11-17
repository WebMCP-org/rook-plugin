import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import {
  Config,
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Runtime,
  Tracer,
} from "effect";
import { Headers, HttpTraceContext } from "effect/http";
import { EXIT } from "./command.ts";
import { localRelayOrigin } from "./wire/relay.ts";

/** Tagged apart from Effect's own `ConfigError`, which the layer can also fail with. */
export class ConfigError extends Data.TaggedError("RookConfigError")<{
  readonly message: string;
  readonly cause: unknown;
}> {
  readonly [Runtime.errorExitCode] = EXIT.failed;
}

/** Process facts are captured once. Paths and environment reads do not leak
 * into the command handlers or connection owners. */
export class RookConfig extends Context.Service<
  RookConfig,
  {
    readonly home: string;
    readonly userHome: string;
    readonly codexHome: string;
    readonly relayOrigin: string;
    /** The loopback port `rook serve` binds; 0 asks the OS for one. */
    readonly relayPort: number;
    readonly noColor: boolean;
    readonly node: string;
    readonly entry: string;
    /** The caller's valid W3C TRACEPARENT and the span it names, the parent of the command's span. */
    readonly trace:
      | { readonly traceparent: string; readonly parent: Tracer.ExternalSpan }
      | undefined;
    readonly token: Effect.Effect<string, ConfigError>;
  }
>()("rook/RookConfig") {
  /** The trace context ask and run send to Rook: the command's own span while
   * it is exported, so Rook's spans hang from one the collector receives;
   * otherwise the caller's TRACEPARENT unchanged. */
  static readonly traceContext = Effect.gen(function* () {
    const { trace } = yield* RookConfig;
    const span = yield* Effect.option(Effect.currentSpan);
    if (
      (yield* Effect.tracer) === Tracer.nativeTracer ||
      Option.isNone(span) ||
      !span.value.sampled
    )
      return trace && { traceparent: trace.traceparent };
    return { traceparent: HttpTraceContext.toHeaders(span.value).traceparent! };
  });

  static readonly layer = Layer.effect(
    RookConfig,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userHome = homedir();
      const values = yield* Config.all({
        home: Config.String("ROOK_HOME").pipe(Config.withDefault(path.join(userHome, ".rook"))),
        codexHome: Config.String("CODEX_HOME").pipe(
          Config.withDefault(path.join(userHome, ".codex")),
        ),
        relayPort: Config.String("ROOK_RELAY_PORT").pipe(Config.option),
        noColor: Config.String("NO_COLOR").pipe(Config.option, Config.map(Option.isSome)),
        trace: Config.String("TRACEPARENT").pipe(
          Config.withDefault(""),
          Config.map((traceparent) =>
            Option.match(HttpTraceContext.w3c(Headers.fromInput({ traceparent })), {
              onNone: () => undefined,
              onSome: (parent) => ({ traceparent, parent }),
            }),
          ),
        ),
      });
      const relayOrigin = yield* Effect.try({
        try: () => localRelayOrigin(Option.getOrUndefined(values.relayPort)),
        catch: (cause) =>
          new ConfigError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      const tokenPath = path.join(values.home, "token");
      // The token appears with its content: written under a private name, then
      // hard-linked into place. A link that finds `token` lost a concurrent first run.
      const createToken = Effect.gen(function* () {
        const draft = path.join(values.home, `token.${randomBytes(6).toString("hex")}`);
        yield* fs
          .writeFileString(draft, randomBytes(32).toString("base64url"), {
            flag: "wx",
            mode: 0o600,
          })
          .pipe(
            Effect.andThen(fs.link(draft, tokenPath)),
            Effect.catchIf(
              (error) => error.reason._tag === "AlreadyExists",
              () => Effect.void,
            ),
            Effect.ensuring(fs.remove(draft, { force: true }).pipe(Effect.ignore)),
          );
      });
      const token = yield* Effect.gen(function* () {
        yield* fs.makeDirectory(values.home, { recursive: true, mode: 0o700 });
        if (!(yield* fs.exists(tokenPath))) yield* createToken;
        const text = (yield* fs.readFileString(tokenPath)).trim();
        // A rook released before the token was linked into place creates the
        // file and then writes it; one caught in between must not pass as a token.
        if (!text) return yield* Effect.fail("the token file is empty");
        return text;
      }).pipe(
        Effect.mapError(
          (cause) => new ConfigError({ message: "could not read the local relay token", cause }),
        ),
        Effect.cached,
      );
      return {
        ...values,
        userHome,
        token,
        relayOrigin,
        relayPort: Number(new URL(relayOrigin).port || "80"),
        node: process.execPath,
        entry: process.argv[1] ?? "rook",
      };
    }),
  );
}
