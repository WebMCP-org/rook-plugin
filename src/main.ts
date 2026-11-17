#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Cause,
  Config,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Runtime,
  Stdio,
  Stream,
  Tracer,
} from "effect";
import { CliConfig, CliError, CliOutput, Command, GlobalFlag } from "effect/cli";
import { OtlpSerialization, OtlpTracer } from "effect/observability";
import packageJson from "../package.json" with { type: "json" };
import { Chrome } from "./chrome";
import { rook } from "./cli";
import { EXIT } from "./command";
import { RookConfig } from "./config";
import { ModelSettings } from "./model-settings";
import { CliSession, finishOutput, startupError } from "./output";
import { RookSessions } from "./session";

/** Exported spans keep names, timing, parentage and error status. A failure's
 * message and stack can hold an email, a thread id or text relayed from Chrome. */
const withoutMessages = (tracer: Tracer.Tracer): Tracer.Tracer =>
  tracer === Tracer.nativeTracer
    ? tracer
    : Tracer.make({
        context: tracer.context,
        span(options) {
          const span = tracer.span(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause))
              return end(endTime, exit);
            const error = Cause.squash(exit.cause);
            end(
              endTime,
              Exit.fail({ name: error instanceof Error ? error.name : "Error", message: "" }),
            );
          };
          return span;
        },
      });

// ponytail: Effect exports only when OTEL_TRACES_EXPORTER names otlp, narrower
// than the spec's default. A CLI inherits its caller's environment, whose OTLP
// settings are often that caller's own metrics and logs, frequently over gRPC.
const tracing = Effect.gen(function* () {
  // Unasked, no other OTEL_* value is read: those belong to the caller.
  const exporters = yield* Config.String("OTEL_TRACES_EXPORTER").pipe(Config.withDefault(""));
  if (!exporters.toLowerCase().includes("otlp")) return Layer.empty;
  const protocol = yield* Config.String("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL").pipe(
    Config.orElse(() => Config.String("OTEL_EXPORTER_OTLP_PROTOCOL")),
    Config.withDefault("http/protobuf"),
  );
  // Effect has no gRPC exporter.
  const serialization =
    protocol === "http/json"
      ? OtlpSerialization.layerJson
      : protocol === "http/protobuf"
        ? OtlpSerialization.layerProtobuf
        : undefined;
  if (!serialization) return Layer.empty;
  return Layer.effect(Tracer.Tracer)(Effect.map(Effect.tracer, withoutMessages)).pipe(
    Layer.provideMerge(
      OtlpTracer.layerFromConfig({
        resource: { serviceName: "rook", serviceVersion: packageJson.version },
      }),
    ),
    Layer.provide(serialization),
  );
}).pipe(
  Layer.unwrap,
  // The flush at exit waits at most a second unless an OTLP timeout says otherwise.
  Layer.provide(
    ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ OTEL_BSP_EXPORT_TIMEOUT: "1000" })),
  ),
  // Telemetry never fails a command: a malformed OTEL_* value turns it off and says so.
  Layer.catchCause((cause) =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const stdio = yield* Stdio.Stdio;
        const error = Cause.squash(cause);
        const reason = (error instanceof Error ? error.message : String(error)).replace(
          /\s+/g,
          " ",
        );
        yield* Stream.make(`rook: tracing is off: ${reason}\n`).pipe(
          Stream.run(stdio.stderr()),
          Effect.ignore,
        );
      }),
    ),
  ),
);

const platform = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp);
const local = Layer.mergeAll(CliSession.layer, ModelSettings.layer, Chrome.layer).pipe(
  Layer.provideMerge(RookConfig.layer),
);
const application = RookSessions.layer.pipe(Layer.provideMerge(local));

// NodeRuntime owns interruption and shutdown. Its interrupt carries no signal
// name, so record only that process fact to retain the CLI's 130/143 contract.
let signalCode: number | undefined;
const signalInt = () => {
  signalCode = 130;
};
const signalTerm = () => {
  signalCode = 143;
};

/** Parser failures render like every other failure: one `rook: <message>`. */
const usageMessage = (error: CliError.CliError) =>
  error._tag === "ShowHelp" ? error.errors.map(({ message }) => message).join("\n") : error.message;

const program = Effect.gen(function* () {
  const output = yield* CliSession;
  const config = yield* RookConfig;
  const formatter = CliOutput.defaultFormatter({ colors: output.tty.stdout && !config.noColor });
  // Help and version go through CliSession like every other write; invalid
  // invocations are rendered once, by the failure handler below.
  const presenter: CliOutput.Presenter = {
    present: (event) => {
      if (event._tag === "Version")
        return output
          .stdout(`rook ${packageJson.version} (${packageJson.name})\n`)
          .pipe(Effect.orDie);
      if (event._tag === "Help")
        return output.stdout(`${formatter.formatHelpDoc(event.helpDoc)}\n`).pipe(Effect.orDie);
      return Effect.void;
    },
  };
  return yield* Command.run(rook, { version: packageJson.version }).pipe(
    Effect.provideService(CliOutput.Presenter, presenter),
    Effect.provideService(
      CliConfig.CliConfig,
      CliConfig.make({ builtIns: [GlobalFlag.Version, GlobalFlag.Help] }),
    ),
    Effect.scoped,
    config.trace ? Effect.withParentSpan(config.trace.parent) : (effect) => effect,
    Effect.catch((error) => {
      if (!CliError.isCliError(error))
        return output.error(error.message, Runtime.getErrorExitCode(error));
      if (error._tag === "ShowHelp" && !error.errors.length) return output.finish(EXIT.usage);
      return output.error(usageMessage(error), EXIT.usage);
    }),
    Effect.onInterrupt(() => output.abandon(signalCode ?? 130).pipe(Effect.orDie)),
    Effect.andThen(output.status),
  );
}).pipe(
  Effect.provide(application),
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause) ? Effect.interrupt : startupError(Cause.squash(cause)),
  ),
  // Output finishes before the tracing layer's scope closes, which flushes spans.
  Effect.ensuring(finishOutput.pipe(Effect.orDie)),
  Effect.provide(Layer.provideMerge(tracing, platform)),
);

if (import.meta.main) {
  process.prependListener("SIGINT", signalInt);
  process.prependListener("SIGTERM", signalTerm);
  NodeRuntime.runMain(program, {
    disableErrorReporting: true,
    teardown: (exit, done) => {
      process.removeListener("SIGINT", signalInt);
      process.removeListener("SIGTERM", signalTerm);
      if (Exit.isFailure(exit))
        return done(
          Cause.hasInterrupts(exit.cause)
            ? (signalCode ?? 130)
            : Runtime.getErrorExitCode(Cause.squash(exit.cause)),
        );
      // SAFETY: Teardown is generic over the exit value; program succeeds only with its exit code.
      done(exit.value as number);
    },
  });
}
