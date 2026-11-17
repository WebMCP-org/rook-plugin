// `rook ask`, `run` and `stop`: how the packed CLI submits and controls work
// in Chrome through the fake peer.
import { randomUUID } from "node:crypto";
import { MessageType, type OutgoingMessage } from "agents/chat";
import { expect, it, vi } from "vitest";
import { events, fakePeer, THREAD } from "./testing/peer";
import type { WorkspaceExecutionResult } from "./wire/contracts";

it.each([
  ["running", "stopped the work running there\n"],
  ["completed", "nothing was running there\n"],
] as const)(
  "stop waits for remote work to confirm that it stopped, then prints the thread (%s)",
  async (outcome, said) => {
    const peer = await fakePeer({ outcome });
    try {
      const running = peer.start("stop", THREAD);
      await expect
        .poll(() => peer.calls.map(({ call }) => call.method))
        .toEqual(["turnOutcome", "stopCurrentWork"]);
      expect(running.child.exitCode).toBeNull();
      peer.respond("stopCurrentWork", null);
      expect(await running.result).toMatchObject({
        code: 0,
        signal: null,
        stdout: `${THREAD}\tstopped\n`,
        stderr: said,
      });
      await expect.poll(() => peer.disconnected).toBe(2);
      const again = peer.start("stop", THREAD, "--json");
      await expect
        .poll(() => peer.calls.filter(({ call }) => call.method === "stopCurrentWork"))
        .toHaveLength(2);
      peer.respond("stopCurrentWork", null);
      const json = await again.result;
      expect(JSON.parse(json.stdout)).toEqual({
        id: THREAD,
        profile: "lifecycl",
        status: "stopped",
        wasRunning: outcome === "running",
      });
    } finally {
      await peer.close();
    }
  },
);

it("refuses a new thread id that is not a UUID, and a blank prompt, before submitting", async () => {
  const peer = await fakePeer();
  try {
    const id = await peer.start("ask", "hello", "--id", "not-a-uuid").result;
    expect(id).toMatchObject({ code: 2, signal: null, stdout: "" });
    expect(id.stderr).toContain(
      "rook: --id takes a UUID, such as uuidgen prints: not-a-uuid is not one\n",
    );
    const blank = await peer.start("ask", "  ").result;
    expect(blank).toMatchObject({
      code: 2,
      signal: null,
      stdout: "",
      stderr: "rook: usage: rook ask PROMPT (or pipe the prompt on stdin)\n",
    });
    expect(peer.calls).toEqual([]);
  } finally {
    await peer.close();
  }
});

it("acknowledges a resumed ask and keeps streamed JSON before its final result", async () => {
  const peer = await fakePeer({ greeting: "resume", outcome: "held" });
  try {
    // Repeating an admitted --id observes that run without submitting it again.
    const running = peer.start("ask", "hello", "--id", THREAD, "--json", "--timeout", "0");
    await expect
      .poll(() => peer.received)
      .toContainEqual({ type: MessageType.CF_AGENT_STREAM_RESUME_ACK, id: "turn" });
    await expect.poll(() => peer.calls.length).toBe(1);
    const tool: OutgoingMessage = {
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      id: "turn",
      done: false,
      body: JSON.stringify({
        type: "tool-input-available",
        toolCallId: "call",
        toolName: "execute",
        input: {},
      }),
    };
    for (const socket of peer.conversations) socket.send(JSON.stringify(tool));
    peer.stream();
    peer.respond("turnOutcome", "completed");
    const result = await running.result;
    expect(result, `${result.stderr}\n${result.stdout}`).toMatchObject({ code: 0, signal: null });
    const lines = events(result.stdout);
    expect(lines.map(({ type }) => type)).toEqual(["run.started", "tool", "message", "result"]);
    expect(lines[0]).toMatchObject({
      thread: THREAD,
      new: false,
      queued: false,
      repeat: true,
      message: THREAD,
    });
    expect(lines[1]).toMatchObject({ name: "execute" });
    expect(lines[2]).toMatchObject({ text: "Finished." });
    expect(lines[3]).toMatchObject({ status: "completed", text: "Finished.", exit: 0 });
    expect(peer.calls.map(({ call }) => call.method)).toEqual(["turnOutcome"]);
  } finally {
    await peer.close();
  }
});

