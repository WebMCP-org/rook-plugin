// Chrome on this machine, for when no profile has dialed `rook serve`: which
// profiles exist, who each is signed in as, whether Rook is in it, and a way to
// open one. Only Chrome's profile list in Local State and the presence of
// Rook's Extensions/<id> folder are read.
import { Context, Effect, FileSystem, Layer, Path, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { RookConfig } from "./config";
import { z } from "zod";
import { ROOK_EXTENSION_IDS } from "./wire/contracts";

const ROOK_IDS = Object.values(ROOK_EXTENSION_IDS);
export const STORE_URL = `https://chromewebstore.google.com/detail/${ROOK_EXTENSION_IDS.production}`;

// ponytail: stable Google Chrome on macOS and Linux. Elsewhere, and for Beta,
// Canary or Chromium, rook finds no profile, opens the store page in the
// default browser and says what to do; add their user-data paths if needed.
const USER_DATA =
  process.platform === "darwin"
    ? "Library/Application Support/Google/Chrome"
    : process.platform === "linux"
      ? ".config/google-chrome"
      : undefined;

const localStateSchema = z.object({
  profile: z.object({
    info_cache: z.record(z.string(), z.object({ user_name: z.string().optional() })),
  }),
});

export type ChromeProfile = {
  /** The profile directory, which `--profile-directory` takes. */
  dir: string;
  /** The Google account the profile is signed in to, or "". */
  email: string;
  rook: boolean;
};

const make = Effect.fnUntraced(function* (userData: string | undefined) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* RookConfig;
  const directory = userData ?? (USER_DATA && path.join(config.userHome, USER_DATA));

  // Chrome absent, unreadable, or still writing Local State all mean no
  // profile: discovery then asks the desktop to open one.
  const readProfiles = Effect.fnUntraced(
    function* (directory: string) {
      const text = yield* fs.readFileString(path.join(directory, "Local State"));
      const state = yield* Effect.try(() => localStateSchema.parse(JSON.parse(text)));
      return yield* Effect.forEach(
        Object.entries(state.profile.info_cache),
        Effect.fnUntraced(function* ([dir, info]) {
          const installed = yield* Effect.forEach(ROOK_IDS, (id) =>
            fs.exists(path.join(directory, dir, "Extensions", id)),
          );
          const profile: ChromeProfile = {
            dir,
            email: info.user_name ?? "",
            rook: installed.some(Boolean),
          };
          return profile;
        }),
      );
    },
    Effect.catch(() => Effect.succeed<ChromeProfile[]>([])),
  );
  const profiles = directory ? readProfiles(directory) : Effect.succeed([]);

  // unref explicitly hands ownership to the desktop; the platform spawner then
  // leaves this browser alive when the command scope closes.
  const launch = Effect.fnUntraced(
    function* (command: string, args: string[]) {
      const child = yield* ChildProcess.make(command, args, {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      yield* child.unref;
    },
    Effect.catchTag("PlatformError", () => Effect.void),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );

  const open = (options: { profile?: string; url?: string }) => {
    const args = [
      ...(options.profile ? [`--profile-directory=${options.profile}`] : []),
      ...(options.url ? [options.url] : []),
    ];
    if (process.platform === "darwin") {
      // -n hands the arguments to a running Chrome, which plain `open -a` drops.
      const background = options.url ? [] : ["-g"];
      return launch(
        "open",
        [...background, ...(args.length ? ["-n"] : []), "-a", "Google Chrome"].concat(
          args.length ? ["--args", ...args] : [],
        ),
      );
    }
    if (process.platform === "linux") return launch("google-chrome", args);
    return Effect.void;
  };

  const openUrl = (url: string) => {
    if (process.platform === "darwin") return launch("open", [url]);
    if (process.platform === "win32") return launch("explorer.exe", [url]);
    return launch("xdg-open", [url]);
  };

  return { profiles, open, openUrl };
});

/** This machine's Chrome: its profiles, and launching it. */
export class Chrome extends Context.Service<
  Chrome,
  {
    /** Every Chrome profile, or none when Chrome is not installed here. */
    readonly profiles: Effect.Effect<ChromeProfile[]>;
    /** Opens Chrome, in `profile` and at `url` when given. A URL comes to the
     * front, since it waits on the user; a running Chrome takes the request over. */
    readonly open: (options: {
      profile?: string;
      url?: string;
    }) => Effect.Effect<void, never, Scope.Scope>;
    /** Opens a URL in the default browser, when no Chrome profile was found. */
    readonly openUrl: (url: string) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("rook/Chrome") {
  static readonly layer = Layer.effect(Chrome, make(undefined));
  /** Chrome whose user-data directory is `userData` instead of this platform's. */
  static readonly layerAt = (userData: string) => Layer.effect(Chrome, make(userData));
}
