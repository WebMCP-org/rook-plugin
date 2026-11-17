// `rook ls`, `wait` and human waits: how the packed CLI observes Chrome work
// through the fake peer, and how its deadlines and signals bound that.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { events, fakePeer, opened, THREAD } from "./testing/peer";
import { ROOK_EXTENSION_IDS } from "./wire/contracts";

it("skips a profile with no state while retaining its answering peer", async () => {
  const peer = await fakePeer({ brokenProfile: true });
  try {
    const result = await peer.start("ls", "--json").result;
    expect(result).toMatchObject({ code: 0, signal: null });
    expect(z.object({ id: z.string() }).parse(JSON.parse(result.stdout))).toEqual({
      id: "lifecycle-profile",
    });
    expect(result.stderr).toContain("skipped");
    expect(peer.calls).toEqual([]);
    await expect.poll(() => peer.disconnected).toBe(2);
  } finally {
    await peer.close();
  }
});

it.each([
  ["completed", "completed", 0],
  ["error", "failed", 1],
  ["aborted", "stopped", 6],
] as const)(
  "uses the recorded %s outcome even after the roster becomes idle",
  async (outcome, status, code) => {
    const peer = await fakePeer({ outcome });
    try {
      const result = await peer.start("wait", THREAD, "--json", "--timeout", "2s").result;
      expect(result, result.stderr).toMatchObject({ code, signal: null });
      expect(events(result.stdout).at(-1)).toMatchObject({
        type: "result",
        status,
        exit: code,
        thread: THREAD,
      });
      expect(peer.calls.map(({ call }) => call.method)).toEqual(["turnOutcome"]);
      await expect.poll(() => peer.disconnected).toBe(2);
    } finally {
      await peer.close();
    }
  },
);

it.each([{ greeting: "held" }, { outcome: "running" }, { outcome: "held" }] as const)(
  "bounds the entire observation: %j",
  async (options) => {
    const peer = await fakePeer(options);
    try {
      const result = await peer.start("wait", THREAD, "--json", "--timeout", "700ms").result;
      expect(result, result.stderr).toMatchObject({ code: 124, signal: null });
      expect(events(result.stdout).at(-1)).toMatchObject({
        type: "result",
        status: "running",
        exit: 124,
      });
      expect(peer.calls.every(({ call }) => call.method === "turnOutcome")).toBe(true);
      await expect.poll(() => peer.disconnected).toBe(2);
    } finally {
      await peer.close();
    }
  },
);

it.each(["headers", "body"] as const)(
  "includes stalled discovery %s in the launch deadline",
  async (discovery) => {
    const peer = await fakePeer({ discovery });
    try {
      const result = await peer.start("wait", THREAD, "--json", "--timeout", "700ms").result;
      expect(result, result.stderr).toMatchObject({ code: 5, signal: null });
      expect(events(result.stdout).at(-1)).toMatchObject({ type: "error", exit: 5 });
      expect(peer.discoveries).toBeGreaterThan(0);
      expect(peer.calls).toEqual([]);
    } finally {
      await peer.close();
    }
  },
);

it.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)(
  "%s interrupts a pending outcome without stopping Chrome work",
  async (signal, code) => {
    const peer = await fakePeer({ outcome: "held" });
    try {
      const running = peer.start("wait", THREAD, "--json", "--timeout", "0");
      await expect.poll(() => peer.calls.length).toBe(1);
      running.child.kill(signal);
      const result = await running.result;
      expect(result, result.stderr).toMatchObject({ code, signal: null });
      expect(events(result.stdout).at(-1)).toMatchObject({
        type: "result",
        status: "running",
        exit: code,
      });
      expect(peer.calls.map(({ call }) => call.method)).toEqual(["turnOutcome"]);
      await expect.poll(() => peer.disconnected).toBe(2);
    } finally {
      await peer.close();
    }
  },
);

it("timeout zero waits for a delayed greeting and outcome", async () => {
  const peer = await fakePeer({ greeting: "held", outcome: "held" });
  try {
    const running = peer.start("wait", THREAD, "--json", "--timeout", "0");
    await expect.poll(() => peer.conversations.size).toBe(1);
    expect(running.child.exitCode).toBeNull();
    expect(peer.calls).toEqual([]);
    peer.greet();
    await expect.poll(() => peer.calls.length).toBe(1);
    expect(running.child.exitCode).toBeNull();
    peer.respond("turnOutcome", "completed");
    const result = await running.result;
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(events(result.stdout).at(-1)).toMatchObject({
      type: "result",
      text: "Finished.",
      exit: 0,
    });
  } finally {
    await peer.close();
  }
});

