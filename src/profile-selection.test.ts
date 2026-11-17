import { expect, it } from "vitest";
import { z } from "zod";
import { fakePeer } from "./testing/peer";

// The real CLI discovers two profiles and sends real AgentClient RPC frames.
// Only the remote relay/profile boundary is a stand-in; every model write is
// recorded, including writes made while discovering an unselected peer.
const profileBoundary = () =>
  fakePeer({
    profiles: ["assistant", "fresh-e2e"],
    threads: [],
    model: {
      version: 1,
      upstreams: { codex: { kind: "codex", transport: "ws" } },
      default: { upstream: "codex", model: "gpt-6-astra", effort: "high" },
      off: [],
    },
  });

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

it("accepts profile flags before the command without adopting unrelated profiles", async () => {
  const boundary = await profileBoundary();
  try {
    await boundary.run("--profile", "assistant", "tools", "--json");
    expect([...boundary.discovered].sort()).toEqual(["assistant", "fresh-e2e"]);
    expect(boundary.writes).toEqual(["assistant"]);
  } finally {
    await boundary.close();
  }
});

it("uses the parsed JSON flag value for output", async () => {
  const boundary = await profileBoundary();
  try {
    const machine = await boundary.run("ls", "--json=true");
    expect(
      machine.stdout
        .trim()
        .split("\n")
        .map((line) => z.object({ id: z.string() }).parse(JSON.parse(line)).id)
        .sort(),
    ).toEqual(["assistant", "fresh-e2e"]);
    const human = await boundary.run("ls", "--json=false");
    expect(human.stdout).toContain("\tassistant\t0 running\n");
    expect(human.stdout).toContain("\tfresh-e2e\t0 running\n");
    expect(boundary.writes).toEqual([]);
  } finally {
    await boundary.close();
  }
});

it("does not treat a literal prompt after -- as an output flag", async () => {
  const boundary = await profileBoundary();
  try {
    const result = await boundary.run("ask", "--profile", "assistant", "--detach", "--", "--json");
    expect(z.uuid().safeParse(result.stdout.trim()).success).toBe(true);
    expect(boundary.writes).toEqual(["assistant"]);
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
