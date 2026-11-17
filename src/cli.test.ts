import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };
import { freePort, stopServe } from "./testing/daemon";
import { rookBinary, rookEnv, rookPackage, stubBrowsers, watchdogMs } from "./testing/peer";

const directory = rookPackage();
const binary = rookBinary();

// Every case here should end before discovery. Should one reach it, it finds a
// throwaway home, a relay port nothing listens on, and only browser stubs on
// PATH; whatever daemon it started is stopped after the file.
let home: string;
let port: number;
beforeAll(async () => {
  home = await stubBrowsers(await mkdtemp(join(tmpdir(), "rook-cli-")));
  port = await freePort();
});
afterAll(async () => {
  const token = await readFile(join(home, "token"), "utf8").catch(() => "");
  await stopServe(port, token.trim());
  await rm(home, { recursive: true, force: true });
});

async function processResult(
  command: string,
  args: string[],
  cwd: string,
  options: { env?: Record<string, string> } = {},
) {
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...rookEnv(home, port), ...options.env },
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), watchdogMs());
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(watchdog);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

const cli = (args: string[]) => processResult(process.execPath, [binary, ...args], directory);

it("prints the published version for both version forms", async () => {
  for (const flag of ["--version", "-v"]) {
    const result = await cli([flag]);
    expect(result).toMatchObject({
      code: 0,
      signal: null,
      stdout: `rook ${packageJson.version} (${packageJson.name})\n`,
      stderr: "",
    });
  }
});

it("shows commands on help and returns usage status when no command was supplied", async () => {
  for (const args of [["--help"], ["-h"], []]) {
    const result = await cli(args);
    expect(result.code).toBe(args.length ? 0 : 2);
    expect(result.signal).toBeNull();
    for (const command of [
      "ask",
      "wait",
      "show",
      "stop",
      "rm",
      "rename",
      "bash",
      "run",
      "tools",
      "call",
      "model",
      "serve",
      "guide",
    ]) {
      // Each subcommand is listed on its own line with its description.
      expect(result.stdout).toMatch(new RegExp(`^  ${command} +\\S`, "mu"));
    }
  }
});

it("prints this version's guide and the skill that points at it from the standalone package layout", async () => {
  const guide = await cli(["guide"]);
  expect(guide).toMatchObject({ code: 0, signal: null, stderr: "" });
  expect(guide.stdout).toBe(
    `# rook guide (rook ${packageJson.version})\n\n${await readFile(join(directory, "guide.md"), "utf8")}`,
  );
  const skill = await cli(["skill", "print"]);
  expect(skill).toMatchObject({ code: 0, signal: null, stderr: "" });
  expect(skill.stdout).toBe(
    await readFile(join(directory, "skills", "rook-browser", "SKILL.md"), "utf8"),
  );
});

const errorEvent = z.object({
  v: z.literal(1),
  ts: z.iso.datetime(),
  type: z.literal("error"),
  exit: z.literal(2),
  message: z.string().min(1),
});

it.each([
  ["unknown-command", "--json"],
  ["--unknown-flag", "--json"],
  ["ask", "--json"],
  ["wait", "--json"],
  ["call", "echo", "--args", "{broken", "--json"],
  ["run", "/automations/example.ts", "--args", "[]", "--json"],
])("keeps JSON usage failures machine-readable: %s", async (...args) => {
  const result = await cli(args);
  expect(result).toMatchObject({ code: 2, signal: null, stderr: "" });
  const lines = result.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(errorEvent.safeParse(JSON.parse(lines[0]!)).success).toBe(true);
});

it("describes model configuration through the declarative command help without probing", async () => {
  const overview = await cli(["model", "-h"]);
  expect(overview).toMatchObject({ code: 0, signal: null, stderr: "" });
  for (const description of ["codex", "url", "off", "secrets redacted"]) {
    expect(overview.stdout.replace(/\s+/gu, " ")).toContain(description);
  }
  const help = async (command: string) => {
    const result = await cli(["model", command, "--help"]);
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    return result.stdout.replace(/\s+/gu, " ");
  };
  const shared = ["test request", "default for first use", "--model", "--effort", "--transport"];
  const urlOnly = [
    "--api",
    "--header",
    "--header-env",
    "--header-cmd",
    "--header-ttl",
    "Repeatable",
    "401",
    "90s",
    "Defaults to http",
  ];
  const codex = await help("codex");
  for (const description of [...shared, "Defaults to ws"]) expect(codex).toContain(description);
  // Codex's sign-in carries its own endpoint and headers, so those flags are not its flags.
  for (const flag of ["--api", "--header"]) expect(codex).not.toContain(flag);
  const url = await help("url");
  for (const description of [...shared, ...urlOnly]) expect(url).toContain(description);
  const off = await cli(["model", "off", "--help"]);
  expect(off).toMatchObject({ code: 0, signal: null, stderr: "" });
  expect(off.stdout.replace(/\s+/gu, " ")).toContain("disable first-use model adoption");
});

it("renders startup configuration failures before application services exist", async () => {
  const result = await processResult(process.execPath, [binary, "ls", "--json"], directory, {
    env: { ROOK_RELAY_PORT: "invalid" },
  });
  expect(result).toMatchObject({ code: 1, signal: null, stderr: "" });
  const parsed = errorEvent.extend({ exit: z.literal(1) }).parse(JSON.parse(result.stdout));
  expect(parsed.message).toContain("ROOK_RELAY_PORT");
});

it.each([
  [["unknown-command"], 'rook: Unknown subcommand "unknown-command" for "rook"\n'],
  [
    ["ask", "--timeout", "xyz", "hi"],
    'rook: Invalid value for flag --timeout: "xyz". Expected: a duration such as 90s, 5m or 1h\n',
  ],
  [["wait"], "rook: Missing required argument: ID\n"],
  [["tools", "--tab", "x"], expect.stringMatching(/^rook: Invalid value for flag --tab: "x"\./u)],
])("renders a usage error as one rook: line: %j", async (args, stderr) => {
  const result = await cli(args);
  expect(result).toMatchObject({ code: 2, signal: null, stdout: "", stderr });
});

it("describes every subcommand in the top-level help", async () => {
  const result = await cli(["--help"]);
  expect(result.code).toBe(0);
  const listing = result.stdout.split("SUBCOMMANDS\n")[1]?.split("\n\n")[0] ?? "";
  const lines = listing.split("\n").filter((line) => line.trim());
  expect(lines.length).toBeGreaterThanOrEqual(13);
  for (const line of lines) expect(line).toMatch(/^\s+\S+\s{2,}\S/u);
});
