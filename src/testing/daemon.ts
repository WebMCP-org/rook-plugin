// Fixtures for the daemon lane: real `rook serve` processes on an isolated
// port, stand-in Chrome profiles that dial them the way Rook does, and an
// older-version daemon stand-in the test owns. Every rook process here goes
// through `spawnRook`, so it gets a fresh HOME and a PATH holding only stubs for
// the browser launchers.
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer as createHttpServer, type RequestListener } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { z } from "zod";
import { HOSTS_PATH, SERVE_HEADER } from "../serve";
import { ROOK_EXTENSION_IDS, type RookDirectoryState } from "../wire/contracts";
import {
  CONTROL_PATH,
  CONTROL_SUBPROTOCOL,
  encodeLocalHostProtocol,
  encodeTunnelIdProtocol,
  relayControlMessageSchema,
  TUNNEL_PATH,
  TUNNEL_SUBPROTOCOL,
} from "../wire/relay";
import { opened, spawnRook, stubBrowsers } from "./peer";

const EXTENSION = `chrome-extension://${ROOK_EXTENSION_IDS.staging}`;
const REDIAL_MS = 100;

/** Ports `freePort` handed out; only these may have their listeners killed. */
const allocated = new Set<number>();

/** A loopback port nothing listens on right now, from the OS's ephemeral range. */
export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = z.object({ port: z.number().int().positive() }).parse(server.address());
  await new Promise<void>((resolve) => server.close(() => resolve()));
  allocated.add(port);
  return port;
}

/** The pids, other than this runner's, listening on a port `freePort` handed out. */
export async function listeners(port: number) {
  if (!allocated.has(port)) throw new Error(`port ${port} was not allocated by this test run`);
  const { stdout } = await promisify(execFile)("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ]).catch(() => ({ stdout: "" }));
  return stdout
    .trim()
    .split("\n")
    .filter((pid) => pid && pid !== String(process.pid));
}

/** A ROOK_HOME (no token yet) whose processes reach no real browser;
 * `timeout` is the spawning test's, as `watchdogMs` takes it. */
export async function daemonHome(timeout?: number) {
  const home = await stubBrowsers(await mkdtemp(join(tmpdir(), "rook-daemon-")));
  return {
    home,
    /** Spawns the packed rook against this home and `port`. */
    start: (port: number, ...args: string[]) => spawnRook(home, port, args, false, timeout),
    /** Browser launches the CLI attempted; a passing test leaves this empty. */
    opened: () => opened(home),
    log: () => readFile(join(home, "serve.log"), "utf8").catch(() => ""),
    token: () => readFile(join(home, "token"), "utf8").then((token) => token.trim()),
  };
}

/** The `rook-serve` header of whatever answers `port`, or undefined. */
export async function serveHeader(port: number, token: string) {
  const response = await fetch(`http://127.0.0.1:${port}${HOSTS_PATH}`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => undefined);
  await response?.body?.cancel();
  return response?.headers.get(SERVE_HEADER) ?? undefined;
}

const STOP_MS = 5_000;

/** SIGTERMs the rook serve answering `port` with this home's token, and waits
 * for the port to go quiet. The token proves the daemon serves this test's home.
 * One still listening after STOP_MS is SIGKILLed by the port `freePort` gave it,
 * so a test that times out strands no detached daemon. */
export async function stopServe(port: number, token: string) {
  const header = await serveHeader(port, token);
  if (!header) return;
  const pid = Number(header.split(" ")[1]);
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  const deadline = Date.now() + STOP_MS;
  while (await serveHeader(port, token)) {
    if (Date.now() > deadline) {
      for (const listener of await listeners(port)) {
        try {
          process.kill(Number(listener), "SIGKILL");
        } catch {}
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** An in-process HTTP server on an ephemeral port answering every request with
 * `respond`: something on the relay port that the test controls. */
export async function standIn(respond: RequestListener) {
  const server = createHttpServer(respond);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = z.object({ port: z.number() }).parse(server.address());
  return {
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** What Rook keeps in a profile's directory agent, for `rook ls`. */
const directoryState = (): RookDirectoryState => ({
  threads: [],
  browser: { waits: {} },
  operatingIdentity: { kind: "personal" },
  profileVerification: { status: "signed-out" },
  model: { kind: "chatgpt-oauth", status: "signed-out" },
  managedPolicy: null,
});

/** A Chrome profile with Rook that keeps redialing `port`, as the extension
 * does, and answers each tunnel as its directory agent, every RPC with null. */
export function standInProfile(port: number, id: string) {
  const base = `ws://127.0.0.1:${port}`;
  const host = encodeLocalHostProtocol(id);
  const sockets = new Set<WebSocket>();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const track = (socket: WebSocket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    return socket;
  };
  const tunnel = (tunnelId: string) => {
    const socket = track(
      new WebSocket(
        `${base}${TUNNEL_PATH}`,
        [TUNNEL_SUBPROTOCOL, host, encodeTunnelIdProtocol(tunnelId)],
        { origin: EXTENSION },
      ),
    );
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "cf_agent_identity",
          agent: "browser-think-agent",
          name: "think",
          stateFollows: true,
        }),
      );
      socket.send(JSON.stringify({ type: "cf_agent_state", state: directoryState() }));
    });
    socket.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      const rpc = z.object({ type: z.literal("rpc"), id: z.string() }).safeParse(frame);
      if (rpc.success)
        socket.send(JSON.stringify({ type: "rpc", id: rpc.data.id, success: true, result: null }));
    });
  };
  const dial = () => {
    if (closed) return;
    const control = track(
      new WebSocket(`${base}${CONTROL_PATH}`, [CONTROL_SUBPROTOCOL, host], { origin: EXTENSION }),
    );
    control.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      const parsed = relayControlMessageSchema.safeParse(frame);
      if (parsed.success) tunnel(parsed.data.tunnelId);
    });
    control.on("close", () => {
      timer = setTimeout(dial, REDIAL_MS);
    });
  };
  dial();
  return {
    close: () => {
      closed = true;
      clearTimeout(timer);
      for (const socket of sockets) socket.terminate();
    },
  };
}

/** A process the test owns that answers the host list as an older rook serve
 * would, naming its own pid, until it is signalled. */
export async function olderServe(port: number, version = "0.0.1") {
  const script = `
    const [port, version] = process.argv.slice(1);
    const server = require("node:http").createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json", "${SERVE_HEADER}": version + " " + process.pid });
      response.end("[]");
    });
    server.listen(Number(port), "127.0.0.1", () => process.stdout.write("listening\\n"));
  `;
  const child = spawn(process.execPath, ["-e", script, String(port), version], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await once(child.stdout, "data");
  const exited = once(child, "exit");
  return {
    child,
    exited,
    kill: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
      await exited;
    },
  };
}
