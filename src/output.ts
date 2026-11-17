import { createHash } from "node:crypto";
import {
  Context,
  Data,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Runtime,
  Stdio,
  Stream,
} from "effect";
import type { FileUIPart, UIMessage } from "ai";
import type { WorkspaceExecutionResult } from "./wire/contracts";
import { RookConfig } from "./config";
import { CommandError, EXIT } from "./command";

export type Status = "completed" | "failed" | "stopped" | "needs_human" | "running";
type RookEvent =
  | {
      type: "run.started";
      profile: { id: string; label: string };
      new: boolean;
      /** The message waits for the turn already running in the thread. */
      queued: boolean;
      /** An earlier ask already submitted this id; this one reports that submission. */
      repeat: boolean;
      /** The message's Think submission id. */
      message: string;
    }
  | { type: "message"; role?: UIMessage["role"]; text: string; files?: string[] }
  | { type: "tool"; name: string }
  | { type: "needs_human"; reason: string; tab: number; expiresAt: string }
  | { type: "error"; code: string; message?: string }
  | { type: "error"; exit: number; message: string }
  | { type: "result"; status: Status; exit: number; text: string; files: string[] }
  /** `rook show`'s last line: how the thread's latest turn stands, and why it failed. */
  | { type: "status"; status: Status; detail?: string }
  | ({ type: "execution"; exit: number } & WorkspaceExecutionResult);

/** The outer platform boundary also renders configuration/layer failures,
 * before the configured CliSession service can be constructed. */
export const startupError = Effect.fnUntraced(function* (cause: unknown) {
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = Runtime.getErrorExitCode(cause);
  const machine = args.includes("--json");
  const ts = DateTime.formatIso(yield* DateTime.now);
  const text = machine
    ? `${JSON.stringify({ v: 1, ts, type: "error", exit: code, message })}\n`
    : `rook: ${message}\n`;
  yield* Stream.make(text).pipe(Stream.run(machine ? stdio.stdout() : stdio.stderr()));
  return code;
});

/** Individual writes keep stdout open. The final sink completion waits for
 * queued bytes before NodeRuntime may force a nonzero or signal exit. */
export const finishOutput = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  yield* Stream.empty.pipe(
    Stream.run(stdio.stdout({ endOnDone: true })),
    Effect.ensuring(Stream.empty.pipe(Stream.run(stdio.stderr({ endOnDone: true })), Effect.orDie)),
  );
});

export class OutputError extends Data.TaggedError("OutputError")<{
  readonly message: string;
  readonly cause: unknown;
}> {
  readonly [Runtime.errorExitCode] = EXIT.failed;
}

type Write = Effect.Effect<void, OutputError>;
type ResumeReport = (code: number) => Write;

/** One invocation owns its output protocol and completion state. Stdio sinks
 * apply backpressure and complete writes before the process runner exits. */
export class CliSession extends Context.Service<
  CliSession,
  {
    readonly stdout: (text: string) => Write;
    readonly stderr: (text: string) => Write;
    readonly input: Effect.Effect<string, OutputError>;
    readonly tty: { readonly stdin: boolean; readonly stdout: boolean; readonly stderr: boolean };
    readonly machine: boolean;
    readonly configure: (options: { readonly json: boolean }) => Effect.Effect<void>;
    readonly dim: (text: string) => string;
    readonly json: (thread: string | undefined, event: RookEvent) => Write;
    readonly saveFiles: (
      id: string,
      files: readonly FileUIPart[],
    ) => Effect.Effect<string[], OutputError>;
    readonly error: (message: string, code: number) => Write;
    readonly finish: (code: number) => Effect.Effect<void>;
    readonly status: Effect.Effect<number>;
    readonly remember: (report: ResumeReport) => Effect.Effect<void>;
    readonly abandon: (code: number) => Effect.Effect<void, OutputError | CommandError>;
  }