it.each([false, true])("human wait preserves --wait-human=%s", async (waitHuman) => {
  const peer = await fakePeer({ human: true, outcome: "running" });
  try {
    const result = await peer.start(
      "wait",
      THREAD,
      "--json",
      "--timeout",
      "700ms",
      ...(waitHuman ? ["--wait-human"] : []),
    ).result;
    const exit = waitHuman ? 124 : 3;
    expect(result, result.stderr).toMatchObject({ code: exit, signal: null });
    const lines = events(result.stdout);
    expect(lines.at(-1)).toMatchObject({
      type: "result",
      status: waitHuman ? "running" : "needs_human",
      exit,
    });
    if (waitHuman) expect(lines.some(({ type }) => type === "needs_human")).toBe(false);
    else expect(lines[0]).toMatchObject({ type: "needs_human", tab: 7, reason: "Sign in" });
    expect(peer.calls.every(({ call }) => call.method === "turnOutcome")).toBe(true);
  } finally {
    await peer.close();
  }
});

it("ls lists every Chrome profile and whether Rook is connected or installed, opening nothing", async () => {
  const peer = await fakePeer();
  try {
    peer.state.profileVerification = { status: "verified", email: "ada@example.com" };
    const userData = join(
      peer.home,
      process.platform === "darwin"
        ? "Library/Application Support/Google/Chrome"
        : ".config/google-chrome",
    );
    await mkdir(join(userData, "Profile 1", "Extensions", ROOK_EXTENSION_IDS.production), {
      recursive: true,
    });
    await writeFile(
      join(userData, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { user_name: "Ada@example.com" },
            "Profile 1": { user_name: "grace@example.com" },
            "Profile 2": {},
          },
        },
      }),
    );
    const result = await peer.start("ls").result;
    expect(result, result.stderr).toMatchObject({
      code: 0,
      signal: null,
      stdout:
        "ada@example.com\tlifecycle-profile\t0 running\n" +
        "grace@example.com\t-\tnot connected\n" +
        "Profile 2\t-\tno Rook\n",
    });
    const filtered = await peer.start("ls", "--profile", "grace@example.com", "--json").result;
    expect(filtered, filtered.stderr).toMatchObject({ code: 0, signal: null });
    expect(JSON.parse(filtered.stdout)).toEqual({
      label: "grace@example.com",
      dir: "Profile 1",
      state: "installed",
    });
    expect(await opened(peer.home)).toBe("");
  } finally {
    await peer.close();
  }
});

it("ls with a --profile that names no profile fails as a usage error", async () => {
  const peer = await fakePeer();
  try {
    const result = await peer.start("ls", "--profile", "nope").result;
    expect(result).toMatchObject({ code: 2, signal: null, stdout: "" });
    expect(result.stderr).toContain("no connected profile or Chrome profile is nope");
  } finally {
    await peer.close();
  }
});

it("show prints a thread mid-turn, that it is running, and a failed tool call's error", async () => {
  const peer = await fakePeer({ greeting: "resume", outcome: "running" });
  try {
    peer.messages.push({
      id: "tools",
      role: "assistant",
      parts: [
        {
          type: "tool-execute",
          toolCallId: "call",
          state: "output-error",
          input: {},
          errorText: `${"x".repeat(250)}\nat stack`,
        },
      ],
    });
    const result = await peer.start("show", THREAD, "--tools").result;
    expect(result, result.stderr).toMatchObject({
      code: 0,
      signal: null,
      stdout: `## you\n\nhello\n\n## rook\n\nFinished.\n\n## rook\n\n· execute output-error: ${"x".repeat(200)}\n\n`,
      stderr: `still running: rook wait ${THREAD}   stop: rook stop ${THREAD}\n`,
    });
    expect(methodsOf(peer)).toEqual(["getMessages", "turnOutcome"]);
  } finally {
    await peer.close();
  }
});

it("saves a thread's reply files under names that never replace one another", async () => {
  const peer = await fakePeer({ outcome: "completed" });
  try {
    const png = (data: string) => ({
      type: "file" as const,
      mediaType: "image/png",
      url: `data:image/png;base64,${data}`,
    });
    const chart = (data: string) => ({ ...png(data), filename: "chart.png" });
    // Two replies, each with an unnamed image and a chart.png of its own.
    peer.messages.push(
      { id: "first", role: "assistant", parts: [png("AA=="), chart("AQ==")] },
      { id: "second", role: "assistant", parts: [png("Ag=="), chart("Aw==")] },
    );
    const result = await peer.start("show", THREAD).result;
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    const saved = [...result.stdout.matchAll(/^file: (.+)$/gmu)].map(([, path]) => path ?? "");
    expect(await Promise.all(saved.map((path) => readFile(path, "base64")))).toEqual([
      "AA==",
      "AQ==",
      "Ag==",
      "Aw==",
    ]);
    expect(saved.map((path) => basename(path))).toEqual([
      expect.stringMatching(/^[0-9a-f]{12}\.png$/u),
      "chart.png",
      expect.stringMatching(/^[0-9a-f]{12}\.png$/u),
      expect.stringMatching(/^chart-[0-9a-f]{12}\.png$/u),
    ]);
    // Reading the thread again names the same files.
    const again = await peer.start("show", THREAD).result;
    expect(again.stdout).toBe(result.stdout);
  } finally {
    await peer.close();
  }
});