it("drains several small JSON writes to a slow pipe before a nonzero exit", async () => {
  const peer = await fakePeer({ greeting: "resume", outcome: "held", holdOutput: true });
  try {
    const running = peer.start("ask", "hello", "--id", THREAD, "--json", "--timeout", "0");
    await expect
      .poll(() => peer.received)
      .toContainEqual({ type: MessageType.CF_AGENT_STREAM_RESUME_ACK, id: "turn" });
    await expect.poll(() => peer.calls.length).toBe(1);
    const size = Math.ceil((running.pipeCapacity + 30_000) / 3);
    expect(size).toBeLessThan(64 * 1024);
    const messages = ["a", "b", "c"].map((letter) => letter.repeat(size));
    peer.stream(messages);
    peer.respond("turnOutcome", "aborted");
    // Let command work and its local connections finish while stdout remains
    // unread. The final drain must keep the process alive until we consume it.
    await expect.poll(() => peer.disconnected).toBe(2);
    running.resumeOutput();
    const result = await running.result;
    expect(result, result.stderr).toMatchObject({ code: 6, signal: null });
    const lines = events(result.stdout);
    expect(lines.map(({ type }) => type)).toEqual([
      "run.started",
      "message",
      "message",
      "message",
      "result",
    ]);
    expect(lines.filter(({ type }) => type === "message").map(({ text }) => text)).toEqual(
      messages,
    );
    expect(lines.at(-1)).toMatchObject({ type: "result", status: "stopped", exit: 6 });
  } finally {
    await peer.close();
  }
});

it("run prints the script result received from Chrome", async () => {
  const peer = await fakePeer();
  try {
    const running = peer.start("run", "/automations/example.ts", "--thread", THREAD, "--json");
    await expect.poll(() => peer.calls.map(({ call }) => call.method)).toEqual(["runAutomation"]);
    const execution: WorkspaceExecutionResult = {
      executionId: "execution",
      files: [],
      logs: ["finished"],
      result: { answer: 42 },
    };
    peer.finishExecution(execution);
    const result = await running.result;
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(events(result.stdout)).toEqual([
      expect.objectContaining({ type: "execution", thread: THREAD, exit: 0, ...execution }),
    ]);
    // A thread the caller named is never removed.
    expect(peer.calls.map(({ call }) => call.method)).toEqual(["runAutomation"]);
    expect(peer.state.threads.map(({ id }) => id)).toEqual([THREAD]);
  } finally {
    await peer.close();
  }
});

it.each(["succeeds", "fails"] as const)(
  "run without --thread removes the thread it minted once its script %s",
  async (ending) => {
    const peer = await fakePeer({ threads: [] });
    try {
      const running = peer.start("run", "/automations/example.ts", "--json");
      await expect.poll(() => peer.calls.map(({ call }) => call.method)).toEqual(["runAutomation"]);
      const [minted] = peer.calls[0]!.call.args;
      expect(peer.state.threads).toEqual([
        expect.objectContaining({ id: minted, title: "example.ts" }),
      ]);
      // The execution observer is connected to the conversation the delete closes.
      await expect.poll(() => peer.conversations.size).toBe(1);
      const execution: WorkspaceExecutionResult = {
        executionId: "execution",
        files: [],
        logs: [],
        result: "done",
      };
      if (ending === "succeeds") peer.finishExecution(execution);
      else peer.failExecution("script threw");
      const result = await running.result;
      expect(result, result.stderr).toMatchObject({
        code: ending === "succeeds" ? 0 : 1,
        signal: null,
        stderr: "",
      });
      expect(events(result.stdout)).toEqual([
        ending === "succeeds"
          ? expect.objectContaining({ type: "execution", thread: minted, exit: 0, ...execution })
          : expect.objectContaining({ type: "error", exit: 1, message: "script threw" }),
      ]);
      expect(peer.calls.map(({ call }) => [call.method, call.args])).toEqual([
        ["runAutomation", [minted, "/automations/example.ts", {}]],
        ...(ending === "fails" ? [["turnOutcome", []]] : []),
        ["deleteThread", [minted]],
      ]);
      expect(peer.state.threads).toEqual([]);
    } finally {
      await peer.close();
    }
  },
);

