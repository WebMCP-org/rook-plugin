// Rook's calls through `rook serve`'s model relay to real local upstreams: a
// Responses server over HTTP and WebSocket, and a chat server.
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { testModel, writeConfig, type Selection } from "./model";
import {
  MODEL_FILE,
  modelRelay,
  type HeaderSource,
  type Upstream,
} from "./relay";

const jsonSchema = z.json();
type Json = z.infer<typeof jsonSchema>;
const bodySchema = z.record(z.string(), jsonSchema);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllEnvs();
});

async function serve(server: Server): Promise<string> {
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = z.object({ port: z.number() }).parse(server.address());
  return `http://127.0.0.1:${port}`;
}

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string };

/** A real local upstream that records each request and answers it with `answer`. */
async function listen(
  answer: (seen: Seen, response: ServerResponse, n: number) => void | Promise<void>,
) {
  const seen: Seen[] = [];
  const server = createServer(async (request, response) => {
    const body = Buffer.concat(await Array.fromAsync(request)).toString();
    const call = {
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body,
    };
    seen.push(call);
    await answer(call, response, seen.length);
  });
  return { server, origin: await serve(server), seen };
}

/** serve's model relay over `upstreams`, mounted at the root as serve mounts it. */
async function relay(upstreams: Record<string, Upstream>) {
  const home = mkdtempSync(join(tmpdir(), "rook-relay-"));
  writeConfig(home, { version: 1, upstreams, off: [] });
  const logs: string[] = [];
  const model = modelRelay(home, (line) => logs.push(line));
  const server = createServer((request, response) => {
    void model(request, response, request.url ?? "/");
  });
  return { origin: await serve(server), home, logs };
}

const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer serve-token",
      "content-type": "application/json",
      ...headers,
    },
    body,
  });

const bodyOf = (seen: Seen) => bodySchema.parse(JSON.parse(seen.body));

const chatUpstream = (
  origin: string,
  headers: HeaderSource[] = [],
): Extract<Upstream, { kind: "url" }> => ({
  kind: "url",
  baseUrl: `${origin}/v1`,
  api: "chat",
  transport: "http",
  headers,
  query: {},
});

describe("a url upstream's headers", () => {
  it("sends values, variables and command output, and reruns a command after a 401 or its ttl", async () => {
    vi.stubEnv("ROOK_TEST_KEY", "key-1");
    vi.stubEnv("ROOK_TEST_UNSET", undefined);
    const dir = mkdtempSync(join(tmpdir(), "rook-headers-"));
    // Prints <name>-1, <name>-2, …: one more on each run.
    const counting = (name: string) => {
      const file = join(dir, name);
      return `n=$(( $(cat '${file}' 2>/dev/null || echo 0) + 1 )); echo $n > '${file}'; echo ${name}-$n`;
    };
    let expired = "";
    const upstream = await listen((seen, response) => {
      const refused = seen.headers["x-token"] === expired;
      response.writeHead(refused ? 401 : 200, { "content-type": "application/json" });
      response.end(refused ? '{"error":"token expired"}' : '{"ok":true}');
    });
    const { origin } = await relay({
      url: {
        ...chatUpstream(`${upstream.origin}/`),
        baseUrl: `${upstream.origin}/v1/`,
        headers: [
          { name: "x-team", value: "rook" },
          { name: "authorization", env: "ROOK_TEST_KEY", prefix: "Bearer " },
          { name: "x-trace", env: "ROOK_TEST_UNSET", optional: true },
          { name: "x-token", command: counting("refreshed") },
        ],
        query: { "api-version": "2026-01-01" },
      },
      timed: chatUpstream(upstream.origin, [
        { name: "x-token", command: counting("timed"), ttl: 1 },
      ]),
    });
    const call = async (name: string) =>
      (await post(`${origin}/${name}/v1/chat/completions?trace=1`, '{"model":"m"}')).status;

    expect([await call("url"), await call("url")]).toEqual([200, 200]);
    expired = "refreshed-1";
    expect(await call("url")).toBe(200);
    expect(upstream.seen.map(({ headers }) => headers["x-token"])).toEqual([
      "refreshed-1",
      "refreshed-1",
      "refreshed-1",
      "refreshed-2",
    ]);
    expect(upstream.seen[0]).toMatchObject({
      url: "/v1/chat/completions?trace=1&api-version=2026-01-01",
      headers: { "x-team": "rook", authorization: "Bearer key-1" },
    });
    expect(upstream.seen[0].headers).not.toHaveProperty("x-trace");

    await call("timed");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await call("timed");
    const timed = upstream.seen.slice(4);
    expect(timed.map(({ headers }) => headers["x-token"])).toEqual(["timed-1", "timed-2"]);
    // serve's own token stays with serve.
    expect(timed[0].headers).not.toHaveProperty("authorization");
  });

  it("refuses a call whose header variable rook serve lacks, naming it", async () => {
    vi.stubEnv("ROOK_TEST_UNSET", undefined);
    const upstream = await listen((_seen, response) => {
      response.end();
    });
    const { origin } = await relay({
      url: chatUpstream(upstream.origin, [{ name: "authorization", env: "ROOK_TEST_UNSET" }]),
    });
    const reply = await post(`${origin}/url/v1/chat/completions`, "{}");
    expect(reply.status).toBe(502);
    expect(await reply.text()).toContain("ROOK_TEST_UNSET");
    expect(upstream.seen).toEqual([]);
  });
});

