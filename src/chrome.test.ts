import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { chromeProfiles } from "./chrome";
import { ROOK_EXTENSION_IDS } from "./wire/contracts";

it("reads each Chrome profile's account and whether Rook is installed in it", () => {
  const root = mkdtempSync(join(tmpdir(), "rook-chrome-"));
  // Local State as Chrome writes it, trimmed to what rook reads.
  writeFileSync(
    join(root, "Local State"),
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Personal", user_name: "me@example.com" },
          "Profile 2": { name: "Work", user_name: "me@work.example" },
          "Profile 3": { name: "Guest-ish" },
        },
      },
    }),
  );
  mkdirSync(join(root, "Profile 2", "Extensions", ROOK_EXTENSION_IDS.production), {
    recursive: true,
  });
  // A staging build is Rook too.
  mkdirSync(join(root, "Default", "Extensions", ROOK_EXTENSION_IDS.staging), {
    recursive: true,
  });

  expect(chromeProfiles(root)).toEqual([
    { dir: "Default", email: "me@example.com", rook: true },
    { dir: "Profile 2", email: "me@work.example", rook: true },
    { dir: "Profile 3", email: "", rook: false },
  ]);
  expect(chromeProfiles(join(root, "missing"))).toEqual([]);
});