it.each(["timeout", "signal"] as const)(
  "run %s retains its thread and trace path without stopping the script",
  async (reason) => {
    const peer = await fakePeer({ threads: [] });
    try {
      const running = peer.start(
        "run",
        "/automations/example.ts",
        "--json",
        "--timeout",
        // Long enough for the observer to connect and learn the execution id.
        reason === "timeout" ? "3s" : "0",
      );
      await expect.poll(() => peer.calls.map(({ call }) => call.method)).toEqual(["runAutomation"]);
      await expect.poll(() => peer.conversations.size).toBe(1);
      if (reason === "signal") running.child.kill("SIGTERM");
      const result = await running.result;
      const exit = reason === "timeout" ? 124 : 143;
      expect(result, result.stderr).toMatchObject({ code: exit, signal: null });
      expect(events(result.stdout).at(-1)).toMatchObject({
        type: "error",
        exit,
        message: expect.stringContaining("/executions/results/execution.trace.json"),
      });
      expect(peer.calls.map(({ call }) => call.method)).toEqual(["runAutomation"]);
      // `rook stop` must still reach a run the CLI stopped waiting for.
      expect(peer.state.threads.map(({ id }) => id)).toEqual([peer.calls[0]!.call.args[0]]);
      await expect.poll(() => peer.disconnected).toBe(2);
      const late: WorkspaceExecutionResult = {
        executionId: "execution",
        files: [],
        logs: [],
        result: "completed after the CLI left",
      };
      peer.finishExecution(late);
      await expect.poll(() => peer.executionResult).toEqual(late);
    } finally {
      await peer.close();
    }
  },
);

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

// Rook delivers a conversation's pending telemetry before deleting it, so a
// traced run removes the thread it minted like any other.
it.each([
  { carrier: TRACEPARENT, sent: TRACEPARENT },
  { carrier: "not-a-traceparent", sent: undefined },
])(
  "run with TRACEPARENT=$carrier sends $sent with the call and removes its thread",
  async ({ carrier, sent }) => {
    vi.stubEnv("TRACEPARENT", carrier);
    const peer = await fakePeer({ threads: [] });
    try {
      const running = peer.start("run", "/automations/example.ts", "--json");
      await expect.poll(() => peer.calls.map(({ call }) => call.method)).toEqual(["runAutomation"]);
      expect(peer.calls[0]!.call.traceparent).toBe(sent);
      await expect.poll(() => peer.conversations.size).toBe(1);
      peer.finishExecution({ executionId: "execution", files: [], logs: [], result: "done" });
      const result = await running.result;
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(peer.calls.map(({ call }) => call.method)).toEqual(["runAutomation", "deleteThread"]);
      expect(peer.state.threads).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
      await peer.close();
    }
  },
);

it("ask sends the caller's TRACEPARENT with the thread it starts", async () => {
  vi.stubEnv("TRACEPARENT", TRACEPARENT);
  const peer = await fakePeer({ threads: [] });
  try {
    const result = await peer.start("ask", "hello", "--detach").result;
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(peer.calls.map(({ call }) => [call.method, call.traceparent])).toEqual([
      ["startThread", TRACEPARENT],
    ]);
  } finally {
    vi.unstubAllEnvs();
    await peer.close();
  }
});

it("run whose call fails under a script still running keeps its thread and reports it running", async () => {
  const peer = await fakePeer({ threads: [], outcome: "running" });
  try {
    const running = peer.start("run", "/automations/example.ts", "--json");
    await expect.poll(() => peer.calls.map(({ call }) => call.method)).toEqual(["runAutomation"]);
    await expect.poll(() => peer.conversations.size).toBe(1);
    // What the SDK answers a transmitted call with when rook serve is replaced under it.
    peer.failExecution("Connection closed");
    const result = await running.result;
    expect(result, result.stderr).toMatchObject({ code: 124, signal: null });
    const minted = peer.calls[0]!.call.args[0];
    expect(events(result.stdout).at(-1)).toMatchObject({
      type: "error",
      exit: 124,
      message: expect.stringContaining(`stop: rook stop ${String(minted)}`),
    });
    expect(peer.calls.map(({ call }) => call.method)).toEqual(["runAutomation", "turnOutcome"]);
    expect(peer.state.threads.map(({ id }) => id)).toEqual([minted]);
  } finally {
    await peer.close();
  }
});

