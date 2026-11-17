// How concurrent `rook` processes share one detached `rook serve` (ADR 0092):
// the port bind elects it, an older one is replaced and a newer one kept, and
// every CLI waits out the daemon's own settle window. Real packed processes on
// an isolated port; profiles are stand-ins dialling the real relay.
import { type ChildProcess, spawn } from "node:child_process";
import type { ServerResponse } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };
import {
  daemonHome,
  freePort,
  listeners,
  olderServe,
  serveHeader,
  standIn,
  standInProfile,
  stopServe,
} from "./testing/daemon";
import { HOSTS_PATH, SERVE_HEADER } from "./serve";
import { fakePeer, opened } from "./testing/peer";
import { ROOK_EXTENSION_IDS } from "./wire/contracts";
import { LOCAL_RELAY_RECONNECT_MAX_MS } from "./wire/relay";

const DAEMON_TEST_MS = 40_000;
/** The daemon's settle window: the longest profile redial plus its margin. */
const SETTLE_MS = LOCAL_RELAY_RECONNECT_MAX_MS + 1_000;
const listing = z.array(z.object({ id: z.string() }).passthrough());
const ids = (stdout: string) =>
  stdout
    .trim()
    .split("\n")
    .map((line) => listing.element.parse(JSON.parse(line)).id)
    .sort();

// The first five tests each wait out a real settle window; they share no port
// or home, so they run at once.
it.concurrent(
  "elects one daemon when five CLIs start together with none running",
  async ({ expect, task }) => {
    const daemon = await daemonHome(task.timeout);
    const port = await freePort();
    const profile = standInProfile(port, "cold-profile");
    try {
      const runs = Array.from({ length: 5 }, () => daemon.start(port, "ls", "--json"));
      const results = await Promise.all(runs.map(({ result }) => result));
      for (const result of results) {
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
        expect(ids(result.stdout)).toEqual(["cold-profile"]);
      }
      // Exactly one CLI's own child wins the bind, and only that CLI says so.
      const started = results.filter(({ stderr }) => stderr.includes("started rook serve"));
      expect(started).toHaveLength(1);
      const token = await daemon.token();
      const header = await serveHeader(port, token);
      expect(header?.split(" ")[0]).toBe(packageJson.version);
      expect(await listeners(port)).toEqual([header?.split(" ")[1]]);
      const log = await daemon.log();
      expect(log).not.toMatch(/^\s+at /mu);
      const lines = log.trim().split("\n");
      const losers = lines.filter((line) => line.startsWith("rook:"));
      expect(lines.filter((line) => line.includes("listening on"))).toHaveLength(1);
      // Each losing daemon leaves exactly one line.
      expect(losers).toEqual(losers.map(() => `rook: port ${port} is already taken`));
      expect(await daemon.opened()).toBe("");
      await stopServe(port, token);
    } finally {
      profile.close();
      await stopServe(port, await daemon.token().catch(() => ""));
      await rm(daemon.home, { recursive: true, force: true });
    }
  },
  DAEMON_TEST_MS,
);

it.concurrent("uses a newer daemon and signals nothing", async ({ expect, task }) => {
  // The pid the newer stand-in advertises: a process this test owns.
  const owned = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
    stdio: "ignore",
  });
  const peer = await fakePeer({ version: "999.0.0", pid: () => owned.pid!, timeout: task.timeout });
  try {
    const result = await peer.start("ls", "--json").result;
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(ids(result.stdout)).toEqual(["lifecycle-profile"]);
    expect(result.stderr).not.toContain("stopped rook serve");
    expect(owned.exitCode).toBeNull();
    expect(owned.signalCode).toBeNull();
  } finally {
    owned.kill("SIGKILL");
    await peer.close();
  }
});

