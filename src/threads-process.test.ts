// `rook rm` and `rename`: how the packed CLI tidies the thread list through
// the fake peer.
import { expect, it } from "vitest";
import { z } from "zod";
import { fakePeer, THREAD } from "./testing/peer";

const OTHER = "other-thread";

it("rm deletes the thread a prefix names and prints its full id", async () => {
  const peer = await fakePeer({ threads: [THREAD, OTHER] });
  try {
    const result = await peer.start("rm", "lifecycle", "--json").result;
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(
      z.object({ id: z.string(), profile: z.string() }).parse(JSON.parse(result.stdout)),
    ).toEqual({ id: THREAD, profile: "lifecycl" });
    expect(peer.calls.map(({ call }) => [call.method, call.args])).toEqual([
      ["deleteThread", [THREAD]],
    ]);
    expect(peer.state.threads.map(({ id }) => id)).toEqual([OTHER]);
  } finally {
    await peer.close();
  }
});

it("rm deletes every thread it names and prints each", async () => {
  const peer = await fakePeer({ threads: [THREAD, OTHER] });
  try {
    const result = await peer.start("rm", "lifecycle", OTHER).result;
    expect(result, result.stderr).toMatchObject({
      code: 0,
      signal: null,
      stdout: `${THREAD}\n${OTHER}\n`,
    });
    expect(peer.calls.map(({ call }) => [call.method, call.args])).toEqual([
      ["deleteThread", [THREAD]],
      ["deleteThread", [OTHER]],
    ]);
    expect(peer.state.threads).toEqual([]);
  } finally {
    await peer.close();
  }
});

it("rm deletes a thread named twice, by prefix and in full, once", async () => {
  const peer = await fakePeer({ threads: [THREAD, OTHER] });
  try {
    const result = await peer.start("rm", "lifecycle", THREAD).result;
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stdout: `${THREAD}\n` });
    expect(peer.calls.map(({ call }) => [call.method, call.args])).toEqual([
      ["deleteThread", [THREAD]],
    ]);
    expect(peer.state.threads.map(({ id }) => id)).toEqual([OTHER]);
  } finally {
    await peer.close();
  }
});

it("rm with one unknown prefix exits 2 and deletes nothing", async () => {
  const peer = await fakePeer({ threads: [THREAD, OTHER] });
  try {
    const result = await peer.start("rm", OTHER, "missing").result;
    expect(result).toMatchObject({ code: 2, signal: null, stdout: "" });
    expect(result.stderr).toContain("no thread missing");
    expect(peer.calls).toEqual([]);
    expect(peer.state.threads.map(({ id }) => id)).toEqual([THREAD, OTHER]);
  } finally {
    await peer.close();
  }
});

it("rename sends the title's words joined by spaces", async () => {
  const peer = await fakePeer();
  try {
    const result = await peer.start("rename", "lifecycle", "Digest", "for", "Friday").result;
    expect(result, result.stderr).toMatchObject({
      code: 0,
      signal: null,
      stdout: `${THREAD}\tDigest for Friday\n`,
    });
    expect(peer.calls.map(({ call }) => [call.method, call.args])).toEqual([
      ["renameThread", [THREAD, "Digest for Friday"]],
    ]);
    expect(peer.state.threads[0]?.title).toBe("Digest for Friday");
  } finally {
    await peer.close();
  }
});

it("rename refuses a 49-character title before reaching Rook", async () => {
  const peer = await fakePeer();
  try {
    const result = await peer.start("rename", THREAD, "x".repeat(49)).result;
    expect(result).toMatchObject({ code: 2, signal: null, stdout: "" });
    expect(result.stderr).toContain("1 to 48 characters");
    expect(peer.discoveries).toBe(0);
    expect(peer.calls).toEqual([]);
  } finally {
    await peer.close();
  }
});

it.each(["   ", ""])("rename refuses the blank title %j before reaching Rook", async (title) => {
  const peer = await fakePeer();
  try {
    const result = await peer.start("rename", THREAD, title).result;
    expect(result).toMatchObject({ code: 2, signal: null, stdout: "" });
    expect(result.stderr).toContain("1 to 48 characters");
    expect(peer.discoveries).toBe(0);
    expect(peer.calls).toEqual([]);
  } finally {
    await peer.close();
  }
});

it("rename against a Rook that predates renameThread exits 5 asking for an update", async () => {
  const peer = await fakePeer({ refuses: { renameThread: "Method renameThread does not exist" } });
  try {
    const result = await peer.start("rename", THREAD, "Digest").result;
    expect(result).toMatchObject({ code: 5, signal: null, stdout: "" });
    expect(result.stderr).toContain("ask the user to update Rook");
    expect(peer.state.threads[0]?.title).not.toBe("Digest");
  } finally {
    await peer.close();
  }
});

it("rm ends another process's wait on that thread as stopped", async () => {
  // Keep the status RPC in flight when the deleting process closes the socket.
  const peer = await fakePeer({ outcome: "held" });
  try {
    const waiting = peer.start("wait", THREAD, "--timeout", "0");
    await expect.poll(() => peer.calls.map(({ call }) => call.method)).toContain("turnOutcome");
    const removed = await peer.start("rm", THREAD).result;
    expect(removed, removed.stderr).toMatchObject({ code: 0, signal: null });
    const result = await waiting.result;
    expect(result).toMatchObject({
      code: 6,
      signal: null,
      stdout: "",
      stderr: expect.stringContaining("stopped: the thread was deleted\n"),
    });
  } finally {
    await peer.close();
  }
});

it("wait reports a connection error when the closed thread remains in the roster", async () => {
  const peer = await fakePeer({ outcome: "held" });
  try {
    const waiting = peer.start("wait", THREAD, "--timeout", "0");
    await expect.poll(() => peer.calls.map(({ call }) => call.method)).toContain("turnOutcome");
    const statusRead = peer.calls.find(({ call }) => call.method === "turnOutcome");
    if (!statusRead) throw new Error("The waiter did not ask for the turn outcome");
    statusRead.socket.close();
    expect(await waiting.result).toMatchObject({
      code: 1,
      stderr: "rook: Connection closed\n",
    });
    expect(peer.state.threads.map(({ id }) => id)).toEqual([THREAD]);
  } finally {
    await peer.close();
  }
});
