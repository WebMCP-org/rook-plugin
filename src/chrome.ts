// Chrome on this machine, for when no profile has dialed `rook serve`: which
// profiles exist, who each is signed in as, whether Rook is in it, and a way to
// open one. Only Chrome's profile list in Local State and the presence of
// Rook's Extensions/<id> folder are read.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

/** Every Chrome profile, or none when Chrome is not installed here. */
export function chromeProfiles(root = USER_DATA && join(homedir(), USER_DATA)): ChromeProfile[] {
  if (!root) return [];
  let localState: unknown;
  try {
    localState = JSON.parse(readFileSync(join(root, "Local State"), "utf8"));
  } catch {
    return [];
  }
  const parsed = localStateSchema.safeParse(localState);
  if (!parsed.success) return [];
  return Object.entries(parsed.data.profile.info_cache).map(([dir, info]) => ({
    dir,
    email: info.user_name ?? "",
    rook: ROOK_IDS.some((id) => existsSync(join(root, dir, "Extensions", id))),
  }));
}

/** Opens Chrome, in `profile` and at `url` when given. A URL comes to the
 * front, since it waits on the user; a running Chrome takes the request over. */
export function openChrome(options: { profile?: string; url?: string }): void {
  const args = [
    ...(options.profile ? [`--profile-directory=${options.profile}`] : []),
    ...(options.url ? [options.url] : []),
  ];
  if (process.platform === "darwin") {
    // -n hands the arguments to a running Chrome, which plain `open -a` drops.
    const background = options.url ? [] : ["-g"];
    launch(
      "open",
      [...background, ...(args.length ? ["-n"] : []), "-a", "Google Chrome"].concat(
        args.length ? ["--args", ...args] : [],
      ),
    );
  } else if (process.platform === "linux") {
    launch("google-chrome", args);
  }
}

/** Opens a URL in the default browser, when no Chrome profile was found. */
export function openUrl(url: string): void {
  if (process.platform === "darwin") launch("open", [url]);
  else if (process.platform === "win32") launch("explorer.exe", [url]);
  else launch("xdg-open", [url]);
}

// No shell, as @mcp-b/webmcp-local-relay's webmcp_open_page. Detached, because
// on Linux the launched process may be Chrome itself.
function launch(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  // A missing browser only means the user opens it; rook's message says what.
  child.on("error", () => {});
  child.unref();
}
