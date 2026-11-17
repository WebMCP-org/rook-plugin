// `rook serve`'s codex upstream against the ChatGPT sign-in on this machine,
// as Rook calls it, over both transports. It spends the user's plan, so it
// runs only with ROOK_LIVE_MODELS=1.
import { randomUUID } from "node:crypto";
import { Effect, Exit, Scope } from "effect";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { resolveAuthFileCandidates } from "@openai-oauth/local/auth-file";
import { generateText, tool, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { servedSource } from "./model";
import { testModel } from "./model-probe";
import type { Selection } from "./model-settings";
import { testRelay, writeModelFixture, modelTestLayer } from "./relay-test-fixture";
import { DEFAULT_CHATGPT_MODEL_ID } from "./wire/contracts";
import { LOCAL_RELAY_ORIGIN } from "./wire/relay";

const TOKEN = "live-check";

/** A one-page PDF that prints `text`. */
function pdf(text: string): string {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const entries = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`);
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries.join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body).toString("base64");
}

describe.each(["ws", "http"] as const)("codex over %s through rook serve", (transport) => {
  it("passes rook model's test, reads a PDF and runs a tool round trip", async (context) => {
    context.skip(
      process.env.ROOK_LIVE_MODELS !== "1",
      "Set ROOK_LIVE_MODELS=1 to call ChatGPT with this machine's Codex sign-in.",
    );
    context.skip(
      !resolveAuthFileCandidates().some((path) => existsSync(path)),
      "Codex is not signed in here; run `codex login`.",
    );
    const home = mkdtempSync(join(tmpdir(), "rook-live-"));
    const selection: Selection = {
      upstream: { kind: "codex", transport },
      choice: { upstream: "codex", model: DEFAULT_CHATGPT_MODEL_ID, effort: "low" },
    };
    writeModelFixture(home, { version: 1, upstreams: { codex: selection.upstream }, off: [] });
    const scope = Scope.makeUnsafe();
    const relay = await Effect.runPromise(
      Scope.provide(testRelay({ port: 0, token: TOKEN, home }), scope),
    );
    const origin = `http://127.0.0.1:${relay.port}`;
    try {
      await Effect.runPromise(
        testModel(selection).pipe(Effect.provide(modelTestLayer(home, relay.port, TOKEN))),
      );
      const { baseUrl, modelId } = servedSource(selection, origin);
      const rook = {
        model: createOpenAI({
          baseURL: baseUrl.replace(LOCAL_RELAY_ORIGIN, origin),
          apiKey: TOKEN,
          // Rook's conversation key, which a socket is opened for.
          headers: { "session-id": randomUUID() },
        }).responses(modelId),
        system: "You are Rook.",
        providerOptions: { openai: { store: false, reasoningEffort: "low" } },
      };
      const tools = {
        lookup: tool({
          description: "Look a value up",
          inputSchema: z.object({ key: z.string() }),
        }),
      };
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Call lookup with the code word the attached PDF prints as its key, then reply with only the value lookup returns.",
            },
            {
              type: "file",
              mediaType: "application/pdf",
              data: pdf("VERMILION"),
              filename: "code.pdf",
            },
          ],
        },
      ];
      const first = await generateText({ ...rook, messages, tools });
      const [call] = first.toolCalls;
      expect(call?.input).toEqual({ key: "VERMILION" });
      const second = await generateText({
        ...rook,
        tools,
        messages: [
          ...messages,
          ...first.response.messages,
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: call.toolCallId,
                toolName: "lookup",
                output: { type: "text", value: "TEAL-42" },
              },
            ],
          },
        ],
      });
      expect(second.text).toContain("TEAL-42");
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  }, 180_000);
});
