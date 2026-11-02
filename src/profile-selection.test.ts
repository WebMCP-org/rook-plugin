import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };
import { writeConfig } from "./model";
import { HOSTS_PATH, SERVE_HEADER } from "./serve";
import type { RookDirectoryState } from "./wire/contracts";
import { parseCompanionSeatAgentPath } from "./wire/relay";

const execute = promisify(execFile);
let build: string;
beforeAll(async () => {
  build = await mkdtemp(join(tmpdir(), "rook-selection-build-"));
  await execute("vp", ["pack", "--out-dir", build], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    maxBuffer: 10 * 1024 * 1024,
  });
}, 60_000);
afterAll(async () => {
  if (build) await rm(build, { recursive: true, force: true });
});

const rpcSchema = z.object({
  type: z.literal("rpc"),
  id: z.string(),
  method: z.enum(["setOpenAiCompatibleModelSource", "listTools", "startThread"]),
  args: z.array(z.unknown()),
});
const modelSchema = z.object({ baseUrl: z.string(), modelId: z.string() }).passthrough();

// The real CLI discovers two profiles and sends real AgentClient RPC frames.
// Only the remote relay/profile boundary is a stand-in; every model write is
// recorded here, including writes made while discovering an unselected peer.
async function profileBoundary() {
  const home = await mkdtemp(join(tmpdir(), "rook-selection-"));
  await writeFile(join(home, "token"), "selection-test-token");
  writeConfig(home, {
    version: 1,
    upstreams: { codex: { kind: "codex", transport: "ws" } },
    default: { upstream: "codex", model: "gpt-6-astra", effort: "high" },
    off: [],
  });
  const writes: string[] = [];
  const discovered = new Set<string>();
  const states = new Map<string, RookDirectoryState>(
    ["assistant", "fresh-e2e"].map((id) => [
      id,
      {
        threads: [],
        browser: { waits: {} },
        operatingIdentity: { kind: "personal" },
        profileVerification: { status: "signed-out" },
        model: { kind: "chatgpt-oauth", status: "signed-out" },
        managedPolicy: null,
      },
    ]),
  );
  const server = createServer((request, response) => {
    if (
      request.url !== HOSTS_PATH ||
      request.headers.authorization !== "Bearer selection-test-token"
    ) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      [SERVE_HEADER]: `${packageJson.version} ${process.pid}`,
    });
    response.end(JSON.stringify([...states.keys()].map((id) => ({ id }))));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, request) => {
    const route = parseCompanionSeatAgentPath(new URL(request.url!, "http://localhost").pathname);
    const id = route?.subject;
    const state = id && states.get(id);
    if (!id || !state) throw new Error("Unexpected profile route");
    discovered.add(id);
    socket.send(
      JSON.stringify({
        type: "cf_agent_identity",
        agent: "browser-think-agent",
        name: "think",
        stateFollows: true,
      }),
    );
    socket.send(JSON.stringify({ type: "cf_agent_state", state }));
    socket.on("message", (bytes) => {
      const call = rpcSchema.parse(JSON.parse(String(bytes)));
      if (call.method === "setOpenAiCompatibleModelSource") {
        writes.push(id);
        state.model = { ...modelSchema.parse(call.args[0]), kind: "openai-compatible" };
        socket.send(JSON.stringify({ type: "cf_agent_state", state }));
      }
      socket.send(
        JSON.stringify({
          type: "rpc",
          id: call.id,
          success: true,
          result: call.method === "listTools" ? [] : null,
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = z.object({ port: z.number() }).parse(server.address());
  return {
    states,
    writes,
    discovered,
    run: async (...args: string[]) => {
      return execute(process.execPath, [join(build, "rook"), ...args], {
        env: {
          ...process.env,
          ROOK_HOME: home,
          CODEX_HOME: home,
          ROOK_PROFILE: "",
          ROOK_RELAY_PORT: String(port),
        },
        timeout: 10_000,
      });
    },
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    },
  };
}

it.each(["tools", "ask"])(
  "rook %s assigns a model only after selecting its profile",
  async (command) => {
    const boundary = await profileBoundary();
    try {
      await boundary.run(
        command,
        ...(command === "ask" ? ["hello", "--detach"] : []),
        "--profile",
        "assistant",
        "--json",
      );
      expect([...boundary.discovered].sort()).toEqual(["assistant", "fresh-e2e"]);
      expect(boundary.writes).toEqual(["assistant"]);
      expect(boundary.states.get("fresh-e2e")?.model).toEqual({
        kind: "chatgpt-oauth",
        status: "signed-out",
      });
    } finally {
      await boundary.close();
    }
  },
);

it("rook ls discovers every profile without assigning any model", async () => {
  const boundary = await profileBoundary();
  try {
    const result = await boundary.run("ls", "--json");
    expect(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => z.object({ id: z.string() }).parse(JSON.parse(line)).id)
        .sort(),
    ).toEqual(["assistant", "fresh-e2e"]);
    expect(boundary.writes).toEqual([]);
  } finally {
    await boundary.close();
  }
});

it("an ambiguous rook ask requests selection without assigning any model", async () => {
  const boundary = await profileBoundary();
  try {
    await expect(boundary.run("ask", "hello", "--detach")).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Ask the user which one"),
    });
    expect(boundary.writes).toEqual([]);
  } finally {
    await boundary.close();
  }
});
