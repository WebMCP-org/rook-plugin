import { Config, Data, Option, Runtime } from "effect";
import { Command, Flag } from "effect/cli";

/** Public shell statuses; bash may also return its script's own status. */
export const EXIT = {
  done: 0,
  failed: 1,
  usage: 2,
  needsHuman: 3,
  token: 4,
  unavailable: 5,
  stopped: 6,
  running: 124,
} as const;

/** Expected command failures carry their shell contract in the error channel. */
export class CommandError extends Data.TaggedError("CommandError")<{
  readonly code: number;
  readonly message: string;
  readonly cause?: unknown;
}> {
  /** The caller asked for something the command cannot do as given. */
  static usage(message: string) {
    return new CommandError({ code: EXIT.usage, message });
  }
  /** The relay, a profile, or Rook in it could not be reached or is too old. */
  static unavailable(message: string, cause?: unknown) {
    return new CommandError({ code: EXIT.unavailable, message, cause });
  }
  /** The work was attempted and did not succeed. */
  static failed(message: string, cause?: unknown) {
    return new CommandError({ code: EXIT.failed, message, cause });
  }
  get [Runtime.errorExitCode]() {
    return this.code;
  }
}

/** A string flag that may be omitted. */
export const optional = (name: string) =>
  Flag.String(name).pipe(Flag.optional, Flag.map(Option.getOrUndefined));

/** A switch that is off unless given. */
export const boolean = (name: string) => Flag.Boolean(name).pipe(Flag.withDefault(false));

/** Rook's own duration grammar (`90s`, `5m`, `1h`, `700ms`; a bare number is
 * seconds), which differs from Effect's duration strings. */
function milliseconds(value: string): Option.Option<number> {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/u.exec(value);
  if (!match) return Option.none();
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] ?? "s"] ?? 1_000;
  return Option.some(Number(match[1]) * unit);
}

/** An optional duration flag, parsed to milliseconds. */
export const duration = (name: string) =>
  Flag.String(name).pipe(
    Flag.filterMap(milliseconds, () => "a duration such as 90s, 5m or 1h"),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  );

/** Shared flags are parsed once and are accepted before or after a command. */
export const rootCommand = Command.make("rook").pipe(
  Command.withSharedFlags({
    profile: Flag.String("profile").pipe(
      Flag.withDescription(
        "Chrome profile email or host-id prefix; defaults to ROOK_PROFILE, or the only connected profile",
      ),
      Flag.withFallbackConfig(Config.String("ROOK_PROFILE")),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Write newline-delimited JSON for programs"),
    ),
  }),
);