/** A Responses endpoint: SSE or JSON over HTTP, and WebSocket mode on its /responses. */
async function responsesServer() {
  const handshakes: { url: string; headers: IncomingHttpHeaders }[] = [];
  const messages: Json[] = [];
  const events = [
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_text.delta", item_id: "msg_1", delta: "ready" },
    { type: "response.completed", response: { id: "resp_1", status: "completed" } },
  ];
  const upstream = await listen((seen, response) => {
    if (z.object({ stream: z.literal(true) }).safeParse(bodyOf(seen)).success) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_1", status: "completed", output: [] }));
  });
  const sockets = new WebSocketServer({ server: upstream.server });
  cleanups.push(() => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  });
  sockets.on("connection", (socket, request) => {
    handshakes.push({ url: request.url ?? "", headers: request.headers });
    socket.on("message", (data) => {
      messages.push(jsonSchema.parse(JSON.parse(String(data))));
      for (const event of events) socket.send(JSON.stringify(event));
    });
  });
  return { ...upstream, handshakes, messages };
}

describe.each(["ws", "http"] as const)("a Responses url upstream over %s", (transport) => {
  it("carries a streamed call that way and a plain one over HTTP, with its headers and query", async () => {
    const upstream = await responsesServer();
    const { origin, logs } = await relay({
      url: {
        kind: "url",
        baseUrl: `${upstream.origin}/v1`,
        api: "responses",
        transport,
        headers: [{ name: "authorization", value: "Bearer corp" }],
        query: { "api-version": "2026-01-01" },
      },
    });
    const call = (body: string) =>
      post(`${origin}/url/v1/responses`, body, { "session-id": "thread-1" });

    const streamed = await call('{"model":"m","input":[],"stream":true}');
    expect(await streamed.text()).toContain('"type":"response.completed"');
    const plain = await call('{"model":"m","input":[]}');
    expect(await plain.json()).toMatchObject({ status: "completed" });

    const over = (seen: Pick<Seen, "url" | "headers">) => ({
      url: seen.url,
      authorization: seen.headers.authorization,
    });
    const expected = { url: "/v1/responses?api-version=2026-01-01", authorization: "Bearer corp" };
    if (transport === "ws") {
      expect(upstream.handshakes.map(over)).toEqual([expected]);
      expect(upstream.handshakes[0].headers).toMatchObject({
        "session-id": "thread-1",
        "openai-beta": "responses_websockets=2026-02-06",
      });
      expect(upstream.messages).toEqual([{ type: "response.create", model: "m", input: [] }]);
      expect(upstream.seen.map(over)).toEqual([expected]);
      expect(logs).toEqual([expect.stringContaining("sent in full")]);
    } else {
      expect(upstream.handshakes).toEqual([]);
      expect(upstream.seen.map(over)).toEqual([expected, expected]);
      expect(logs).toEqual([]);
    }
  });
});

