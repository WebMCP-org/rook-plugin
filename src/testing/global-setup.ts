// Packs the CLI once per test run, in the published package layout (bin/rook
// beside guide.md and skills/), so every process test spawns the same build.
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** A temporary package root holding the packed `bin/rook`, `guide.md` and `skills/`. */
    rookPackage: string;
  }
}

export default async function setup(project: TestProject) {
  const source = fileURLToPath(new URL("../..", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "rook-cli-package-"));
  await promisify(execFile)("vp", ["pack", "--out-dir", join(directory, "bin")], {
    cwd: source,
    maxBuffer: 10 * 1024 * 1024,
  });
  await cp(join(source, "skills"), join(directory, "skills"), { recursive: true });
  await cp(join(source, "guide.md"), join(directory, "guide.md"));
  project.provide("rookPackage", directory);
  return () => rm(directory, { recursive: true, force: true });
}