it.each([
  { refusal: "✖ Invalid path", exit: 1, message: "✖ Invalid path" },
  {
    refusal: "Method runAutomation does not exist",
    exit: 5,
    message: "ask the user to update Rook",
  },
])(
  "run refused before it starts ($refusal) exits $exit at once",
  async ({ refusal, exit, message }) => {
    const peer = await fakePeer({ threads: [], refuses: { runAutomation: refusal } });
    try {
      const result = await peer.start("run", "/automations/missing.ts", "--json").result;
      expect(result, result.stderr).toMatchObject({ code: exit, signal: null });
      expect(events(result.stdout)).toEqual([
        expect.objectContaining({ type: "error", exit, message: expect.stringContaining(message) }),
      ]);
      // Nothing was minted, so there is no conversation to ask and no thread to remove.
      expect(peer.calls.map(({ call }) => call.method)).toEqual(["runAutomation"]);
      expect(peer.state.threads).toEqual([]);
    } finally {
      await peer.close();
    }
  },
);

const methods = (peer: { calls: { call: { method: string } }[] }) =>
  peer.calls.map(({ call }) => call.method);

/** `rook ask --thread THREAD --id id`, a follow-up, observed without a deadline. */
const followUp = (peer: Awaited<ReturnType<typeof fakePeer>>, id: string, ...flags: string[]) =>
  peer.start("ask", "--thread", THREAD, "--id", id, "--timeout", "0", ...flags, "again");

const running = (peer: Awaited<ReturnType<typeof fakePeer>>) => {
  peer.state.threads = peer.state.threads.map((thread) => ({ ...thread, status: "running" }));
};

it("a repeated --id whose message a stop skipped settles stopped at once", async () => {
  const peer = await fakePeer();
  try {
    const id = randomUUID();
    peer.submissions.set(id, { status: "skipped" });
    const result = await followUp(peer, id).result;
    expect(result, result.stderr).toMatchObject({ code: 6, signal: null, stdout: "" });
    expect(result.stderr).toContain("stopped: the message was skipped before it ran");
    expect(methods(peer)).toEqual(["submitMessage", "inspectSubmission"]);
  } finally {
    await peer.close();
  }
});

it("a follow-up that fails before its message is added reports its own error, not the last turn's", async () => {
  const peer = await fakePeer({ outcome: "error", terminal: "An earlier turn's error." });
  try {
    const id = randomUUID();
    const pending = followUp(peer, id, "--json");
    await expect.poll(() => methods(peer)).toContain("inspectSubmission");
    peer.submissions.set(id, { status: "error", error: "The model is unavailable." });
    const result = await pending.result;
    expect(result, result.stderr).toMatchObject({ code: 1, signal: null });
    const lines = events(result.stdout);
    expect(lines.map(({ type }) => type)).toEqual(["run.started", "error", "result"]);
    expect(lines[1]).toMatchObject({ message: "The model is unavailable." });
    expect(lines[2]).toMatchObject({ status: "failed", exit: 1 });
  } finally {
    await peer.close();
  }
});

it.each([false, true])(
  "a queued follow-up streams and reports only its own turn while a later one runs (later human wait: %s)",
  async (human) => {
    const peer = await fakePeer({ outcome: "running" });
    try {
      running(peer);
      const id = randomUUID();
      const pending = followUp(peer, id, "--json");
      await expect.poll(() => peer.conversations.size).toBe(1);
      // The turn ahead of it, its own, then a later message's, each started
      // as Think starts one: the transcript with its user message comes first.
      peer.stream(["Earlier."]);
      peer.messages.push({ id, role: "user", parts: [{ type: "text", text: "again" }] });
      peer.greet();
      peer.stream(["Second answer."], id);
      peer.messages.push(
        { id: "second", role: "assistant", parts: [{ type: "text", text: "Second answer." }] },
        { id: "later", role: "user", parts: [{ type: "text", text: "later" }] },
      );
      peer.greet();
      peer.stream(["Later."], "later");
      peer.submissions.set(id, { status: "completed" });
      if (human) {
        peer.state.browser.waits = {
          wait: { threadId: THREAD, tabId: 7, reason: "Sign in", expiresAt: Date.now() + 60_000 },
        };
        await peer.publishState();
      }
      const result = await pending.result;
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      const lines = events(result.stdout);
      expect(lines.map(({ type }) => type)).toEqual(["run.started", "message", "result"]);
      expect(lines[0]).toMatchObject({ queued: true, repeat: false, message: id });
      expect(lines[1]).toMatchObject({ text: "Second answer." });
      expect(lines[2]).toMatchObject({ status: "completed", text: "Second answer.", exit: 0 });
    } finally {
      await peer.close();
    }
  },
);

