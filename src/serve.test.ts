import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import {
  companionSeatAgentsPrefix,
  CONTROL_PATH,
  CONTROL_PING,
  CONTROL_PONG,
  CONTROL_SUBPROTOCOL,
  encodeLocalHostProtocol,
  encodeTunnelIdProtocol,
  relayControlMessageSchema,
  TUNNEL_PATH,
  TUNNEL_SUBPROTOCOL,
} from "./wire/relay";
import packageJson from "../package.json" with { type: "json" };
import {
  admitModel,
  admitUpgrade,
  HOSTS_PATH,
  LEASES_PATH,
  MODEL_TEST_PATH,
  SERVE_HEADER,
} from "./serve";
import { testRelay, writeModelFixture } from "./relay-test-fixture";
import { standIn } from "./testing/daemon";
import { EXIT } from "./command";
import { ROOK_EXTENSION_IDS } from "./wire/contracts";

const TOKEN = "test-token";
const PORT = 7391;
const EXTENSION = `chrome-extension://${ROOK_EXTENSION_IDS.staging}`;
const AGENT = "/agents/browser-think-agent/think";
// What AgentClient dials: `/<prefix>/<agent>/<name>`.
const agentUpgrade = `/${companionSeatAgentsPrefix("work")}/browser-think-agent/think?_pk=1`;
const cli = { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` };
const extension = {
  host: `localhost:${PORT}`,
  origin: EXTENSION,
  "sec-websocket-protocol": `${CONTROL_SUBPROTOCOL}, ${encodeLocalHostProtocol("work")}`,
};

describe("admitUpgrade", () => {
  it("accepts an omitted HTTP default port only when listening on port 80", () => {
    for (const host of ["127.0.0.1", "localhost"]) {
      expect(admitUpgrade(CONTROL_PATH, { ...extension, host }, 80, TOKEN)).toMatchObject({
        ok: true,
      });
      expect(admitModel({ ...cli, host }, 80, TOKEN)).toBeNull();
      expect(admitUpgrade(CONTROL_PATH, { ...extension, host }, PORT, TOKEN)).toMatchObject({
        status: 403,
      });
      expect(admitModel({ ...cli, host }, PORT, TOKEN)).toMatchObject({ status: 403 });
    }
  });

  it("admits a Rook extension on loopback as the host it names", () => {
    expect(admitUpgrade(CONTROL_PATH, extension, PORT, TOKEN)).toEqual({
      ok: true,
      subject: "work",
      upgrade: { role: "control" },
      protocol: CONTROL_SUBPROTOCOL,
    });
  });

  it("refuses other extensions, pages, and rebound host names", () => {
    const strangers = [
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      "https://a.test",
      "null",
    ];
    for (const origin of [...strangers, undefined]) {
      expect(admitUpgrade(CONTROL_PATH, { ...extension, origin }, PORT, TOKEN)).toMatchObject({
        status: 403,
      });
    }
    const rebound = `rebind.test:${PORT}`;
    expect(admitUpgrade(CONTROL_PATH, { ...extension, host: rebound }, PORT, TOKEN)).toMatchObject({
      status: 403,
    });
    expect(admitUpgrade(agentUpgrade, { ...cli, host: rebound }, PORT, TOKEN)).toMatchObject({
      status: 403,
    });
  });

  it("admits the CLI only with the token and without a browser origin", () => {
    expect(admitUpgrade(agentUpgrade, cli, PORT, TOKEN)).toEqual({
      ok: true,
      subject: "work",
      upgrade: { role: "web", url: `${AGENT}?_pk=1` },
    });
    const forged = [
      { ...cli, authorization: "Bearer guess" },
      { host: cli.host },
      { ...cli, origin: EXTENSION },
    ];
    expect(forged.map((headers) => admitUpgrade(agentUpgrade, headers, PORT, TOKEN))).toMatchObject(
      [{ status: 401 }, { status: 401 }, { status: 403 }],
    );
  });

  it("needs a host id, and a tunnel id on a tunnel", () => {
    const anonymous = { ...extension, "sec-websocket-protocol": CONTROL_SUBPROTOCOL };
    expect(admitUpgrade(CONTROL_PATH, anonymous, PORT, TOKEN)).toMatchObject({ status: 400 });
    const tunnel = {
      ...extension,
      "sec-websocket-protocol": `${TUNNEL_SUBPROTOCOL}, ${encodeLocalHostProtocol("work")}`,
    };
    expect(admitUpgrade(TUNNEL_PATH, tunnel, PORT, TOKEN)).toMatchObject({ status: 400 });
  });
});

describe("admitModel", () => {
  it("admits a Rook extension on loopback and the CLI with its token", () => {
    expect(admitModel({ host: `localhost:${PORT}`, origin: EXTENSION }, PORT, TOKEN)).toBeNull();
    expect(admitModel(cli, PORT, TOKEN)).toBeNull();
  });

  it("refuses pages, other extensions, rebound host names and a missing token", () => {
    const strangers = [
      "https://a.test",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      "null",
    ];
    const refused = [
      ...strangers.map((origin) => ({ ...cli, origin })),
      { host: `rebind.test:${PORT}`, origin: EXTENSION },
      { host: cli.host },
    ];
    expect(refused.map((headers) => admitModel(headers, PORT, TOKEN))).toMatchObject([
      { status: 403 },
      { status: 403 },
      { status: 403 },
      { status: 403 },
      { status: 401 },
    ]);
  });
});

describe("scopedLocalRelay", () => {
  it("hands every plain request but the CLI's routes to the model relay after admission", async () => {
    const scope = Scope.makeUnsafe();
    const relay = await Effect.runPromise(
      Scope.provide(
        testRelay({
          port: 0,
          token: TOKEN,
        }),
        scope,
      ),
    );
    const at = (path: string, headers: Record<string, string>, method = "POST") =>
      fetch(`http://127.0.0.1:${relay.port}${path}`, { method, headers });
    try {
      const signed = { authorization: `Bearer ${TOKEN}` };
      const call = await at("/codex/v1/responses?beta=true", signed);
      expect(call.status).toBe(404);
      expect(await call.text()).toContain("rook serve has no model upstream at /codex/v1");
      expect((await at("/codex/v1/responses", {})).status).toBe(401);
      expect(await (await at(HOSTS_PATH, signed, "GET")).json()).toEqual([]);
      // A candidate's test request is the CLI's alone: never Rook's or a page's.
      const browser = { ...signed, origin: EXTENSION };
      expect((await at(MODEL_TEST_PATH, browser)).status).toBe(403);
      expect((await at(MODEL_TEST_PATH, {})).status).toBe(401);
      expect((await at(MODEL_TEST_PATH, signed, "GET")).status).toBe(404);
      const invalid = await at(MODEL_TEST_PATH, signed);
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toContain("invalid model test");
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("grants a lease to one holder at a time until it is released or expires", async () => {
    const scope = Scope.makeUnsafe();
    const relay = await Effect.runPromise(
      Scope.provide(testRelay({ port: 0, token: TOKEN }), scope),
    );
    const at = (path: string, method: string, headers = { authorization: `Bearer ${TOKEN}` }) =>
      fetch(`http://127.0.0.1:${relay.port}${LEASES_PATH}${path}`, { method, headers });
    const grant = async (path: string) => {
      const response = await at(path, "POST");
      return response.status === 200
        ? z.object({ id: z.string() }).parse(await response.json()).id
        : response.status;
    };
    try {
      const first = await grant("model?ms=5000");
      expect(first).toEqual(expect.any(String));
      expect(await grant("model?ms=5000")).toBe(409);
      // Leases are by name.
      expect(await grant("chrome%3ADefault?ms=5000")).toEqual(expect.any(String));
      expect((await at("model?id=someone-else", "DELETE")).status).toBe(204);
      expect(await grant("model?ms=5000")).toBe(409);
      expect((await at(`model?id=${first}`, "DELETE")).status).toBe(204);
      const second = await grant("model?ms=50");
      expect(second).toEqual(expect.any(String));
      expect(await grant("model?ms=5000")).toBe(409);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await grant("model?ms=5000")).toEqual(expect.any(String));
      // The admission of GET /hosts: the token, and no browser Origin.
      expect((await at("other?ms=5000", "POST", { authorization: "Bearer guess" })).status).toBe(
        401,
      );
      const browser = { authorization: `Bearer ${TOKEN}`, origin: EXTENSION };
      expect((await at("other?ms=5000", "POST", browser)).status).toBe(403);
      expect((await at("other", "GET")).status).toBe(404);
      expect(await grant("other?ms=5000")).toEqual(expect.any(String));
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("relays a model call without adding trace headers of its own", async () => {
    const received: IncomingHttpHeaders[] = [];
    const upstream = await standIn((request, response) => {
      received.push(request.headers);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const home = mkdtempSync(join(tmpdir(), "rook-relay-trace-"));
    writeModelFixture(home, {
      version: 1,
      upstreams: {
        url: {
          kind: "url",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          api: "chat",
          transport: "http",
          headers: [],
          query: {},
        },
      },
      off: [],
    });
    const scope = Scope.makeUnsafe();
    try {
      const relay = await Effect.runPromise(
        Scope.provide(testRelay({ port: 0, token: TOKEN, home }), scope),
      );
      const call = await fetch(`http://127.0.0.1:${relay.port}/url/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(call.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]).not.toHaveProperty("traceparent");
      expect(received[0]).not.toHaveProperty("b3");
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await upstream.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("pairs the CLI with a profile through the tunnel that profile dials", async () => {
    const before = Date.now();
    const scope = Scope.makeUnsafe();
    const relay = await Effect.runPromise(
      Scope.provide(testRelay({ port: 0, token: TOKEN }), scope),
    );
    const base = `ws://127.0.0.1:${relay.port}`;
    const host = [encodeLocalHostProtocol("work")];
    const sockets: WebSocket[] = [];
    // A failed assertion closes the relay under sockets still connecting.
    const dial = (socket: WebSocket) => (sockets.push(socket.on("error", () => {})), socket);
    try {
      const control = dial(
        new WebSocket(`${base}${CONTROL_PATH}`, [CONTROL_SUBPROTOCOL, ...host], {
          origin: EXTENSION,
        }),
      );
      await once(control, "open");
      const pong = once(control, "message");
      control.send(CONTROL_PING);
      expect(String((await pong)[0])).toBe(CONTROL_PONG);
      const listed = await fetch(`http://127.0.0.1:${relay.port}${HOSTS_PATH}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(await listed.json()).toEqual([{ id: "work" }]);
      const [version, pid, startedAt] = listed.headers.get(SERVE_HEADER)!.split(" ");
      expect([version, pid]).toEqual([packageJson.version, String(process.pid)]);
      expect(Number(startedAt)).toBeGreaterThanOrEqual(before);
      expect(Number(startedAt)).toBeLessThanOrEqual(Date.now());

      const open = once(control, "message");
      const web = dial(
        new WebSocket(`${base}${agentUpgrade}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      );
      const { tunnelId, url } = relayControlMessageSchema.parse(
        JSON.parse(String((await open)[0])),
      );
      expect(url).toBe(`${AGENT}?_pk=1`);
      const tunnel = dial(
        new WebSocket(
          `${base}${TUNNEL_PATH}`,
          [TUNNEL_SUBPROTOCOL, ...host, encodeTunnelIdProtocol(tunnelId)],
          { origin: EXTENSION },
        ),
      );
      await Promise.all([once(tunnel, "open"), once(web, "open")]);
      const forwarded = once(tunnel, "message");
      web.send("from the CLI");
      expect(String((await forwarded)[0])).toBe("from the CLI");
      const answered = once(web, "message");
      tunnel.send("from the profile");
      expect(String((await answered)[0])).toBe("from the profile");
    } finally {
      for (const socket of sockets) socket.terminate();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
});

describe("relay lifetime", () => {
  it.each([false, true])(
    "interrupts an unpaired upgrade after control closed=%s and releases its port",
    async (closeControl) => {
      const ready = Promise.withResolvers<number>();
      const controller = new AbortController();
      const running = Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const relay = yield* testRelay({ port: 0, token: TOKEN });
            ready.resolve(relay.port);
            yield* Effect.never;
          }),
        ),
        { signal: controller.signal },
      ).catch(() => {});
      const port = await ready.promise;
      const control = new WebSocket(
        `ws://127.0.0.1:${port}${CONTROL_PATH}`,
        [CONTROL_SUBPROTOCOL, encodeLocalHostProtocol("work")],
        { origin: EXTENSION },
      );
      let web: WebSocket | undefined;
      try {
        await once(control, "open");
        const pending = once(control, "message");
        web = new WebSocket(`ws://127.0.0.1:${port}${agentUpgrade}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        web.on("error", () => {});
        await pending;
        const controlClosed = once(control, "close");
        if (closeControl) {
          control.close();
          await controlClosed;
        }
        const webClosed = new Promise<void>((resolve) => web!.once("close", () => resolve()));
        controller.abort();
        await Promise.all([running, controlClosed, webClosed]);
        await Effect.runPromise(
          Effect.scoped(
            testRelay({
              port,
              token: TOKEN,
            }),
          ),
        );
      } finally {
        controller.abort();
        control.terminate();
        web?.terminate();
        await running;
      }
    },
  );

  it("reports a bind failure without disturbing the existing listener", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const existing = yield* testRelay({
            port: 0,
            token: TOKEN,
          });
          const failed = yield* Effect.exit(
            Effect.scoped(
              testRelay({
                port: existing.port,
                token: TOKEN,
              }),
            ),
          );
          expect(failed).toMatchObject({
            _tag: "Failure",
            cause: {
              reasons: [
                {
                  error: {
                    _tag: "CommandError",
                    code: EXIT.unavailable,
                    message: `port ${existing.port} is already taken`,
                  },
                },
              ],
            },
          });
          const response = yield* Effect.promise(() =>
            fetch(`http://127.0.0.1:${existing.port}/hosts`, {
              headers: { authorization: `Bearer ${TOKEN}` },
            }),
          );
          expect(yield* Effect.promise(() => response.json())).toEqual([]);
        }),
      ),
    );
  });

  it("refuses a malformed upgrade target while remaining available", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const relay = yield* testRelay({ port: 0, token: TOKEN });
          const answer = yield* Effect.promise(
            () =>
              new Promise<string>((resolve, reject) => {
                const socket = createConnection(relay.port, "127.0.0.1");
                let text = "";
                socket.setEncoding("utf8");
                socket.on("data", (chunk) => {
                  text += chunk;
                });
                socket.once("error", reject);
                socket.once("end", () => resolve(text));
                socket.once("connect", () =>
                  socket.write(
                    [
                      "GET http://[ HTTP/1.1",
                      `Host: 127.0.0.1:${relay.port}`,
                      "Connection: Upgrade",
                      "Upgrade: websocket",
                      "Sec-WebSocket-Version: 13",
                      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
                      "",
                      "",
                    ].join("\r\n"),
                  ),
                );
              }),
          );
          expect(answer).toContain("HTTP/1.1 400");
          const response = yield* Effect.promise(() =>
            fetch(`http://127.0.0.1:${relay.port}/hosts`, {
              headers: { authorization: `Bearer ${TOKEN}` },
            }),
          );
          expect(yield* Effect.promise(() => response.json())).toEqual([]);
        }),
      ),
    );
  });
});
