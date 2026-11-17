// `rook serve`, the local relay daemon, as a real process.
import { once } from "node:events";
import { rm } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { daemonHome, freePort, standIn, standInProfile, stopServe } from "./testing/daemon";
import { rookHome, spawnRook, TOKEN } from "./testing/peer";
import { ROOK_EXTENSION_IDS } from "./wire/contracts";
import {
  companionSeatAgentsPrefix,
  CONTROL_PATH,
  CONTROL_SUBPROTOCOL,
  encodeLocalHostProtocol,
  relayControlMessageSchema,
} from "./wire/relay";

it("serve handles SIGTERM while a profile tunnel is still connecting", async () => {
  const home = await rookHome();
  const running = spawnRook(home, 0, ["serve"]);
  const sockets: WebSocket[] = [];
  try {
    await expect.poll(() => running.stderr).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+/u);
    const base = /listening on (http:\/\/127\.0\.0\.1:\d+)/u
      .exec(running.stderr)![1]
      .replace("http:", "ws:");
    const control = new WebSocket(
      `${base}${CONTROL_PATH}`,
      [CONTROL_SUBPROTOCOL, encodeLocalHostProtocol("work")],
      {
        origin: `chrome-extension://${ROOK_EXTENSION_IDS.staging}`,
      },
    );
    sockets.push(control);
    await once(control, "open");
    const requested = once(control, "message");
    const web = new WebSocket(
      `${base}/${companionSeatAgentsPrefix("work")}/browser-think-agent/think`,
      {
        headers: { authorization: `Bearer ${TOKEN}` },
      },
    );
    // Shutdown rejects the upgrade before the host supplies its tunnel.
    web.on("error", () => {});
    sockets.push(web);
    const closed = sockets.map(
      (socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())),
    );
    relayControlMessageSchema.parse(JSON.parse(String((await requested)[0])));
    running.child.kill("SIGTERM");
    const result = await running.result;
    expect(result, result.stderr).toMatchObject({ code: 143, signal: null });
    await Promise.all(closed);
    expect(sockets.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true);
  } finally {
    for (const socket of sockets) socket.terminate();
    if (running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill("SIGKILL");
      await running.result;
    }
    await rm(home, { recursive: true, force: true });
  }
});

it("a second serve on a taken port exits with one line", async () => {
  const daemon = await daemonHome();
  const port = await freePort();
  const first = daemon.start(port, "serve");
  try {
    await expect.poll(() => first.stderr).toContain("listening on");
    const second = await daemon.start(port, "serve").result;
    expect(second).toMatchObject({
      code: 5,
      signal: null,
      stdout: "",
      stderr: `rook: port ${port} is already taken\n`,
    });
    expect(first.child.exitCode).toBeNull();
  } finally {
    first.child.kill("SIGTERM");
    await first.result;
    await rm(daemon.home, { recursive: true, force: true });
  }
});

it("rook model's test request is sent by rook serve, from its environment and without the CLI's trace", async () => {
  const daemon = await daemonHome();
  const port = await freePort();
  const seen: IncomingHttpHeaders[] = [];
  const upstream = await standIn((request, response) => {
    seen.push(request.headers);
    request.resume();
    response.writeHead(200, { "content-type": "application/json" }).end('{"choices":[]}');
  });
  // serve keeps the environment it started with; the CLI's is another.
  vi.stubEnv("ROOK_TEST_MODEL_KEY", "from-serve");
  const serve = daemon.start(port, "serve");
  const profile = standInProfile(port, "model-profile");
  try {
    await expect.poll(() => serve.stderr).toContain("listening on");
    vi.stubEnv("ROOK_TEST_MODEL_KEY", "from-cli");
    vi.stubEnv("TRACEPARENT", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    const result = await daemon.start(
      port,
      "model",
      "url",
      `http://127.0.0.1:${upstream.port}/v1`,
      "--api",
      "chat",
      "--model",
      "corp-model",
      "--header-env",
      "authorization=Bearer ROOK_TEST_MODEL_KEY",
    ).result;
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    // The profile has no verified email, so its label is its host id's first eight.
    expect(result.stdout).toBe("model-pr\tuses url corp-model\n");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ authorization: "Bearer from-serve" });
    expect(Object.keys(seen[0])).not.toContain("traceparent");
    expect(Object.keys(seen[0])).not.toContain("b3");
    expect(await daemon.opened()).toBe("");
  } finally {
    vi.unstubAllEnvs();
    profile.close();
    await stopServe(port, await daemon.token().catch(() => ""));
    if (serve.child.exitCode === null && serve.child.signalCode === null) serve.child.kill("SIGKILL");
    await serve.result;
    await upstream.close();
    await rm(daemon.home, { recursive: true, force: true });
  }
}, 30_000);