it("a follow-up to a Rook without inspectSubmission follows the thread", async () => {
  const peer = await fakePeer({
    refuses: { inspectSubmission: "Method inspectSubmission is not callable" },
  });
  try {
    running(peer);
    const pending = followUp(peer, randomUUID());
    await expect.poll(() => methods(peer)).toContain("inspectSubmission");
    peer.state.threads = peer.state.threads.map((thread) => ({
      ...thread,
      status: "idle",
      updatedAt: Date.now(),
    }));
    await peer.publishState();
    const result = await pending.result;
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stdout: "Finished.\n" });
    // Asked once per command, not once per poll.
    expect(methods(peer).filter((method) => method === "inspectSubmission")).toHaveLength(1);
    expect(methods(peer).at(-1)).toBe("turnOutcome");
  } finally {
    await peer.close();
  }
});

it("a detached ask says whether its message started, queued or was already submitted", async () => {
  const peer = await fakePeer({ threads: [] });
  try {
    const fresh = await peer.start("ask", "hello", "--detach").result;
    expect(fresh, fresh.stderr).toMatchObject({ code: 0, signal: null });
    expect(fresh.stderr).toContain("the message started\n");
    const [minted] = peer.calls[0]!.call.args;
    expect(fresh.stdout).toBe(`${String(minted)}\n`);
  } finally {
    await peer.close();
  }
  const busy = await fakePeer();
  try {
    running(busy);
    const id = randomUUID();
    const queued = await followUp(busy, id, "--detach").result;
    expect(queued, queued.stderr).toMatchObject({ code: 0, signal: null, stdout: `${THREAD}\n` });
    expect(queued.stderr).toContain("the message runs after the current turn\n");
    const repeated = await followUp(busy, id, "--detach", "--json").result;
    expect(repeated, repeated.stderr).toMatchObject({ code: 0, signal: null });
    expect(events(repeated.stdout)).toEqual([
      expect.objectContaining({ type: "run.started", queued: false, repeat: true, message: id }),
    ]);
    expect((await followUp(busy, id, "--detach").result).stderr).toContain(
      "this message was already submitted; reporting that submission\n",
    );
  } finally {
    await busy.close();
  }
});

it("a first ask whose turn fails reports failed with Rook's error", async () => {
  const failure = "Failed to process successful response";
  // Rook mints a thread only under a UUID.
  const id = randomUUID();
  const peer = await fakePeer({ outcome: "error", terminal: failure, threads: [id] });
  try {
    const roster = (status: "running" | "error") => {
      peer.state.threads = [{ id: id, title: "New chat", updatedAt: Date.now(), status }];
      return peer.publishState();
    };
    peer.state.threads = [];
    const pending = peer.start("ask", "hello", "--id", id, "--json", "--timeout", "10s");
    await expect.poll(() => methods(peer)).toEqual(["startThread"]);
    await expect.poll(() => peer.conversations.size).toBe(1);
    await roster("running");
    const frame: OutgoingMessage = {
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      id: "turn",
      done: true,
      error: true,
      body: failure,
    };
    for (const socket of peer.conversations) socket.send(JSON.stringify(frame));
    await roster("error");
    const result = await pending.result;
    expect(result, result.stderr).toMatchObject({ code: 1, signal: null });
    const lines = events(result.stdout);
    expect(lines.map(({ type }) => type)).toEqual(["run.started", "error", "result"]);
    expect(lines[0]).toMatchObject({ new: true, repeat: false, message: id });
    expect(lines[1]).toMatchObject({ code: "run_failed", message: failure });
    expect(lines[2]).toMatchObject({ status: "failed", exit: 1 });
  } finally {
    await peer.close();
  }
});