>()("rook/CliSession") {
  static readonly layer = Layer.effect(
    CliSession,
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* RookConfig;
      const args = yield* stdio.args;
      // Parsing failures still honor the released --json diagnostic switch.
      // Successful parsing replaces this bootstrap value through configure.
      let machine = args.includes("--json");
      const tty = yield* Effect.all({
        stdin: stdio.stdinIsTerminal,
        stdout: stdio.stdoutIsTerminal,
        stderr: stdio.stderrIsTerminal,
      });
      const code = yield* Ref.make<number>(EXIT.done);
      const resumable = yield* Ref.make<ResumeReport | undefined>(undefined);
      const write = (sink: "stdout" | "stderr") => (text: string) =>
        Stream.make(text).pipe(
          Stream.run(stdio[sink]()),
          Effect.mapError((cause) => new OutputError({ message: `could not write ${sink}`, cause })),
        );
      const stdout = write("stdout");
      const stderr = write("stderr");
      const finish = Effect.fnUntraced(function* (value: number) {
        yield* Ref.set(resumable, undefined);
        yield* Ref.set(code, value);
      });
      const json = Effect.fnUntraced(function* (thread: string | undefined, event: RookEvent) {
        const ts = DateTime.formatIso(yield* DateTime.now);
        yield* stdout(`${JSON.stringify({ v: 1, ts, thread, ...event })}\n`);
      });
      const error = Effect.fnUntraced(function* (message: string, exit: number) {
        if (machine) yield* json(undefined, { type: "error", exit, message });
        else yield* stderr(`rook: ${message}\n`);
        yield* finish(exit);
      });
      // Every reply in a thread saves into one folder, so a file with no name
      // is named by its content, and a name another file holds gains the hash.
      const saveFiles = (id: string, files: readonly FileUIPart[]) =>
        Effect.forEach(files, (file) => {
          const data = /^data:[^,]*;base64,(.*)$/su.exec(file.url)?.[1];
          if (data === undefined) return Effect.succeed(file.url);
          const bytes = Buffer.from(data, "base64");
          const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
          const extension = /^[\w.+-]+\/([\w]+)/u.exec(file.mediaType)?.[1] ?? "bin";
          const dir = path.join(config.home, "files", id);
          const { name, ext } = path.parse(path.basename(file.filename || `${hash}.${extension}`));
          return Effect.gen(function* () {
            yield* fs.makeDirectory(dir, { recursive: true });
            const held = yield* fs.readFile(path.join(dir, `${name}${ext}`)).pipe(Effect.option);
            const other = Option.isSome(held) && !bytes.equals(held.value);
            const filename = path.join(dir, other ? `${name}-${hash}${ext}` : `${name}${ext}`);
            yield* fs.writeFile(filename, bytes);
            return filename;
          });
        }).pipe(
          Effect.mapError(
            (cause) => new OutputError({ message: "could not save reply files", cause }),
          ),
        );
      return {
        stdout,
        stderr,
        tty,
        get machine() {
          return machine;
        },
        configure: (options: { readonly json: boolean }) =>
          Effect.sync(() => {
            machine = options.json;
          }),
        json,
        saveFiles,
        error,
        finish,
        dim: (text: string) => (tty.stderr && !config.noColor ? `\x1b[2m${text}\x1b[0m` : text),
        input: stdio.stdin.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (all, chunk) => all + chunk,
          ),
          Effect.mapError((cause) => new OutputError({ message: "could not read stdin", cause })),
        ),
        status: Ref.get(code),
        remember: (report: ResumeReport) => Ref.set(resumable, report),
        abandon: Effect.fnUntraced(function* (exit: number) {
          const report = yield* Ref.getAndSet(resumable, undefined);
          if (report) return yield* report(exit);
          if (exit === EXIT.running)
            return yield* CommandError.unavailable("timed out before a Chrome profile answered");
          yield* Ref.set(code, exit);
        }),
      };
    }),
  );
}
