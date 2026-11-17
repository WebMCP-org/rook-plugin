// The CLI's own spans: the packed rook against the fake peer, exporting to an
// in-process collector the test owns.
import type { IncomingMessage } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { fakePeer } from "./testing/peer";
import { standIn } from "./testing/daemon";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const CALLER = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE}-${CALLER}-01`;

const spanSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  status: z.object({ code: z.number() }).passthrough(),
});
const batchSchema = z.object({
  resourceSpans: z.array(
    z.object({ scopeSpans: z.array(z.object({ spans: z.array(spanSchema) })) }),
  ),
});

type Post = { contentType: string | undefined; body: Buffer };

/** An OTLP collector: `answer` false leaves every export hanging. */
async function collector(answer = true) {
  const posts: Post[] = [];
  const server = await standIn((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      posts.push({ contentType: request.headers["content-type"], body: Buffer.concat(chunks) });
      if (answer) response.writeHead(200).end();
    });
  });
  return { ...server, posts, endpoint: `http://127.0.0.1:${server.port}` };
}

const spans = (posts: Post[]) =>
  posts.flatMap(({ body }) =>
    batchSchema
      .parse(JSON.parse(body.toString()))
      .resourceSpans.flatMap(({ scopeSpans }) => scopeSpans.flatMap((scope) => scope.spans)),
  );

/** `--json` stdout without the fields that differ between any two runs. */
const stable = (stdout: string) =>
  stdout.replace(/"ts":"[^"]+"/g, '"ts":""').replace(/"thread":"[^"]+"/g, '"thread":""');

function exporting(endpoint: string, protocol?: string) {
  vi.stubEnv("OTEL_TRACES_EXPORTER", "otlp");
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
  if (protocol) vi.stubEnv("OTEL_EXPORTER_OTLP_PROTOCOL", protocol);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/** One `rook run` to completion, timed from spawn to exit. */
async function run() {
  const peer = await fakePeer({ threads: [] });
  try {
    const started = performance.now();
    const running = peer.start("run", "/automations/example.ts", "--json");
    let stdoutEnded = Infinity;
    running.child.stdout!.once("end", () => {
      stdoutEnded = performance.now();
    });
    await expect.poll(() => peer.calls.map(({ call }) => call.method)).toEqual(["runAutomation"]);
    await expect.poll(() => peer.conversations.size).toBe(1);
    peer.finishExecution({ executionId: "execution", files: [], logs: [], result: "done" });
    const result = await running.result;
    const exited = performance.now();
    return {
      ...result,
      elapsed: exited - started,
      stdoutEnded,
      exited,
      calls: peer.calls.map(({ call }) => call),
      threads: peer.state.threads.length,
    };
  } finally {
    await peer.close();
  }
}

it("run exports its span under the caller's, and Rook's trace hangs from it", async () => {
  vi.stubEnv("TRACEPARENT", TRACEPARENT);
  const plain = await run();
  const otlp = await collector();
  try {
    exporting(otlp.endpoint, "http/json");
    const traced = await run();
    expect(traced.code, traced.stderr).toBe(0);
    expect([traced.code, stable(traced.stdout)]).toEqual([plain.code, stable(plain.stdout)]);
    expect(otlp.posts.map(({ contentType }) => contentType)).toEqual(["application/json"]);
    const exported = spans(otlp.posts);
    const span = exported.find(({ name }) => name === "rook.run");
    expect(span).toMatchObject({ traceId: TRACE, parentSpanId: CALLER });
    const [sent] = traced.calls.map(({ traceparent }) => traceparent);
    expect(sent).toBe(`00-${TRACE}-${span!.spanId}-01`);
    // A traced run removes its thread like any other; Rook delivers the
    // conversation's pending telemetry before deleting it.
    expect(traced.calls.map(({ method }) => method)).toEqual(["runAutomation", "deleteThread"]);
    expect(traced.threads).toBe(0);
  } finally {
    await otlp.close();
  }
});

it("exports protobuf when no protocol is set", async () => {
  const otlp = await collector();
  const peer = await fakePeer({ threads: [] });
  try {
    exporting(otlp.endpoint);
    const result = await peer.start("ask", "hello", "--detach").result;
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(otlp.posts.map(({ contentType }) => contentType)).toEqual(["application/x-protobuf"]);
    // Without a caller, Rook's spans join the trace the CLI's span starts.
    expect(peer.calls[0]!.call.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  } finally {
    await peer.close();
    await otlp.close();
  }
});

it("a collector that hangs or refuses changes neither output nor exit code, and output finishes first", async () => {
  const plain = await run();
  const hanging = await collector(false);
  const refusing = await collector();
  await refusing.close();
  try {
    exporting(hanging.endpoint);
    const held = await run();
    exporting(refusing.endpoint);
    const refused = await run();
    for (const result of [held, refused]) {
      expect([result.code, stable(result.stdout), result.stderr]).toEqual([
        plain.code,
        stable(plain.stdout),
        plain.stderr,
      ]);
      // The flush is bounded at a second; the rest is headroom for a loaded machine.
      expect(result.elapsed - plain.elapsed).toBeLessThan(3_000);
    }
    // The flush waited on the hanging collector after stdout had ended.
    expect(hanging.posts).toHaveLength(1);
    expect(held.exited - held.stdoutEnded).toBeGreaterThan(500);
  } finally {
    await hanging.close();
  }
});

it("a malformed OTEL value never fails a command, and says so only when traces were asked for", async () => {
  // No scheme: not a URL. Unasked, it is the caller's own setting and is not read.
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "127.0.0.1:4318");
  const unasked = await run();
  expect([unasked.code, unasked.stderr]).toEqual([0, ""]);
  vi.stubEnv("OTEL_TRACES_EXPORTER", "otlp");
  const asked = await run();
  expect(asked.code, asked.stderr).toBe(0);
  expect(stable(asked.stdout)).toBe(stable(unasked.stdout));
  expect(asked.stderr).toMatch(/^rook: tracing is off: .*OTEL_EXPORTER_OTLP_ENDPOINT.*\n$/);
});

it("a failed command's span is an error that carries no message", async () => {
  const otlp = await collector();
  const peer = await fakePeer();
  try {
    exporting(otlp.endpoint, "http/json");
    const result = await peer.start("rename", "secret-thread-7f3a", "Title").result;
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("secret-thread-7f3a");
    const payload = otlp.posts.map(({ body }) => body.toString()).join("\n");
    expect(payload).not.toContain("secret-thread-7f3a");
    expect(payload).not.toContain("no thread");
    expect(spans(otlp.posts).find(({ name }) => name === "rook.rename")?.status.code).toBe(2);
  } finally {
    await peer.close();
    await otlp.close();
  }
});

it.each([
  { name: "OTEL_TRACES_EXPORTER unset", env: {} },
  { name: "gRPC", env: { OTEL_TRACES_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" } },
  {
    name: "an unsampled caller",
    env: {
      OTEL_TRACES_EXPORTER: "otlp",
      TRACEPARENT: `00-${TRACE}-${CALLER}-00`,
    },
  },
])("$name exports nothing and passes TRACEPARENT through", async ({ env }) => {
  const otlp = await collector();
  const peer = await fakePeer();
  try {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", otlp.endpoint);
    vi.stubEnv("TRACEPARENT", TRACEPARENT);
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const result = await peer.start("ask", "hello", "--detach").result;
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(peer.calls[0]!.call.traceparent).toBe(process.env.TRACEPARENT);
    expect(otlp.posts).toEqual([]);
  } finally {
    await peer.close();
    await otlp.close();
  }
});