describe("modelRelay", () => {
  it("routes /<name>/v1 to that upstream in model.json, read on every call", async () => {
    const first = await listen((_seen, response) => {
      response.end("first");
    });
    const second = await listen((_seen, response) => {
      response.end("second");
    });
    const { origin, home } = await relay({ url: chatUpstream(first.origin) });
    const call = (path: string) => post(`${origin}${path}`, "{}");

    expect(await (await call("/url/v1/chat/completions")).text()).toBe("first");
    writeConfig(home, { version: 1, upstreams: { url: chatUpstream(second.origin) }, off: [] });
    expect(await (await call("/url/v1/chat/completions")).text()).toBe("second");
    for (const path of ["/codex/v1/responses", "/__proto__/v1/responses", "/url/v2/chat", "/"]) {
      expect((await call(path)).status).toBe(404);
    }
    writeFileSync(join(home, MODEL_FILE), "{");
    expect((await call("/url/v1/chat/completions")).status).toBe(500);
  });
});

describe("rook model's test request", () => {
  it("passes once the upstream completes a response, and fails with its status and body or its failure", async () => {
    const sse = (...types: string[]) =>
      types.map((type) => `data: ${JSON.stringify({ type, response: { id: "r" } })}\n\n`).join("");
    const answers: [number, string][] = [
      [200, sse("response.created", "response.completed")],
      [401, '{"error":{"message":"invalid key"}}'],
      [200, sse("response.created", "response.failed")],
      [200, sse("response.created")],
    ];
    const upstream = await listen((_seen, response, n) => {
      const [status, body] = answers[n - 1];
      response.writeHead(status, { "content-type": "text/event-stream" });
      response.end(body);
    });
    const chosen: Selection = {
      upstream: {
        kind: "url",
        baseUrl: `${upstream.origin}/v1`,
        api: "responses",
        transport: "http",
        headers: [],
        query: {},
      },
      choice: { upstream: "url", model: "corp-model", effort: "low" },
    };
    const { origin } = await relay({ url: chosen.upstream });
    const test = () => testModel(chosen, "serve-token", origin);

    await test();
    await expect(test()).rejects.toThrow(
      'the url upstream answered 401: {"error":{"message":"invalid key"}}',
    );
    await expect(test()).rejects.toThrow("the url upstream failed");
    await expect(test()).rejects.toThrow("ended its stream before the response finished");
    expect(bodyOf(upstream.seen[0])).toEqual({
      model: "corp-model",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Reply with the word ready." }] },
      ],
      reasoning: { effort: "low" },
      store: false,
      stream: true,
    });
  });

  it("asks a chat upstream in chat's shape", async () => {
    const upstream = await listen((_seen, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"choices":[{"message":{"role":"assistant","content":"ready"}}]}');
    });
    const chosen: Selection = {
      upstream: chatUpstream(upstream.origin),
      choice: { upstream: "url", model: "corp-model", effort: "low" },
    };
    const { origin } = await relay({ url: chosen.upstream });
    await testModel(chosen, "serve-token", origin);
    expect(upstream.seen.map(({ url }) => url)).toEqual(["/v1/chat/completions"]);
    expect(bodyOf(upstream.seen[0])).toEqual({
      model: "corp-model",
      messages: [{ role: "user", content: "Reply with the word ready." }],
      reasoning_effort: "low",
    });
  });
});
