import { once } from "node:events";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
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
import { admitModel, admitUpgrade, HOSTS_PATH, SERVE_HEADER, startLocalRelay } from "./serve";
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

describe("startLocalRelay", () => {
  it("hands every plain request but GET /hosts to the model relay after admission", async () => {
    const relay = await startLocalRelay({
      port: 0,
      token: TOKEN,
      model: async (_request, response, path) => void response.end(path),
    });
    const at = (path: string, headers: Record<string, string>, method = "POST") =>
      fetch(`http://127.0.0.1:${relay.port}${path}`, { method, headers });
    try {
      const signed = { authorization: `Bearer ${TOKEN}` };
      const call = await at("/codex/v1/responses?beta=true", signed);
      expect(await call.text()).toBe("/codex/v1/responses?beta=true");
      expect((await at("/codex/v1/responses", {})).status).toBe(401);
      expect(await (await at(HOSTS_PATH, signed, "GET")).json()).toEqual([]);
    } finally {
      await relay.close();
    }
  });

  it("pairs the CLI with a profile through the tunnel that profile dials", async () => {
    const relay = await startLocalRelay({ port: 0, token: TOKEN, model: async () => {} });
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
      expect(listed.headers.get(SERVE_HEADER)).toBe(`${packageJson.version} ${process.pid}`);

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
      await relay.close();
    }
  });
});
