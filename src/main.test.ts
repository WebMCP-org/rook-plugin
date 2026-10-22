import { readFileSync } from "node:fs";
import type { UIMessage } from "ai";
import { expect, it } from "vitest";
import marketplace from "../.claude-plugin/marketplace.json" with { type: "json" };
import plugin from "../.claude-plugin/plugin.json" with { type: "json" };
import codexPlugin from "../plugin.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import { EXIT, reply, toolInput, toolReply } from "./main";

it("answers with what the side panel shows of the last reply: its text and files", () => {
  const messages: UIMessage[] = [
    { id: "u0", role: "user", parts: [{ type: "text", text: "earlier" }] },
    { id: "a0", role: "assistant", parts: [{ type: "text", text: "Earlier answer." }] },
    { id: "u1", role: "user", parts: [{ type: "text", text: "how many?" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "Checking the page." },
        {
          type: "tool-browser_navigate",
          toolCallId: "t1",
          state: "output-available",
          input: {},
          output: {},
        },
        { type: "reasoning", text: "counting" },
        { type: "text", text: "There are 3." },
        { type: "file", mediaType: "image/png", url: "data:image/png;base64,AA==" },
      ],
    },
  ];
  expect(reply(messages)).toEqual({
    text: "Checking the page.\n\nThere are 3.",
    files: [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,AA==" }],
  });
  expect(reply(messages.slice(0, 3))).toEqual({ text: "", files: [] });
});

it("lists every exit code in the skill's table", () => {
  const skill = readFileSync(new URL("../skills/rook-browser/SKILL.md", import.meta.url), "utf8");
  const table = [...skill.matchAll(/^\| (\d+) +\|/gmu)].map(([, code]) => Number(code));
  expect(table.toSorted((a, b) => a - b)).toEqual(Object.values(EXIT).toSorted((a, b) => a - b));
});

it("names this version wherever an agent installs it from", () => {
  const skill = readFileSync(new URL("../skills/rook-browser/SKILL.md", import.meta.url), "utf8");
  expect(skill).toContain(`\`rook ${packageJson.version} (${packageJson.name})\``);
  expect(skill).toContain(`\`npx -y ${packageJson.name}@${packageJson.version}\``);
  expect(plugin.version).toBe(packageJson.version);
  expect(codexPlugin.version).toBe(packageJson.version);
  expect(marketplace.plugins[0]?.source).toEqual({
    source: "npm",
    package: packageJson.name,
    version: packageJson.version,
  });
});

it("prints a tool result's text and turns its images and resources into files", () => {
  expect(
    toolReply({
      content: [
        { type: "text", text: "found 2" },
        { type: "image", mimeType: "image/png", data: "AA==" },
        { type: "resource", resource: { uri: "file:///tmp/notes.txt", text: "hi" } },
        { type: "resource_link", uri: "https://example.com/a.pdf", name: "a.pdf" },
        { type: "text", text: "done" },
      ],
    }),
  ).toEqual({
    text: "found 2\ndone",
    files: [
      { type: "file", mediaType: "image/png", url: "data:image/png;base64,AA==" },
      {
        type: "file",
        mediaType: "application/octet-stream",
        url: "data:application/octet-stream;base64,aGk=",
        filename: "notes.txt",
      },
      { type: "file", mediaType: "application/octet-stream", url: "https://example.com/a.pdf" },
    ],
  });
  expect(toolInput(undefined)).toEqual({});
  for (const args of ["[1]", "{query: shoes}", "3"]) {
    expect(() => toolInput(args)).toThrow(expect.objectContaining({ code: 2 }));
  }
});
