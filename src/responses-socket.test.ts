import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

it("releases completed response listeners even when Node collects signal cleanup callbacks", async () => {
  let active: WebSocket | undefined;
  let requests = 0;
  const completed = JSON.stringify({
    type: "response.completed",
    response: { id: "response-1" },
  });
  const server = createServer((_request, response) => {
    // The child releases the first response only after collecting garbage.
    active!.send(completed);
    response.end();
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    active = socket;
    socket.on("message", () => {
      requests += 1;
      socket.send(JSON.stringify({ type: "response.created", response: { id: "response-1" } }));
      if (requests > 1) socket.send(completed);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const origin = `http://127.0.0.1:${port}`;
  const adapter = new URL("./wire/responses-socket.ts", import.meta.url).href;
  try {
    // A separate real Node process both exposes GC and makes an uncaught
    // WebSocket callback crash fail the test instead of killing its runner.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        "--input-type=module",
        "-e",
        `
        import { setImmediate } from "node:timers/promises";
        import { connectNodeWebSocket, responsesOverWebSocket } from ${JSON.stringify(adapter)};
        const sockets = [];
        const request = responsesOverWebSocket(async (...args) => {
          const socket = await connectNodeWebSocket(...args);
          sockets.push(socket);
          return socket;
        })(fetch);
        const call = () => request(${JSON.stringify(`${origin}/responses`)}, {
          method: "POST",
          headers: { "session-id": "gc-conversation" },
          body: JSON.stringify({ model: "test", input: [], stream: true }),
        });
        const first = await call();
        const reader = first.body.getReader();
        await reader.read();
        // WeakRef targets survive their current job. Yield before each GC.
        for (let i = 0; i < 3; i++) {
          await setImmediate();
          global.gc();
        }
        await fetch(${JSON.stringify(`${origin}/complete`)});
        while (!(await reader.read()).done) {}
        console.log(await (await call()).text());
        for (const socket of sockets) socket?.close();
      `,
      ],
      { timeout: 10_000 },
    );
    expect(stdout).toContain('"type":"response.completed"');
    expect(requests).toBe(2);
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
