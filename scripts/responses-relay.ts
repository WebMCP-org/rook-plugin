// The benchmarks' Responses endpoint: `node packages/cli/scripts/responses-relay.ts`
// serves http://127.0.0.1:10531/v1 and answers through ChatGPT with the local
// Codex sign-in. It is `rook serve`'s codex upstream without admission, so it
// stays a benchmark tool: any local process may use it.
// RELAY_TRANSPORT=http keeps plain requests for an A/B run.
import { createServer } from "node:http";
import { upstreamEndpoint } from "../src/relay.ts";

const PORT = Number(process.env.RELAY_PORT ?? 10531);
const TRANSPORT = process.env.RELAY_TRANSPORT === "http" ? "http" : "ws";

const codex = upstreamEndpoint({ kind: "codex", transport: TRANSPORT }, (line) =>
  console.log(`[relay] ${line}`),
);

createServer((request, response) => {
  const url = request.url ?? "/";
  void codex(request, response, url.startsWith("/v1/") ? url.slice("/v1".length) : url);
}).listen(PORT, "127.0.0.1", () => {
  console.log(
    `[relay] http://127.0.0.1:${PORT}/v1 → ChatGPT over ${TRANSPORT === "ws" ? "WebSocket" : "HTTP"}`,
  );
});