it.concurrent.for([1, 2])(
  "%i CLIs at once replace an older daemon and succeed against the replacement",
  { timeout: DAEMON_TEST_MS },
  async (count, { expect, task }) => {
    const daemon = await daemonHome(task.timeout);
    const port = await freePort();
    const older = await olderServe(port);
    const profile = standInProfile(port, "upgraded-profile");
    try {
      const runs = Array.from({ length: count }, () => daemon.start(port, "ls", "--json"));
      const results = await Promise.all(runs.map(({ result }) => result));
      for (const result of results) {
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
        expect(ids(result.stdout)).toEqual(["upgraded-profile"]);
      }
      expect(results.some(({ stderr }) => stderr.includes("stopped rook serve 0.0.1"))).toBe(true);
      await older.exited;
      expect(older.child.signalCode).toBe("SIGTERM");
      const header = await serveHeader(port, await daemon.token());
      expect(header?.split(" ")[0]).toBe(packageJson.version);
      expect(await daemon.opened()).toBe("");
    } finally {
      profile.close();
      await older.kill();
      await stopServe(port, await daemon.token().catch(() => ""));
      await rm(daemon.home, { recursive: true, force: true });
    }
  },
);

it.concurrent(
  "waits out a fresh daemon's settle window even when another process started it",
  async ({ expect, task }) => {
    const daemon = await daemonHome(task.timeout);
    const port = await freePort();
    const serve = daemon.start(port, "serve");
    const first = standInProfile(port, "first-profile");
    let second: ReturnType<typeof standInProfile> | undefined;
    try {
      // Ten other tests spawn their processes beside this one, so serve can
      // take longer than a poll's default second to start.
      await expect
        .poll(() => serve.stderr, { timeout: DAEMON_TEST_MS / 2 })
        .toContain("listening on");
      const token = await daemon.token();
      const hosts = () =>
        fetch(`http://127.0.0.1:${port}/hosts`, { headers: { authorization: `Bearer ${token}` } })
          .then((response) => response.json())
          .then((body) => listing.parse(body).map(({ id }) => id));
      await expect.poll(hosts).toEqual(["first-profile"]);
      const cli = daemon.start(port, "ls", "--json");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      second = standInProfile(port, "second-profile");
      const result = await cli.result;
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(ids(result.stdout)).toEqual(["first-profile", "second-profile"]);
      expect(result.stderr).not.toContain("started rook serve");
      // The window runs from the daemon's start, not each CLI's: once it has
      // passed, a later CLI trusts the host list at once.
      const startedAt = Date.now();
      const settled = await daemon.start(port, "ls", "--json").result;
      expect(settled, settled.stderr).toMatchObject({ code: 0, signal: null });
      expect(ids(settled.stdout)).toEqual(["first-profile", "second-profile"]);
      expect(Date.now() - startedAt).toBeLessThan(SETTLE_MS / 2);
    } finally {
      first.close();
      second?.close();
      serve.child.kill("SIGTERM");
      await serve.result;
      await rm(daemon.home, { recursive: true, force: true });
    }
  },
  DAEMON_TEST_MS,
);

/** Chrome's user data under a test HOME, as rook looks for it on this platform. */
const CHROME_USER_DATA =
  process.platform === "darwin"
    ? ["Library", "Application Support", "Google", "Chrome"]
    : [".config", "google-chrome"];

it.concurrent.for([true, false])(
  "four cold starts with Chrome closed open one Chrome window (Rook installed: %s)",
  { timeout: DAEMON_TEST_MS },
  async (installed, { expect, task }) => {
    const daemon = await daemonHome(task.timeout);
    const port = await freePort();
    const chrome = join(daemon.home, ...CHROME_USER_DATA);
    await mkdir(join(chrome, "Default"), { recursive: true });
    await writeFile(
      join(chrome, "Local State"),
      JSON.stringify({ profile: { info_cache: { Default: { user_name: "me@example.com" } } } }),
    );
    if (installed)
      await mkdir(join(chrome, "Default", "Extensions", ROOK_EXTENSION_IDS.production), {
        recursive: true,
      });
    let profile: ReturnType<typeof standInProfile> | undefined;
    try {
      const runs = Array.from({ length: 4 }, () => daemon.start(port, "model"));
      // The one window the stub launcher records; Rook in it then dials in.
      await expect.poll(daemon.opened, { timeout: DAEMON_TEST_MS / 2 }).not.toBe("");
      if (installed) profile = standInProfile(port, "opened-profile");
      const results = await Promise.all(runs.map(({ result }) => result));
      expect((await daemon.opened()).trim().split("\n")).toHaveLength(1);
      const stderr = results.map((result) => result.stderr);
      if (installed) {
        for (const result of results) expect(result, result.stderr).toMatchObject({ code: 0 });
        expect(stderr.filter((text) => text.includes("opened Chrome profile me@example.com")))
          .toHaveLength(1);
        expect(stderr.filter((text) => text.includes("another rook is opening Chrome")))
          .toHaveLength(3);
      } else {
        for (const result of results) expect(result, result.stderr).toMatchObject({ code: 5 });
        expect(stderr.filter((text) => text.includes(". Opened https://"))).toHaveLength(1);
        expect(stderr.filter((text) => text.includes("Another rook opened https://")))
          .toHaveLength(3);
      }
    } finally {
      profile?.close();
      await stopServe(port, await daemon.token().catch(() => ""));
      await rm(daemon.home, { recursive: true, force: true });
    }
  },
);