it("refuses to choose a profile while another connected one has not answered", async () => {
  const peer = await fakePeer({ brokenProfile: true });
  try {
    const result = await peer.start("ask", "hello", "--detach").result;
    expect(result).toMatchObject({ code: 5, signal: null, stdout: "" });
    expect(result.stderr).toContain(
      "1 connected profile did not answer, so rook cannot tell which profile to use: run this again, or pass --profile <email> (answering: lifecycl)",
    );
    expect(peer.calls).toEqual([]);
    // The thread may be in the profile that did not answer.
    const missing = await peer.start("wait", "missing").result;
    expect(missing).toMatchObject({ code: 5, signal: null, stdout: "" });
    expect(missing.stderr).toContain(
      "no thread missing in lifecycl, and 1 connected profile did not answer: run this again",
    );
    // Naming the one that answers is enough.
    const named = await peer.start("ask", "hello", "--detach", "--profile", "lifecycl").result;
    expect(named, named.stderr).toMatchObject({ code: 0, signal: null });
  } finally {
    await peer.close();
  }
});

it("names the profiles it searched for a thread id it did not find", async () => {
  const peer = await fakePeer();
  try {
    const result = await peer.start("wait", "missing").result;
    expect(result).toMatchObject({ code: 2, signal: null, stdout: "" });
    expect(result.stderr).toContain("no thread missing in connected profiles lifecycl");
  } finally {
    await peer.close();
  }
});

const FAILURE = "Failed to process successful response";

it("show says why the thread's last turn failed, in text and JSON", async () => {
  const peer = await fakePeer({ outcome: "error", terminal: FAILURE });
  try {
    const result = await peer.start("show", THREAD).result;
    expect(result, result.stderr).toMatchObject({
      code: 0,
      signal: null,
      stdout: "## you\n\nhello\n\n## rook\n\nFinished.\n\n",
      stderr: `failed: ${FAILURE}\n`,
    });
    const json = await peer.start("show", THREAD, "--json").result;
    expect(json, json.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(events(json.stdout).at(-1)).toMatchObject({
      type: "status",
      thread: THREAD,
      status: "failed",
      detail: FAILURE,
    });
  } finally {
    await peer.close();
  }
});

it("show reports a human wait as the thread's status", async () => {
  const peer = await fakePeer({ human: true, outcome: "running" });
  try {
    const result = await peer.start("show", THREAD, "--json").result;
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(events(result.stdout).at(-1)).toMatchObject({
      type: "status",
      status: "needs_human",
      detail: "Sign in",
    });
  } finally {
    await peer.close();
  }
});

it("wait on a thread whose last turn already failed says why", async () => {
  const peer = await fakePeer({ outcome: "error", terminal: FAILURE });
  try {
    const result = await peer.start("wait", THREAD, "--timeout", "5s").result;
    expect(result).toMatchObject({ code: 1, signal: null, stdout: "" });
    expect(result.stderr).toContain(`failed: ${FAILURE}\n`);
    const json = await peer.start("wait", THREAD, "--json", "--timeout", "5s").result;
    expect(json).toMatchObject({ code: 1, signal: null });
    expect(events(json.stdout).map(({ type }) => type)).toEqual(["error", "result"]);
    expect(events(json.stdout)[0]).toMatchObject({ code: "run_failed", message: FAILURE });
  } finally {
    await peer.close();
  }
});

it("ps lists a failed thread's roster status and when that status changed", async () => {
  const peer = await fakePeer();
  try {
    const updatedAt = Date.parse("2026-11-15T20:08:00.000Z");
    peer.state.threads = peer.state.threads.map((thread) => ({
      ...thread,
      status: "error",
      updatedAt,
    }));
    const result = await peer.start("ps", "--json").result;
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: THREAD,
      status: "error",
      updatedAt: "2026-11-15T20:08:00.000Z",
    });
    expect(peer.calls).toEqual([]);
  } finally {
    await peer.close();
  }
});

it("reads a bare --timeout number as seconds", async () => {
  const peer = await fakePeer({ outcome: "running" });
  try {
    const started = performance.now();
    const result = await peer.start("wait", THREAD, "--timeout", "1").result;
    const elapsed = performance.now() - started;
    expect(result).toMatchObject({ code: 124, signal: null });
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(5_000);
  } finally {
    await peer.close();
  }
});

const methodsOf = (peer: { calls: { call: { method: string } }[] }) =>
  peer.calls.map(({ call }) => call.method);