/** A process the test owns, for a stand-in daemon to advertise as its pid. */
const sleeper = () =>
  spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });

it.each<
  [string, (response: ServerResponse, pid: number) => void, number, (port: number) => string]
>([
  [
    "something other than rook serve answers on the port",
    (response) => response.writeHead(200, { "content-type": "application/json" }).end("[]"),
    5,
    (port) => `something other than rook serve answers on port ${port}`,
  ],
  [
    "the running daemon holds another token",
    (response) => response.writeHead(401).end(),
    4,
    () => "the running rook serve holds another token; stop it and retry",
  ],
  [
    "the daemon's host list is not a host list",
    (response, pid) =>
      response
        .writeHead(200, { [SERVE_HEADER]: `${packageJson.version} ${pid} ${Date.now()}` })
        .end('{"hosts":[]}'),
    5,
    () => "rook serve sent an unreadable host list",
  ],
])("fails when %s, starting, signalling and opening nothing", async (_, respond, code, message) => {
  const owned = sleeper();
  const requests: string[] = [];
  const server = await standIn((request, response) => {
    requests.push(request.url ?? "");
    respond(response, owned.pid!);
  });
  const daemon = await daemonHome();
  try {
    const result = await daemon.start(server.port, "ls").result;
    expect(result).toMatchObject({ code, signal: null, stdout: "" });
    expect(result.stderr).toContain(`rook: ${message(server.port)}`);
    expect(requests).toEqual([HOSTS_PATH]);
    expect(owned.exitCode ?? owned.signalCode).toBeNull();
    expect(await daemon.log()).toBe("");
    expect(await daemon.opened()).toBe("");
  } finally {
    owned.kill("SIGKILL");
    await server.close();
    await rm(daemon.home, { recursive: true, force: true });
  }
});

it("gives up after three stops when an older rook serve keeps coming back", async () => {
  // The stand-in advertises one sleeper at a time; each SIGTERM ends it and the
  // older serve "comes back" as the next one.
  const sleepers: ChildProcess[] = [];
  let ended = false;
  const next = () => {
    const child = sleeper();
    sleepers.push(child);
    child.once("exit", () => ended || next());
  };
  next();
  const peer = await fakePeer({ version: "0.0.1", pid: () => sleepers.at(-1)!.pid! });
  try {
    const result = await peer.start("ls").result;
    const port = new URL(peer.origin).port;
    expect(result).toMatchObject({ code: 5, signal: null, stdout: "" });
    expect(result.stderr).toContain(
      `rook: an older rook serve came back on port ${port} after 3 stops; update every installed rook, then run this again\n`,
    );
    expect(result.stderr.match(/stopped rook serve 0\.0\.1/gu)).toHaveLength(3);
    expect(sleepers.map(({ signalCode }) => signalCode)).toEqual([
      "SIGTERM",
      "SIGTERM",
      "SIGTERM",
      null,
    ]);
    expect(await opened(peer.home)).toBe("");
  } finally {
    ended = true;
    for (const child of sleepers) child.kill("SIGKILL");
    await peer.close();
  }
});
