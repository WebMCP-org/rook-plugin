// `rook model` and first-use model adoption: the settings file, the candidate
// probe and the profile's model write, as the packed CLI performs them.
import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MODEL_FILE, modelConfigSchema, type ModelConfig } from "./model-settings";
import { fakePeer, PROFILE, THREAD } from "./testing/peer";

it("validates a candidate privately, then merges settings changed while its probe was running", async () => {
  const peer = await fakePeer();
  try {
    const file = join(peer.home, MODEL_FILE);
    const original = await readFile(file, "utf8");
    const running = peer.start(
      "model",
      "url",
      peer.candidate,
      "--api",
      "chat",
      "--model",
      "candidate-model",
    );
    await expect.poll(() => peer.probes.length).toBe(1);
    expect(await readFile(file, "utf8")).toBe(original);
    expect(peer.calls).toEqual([]);
    // serve sends it to the candidate, which no model.json names yet.
    expect(peer.probes[0].upstream).toMatchObject({ kind: "url", baseUrl: peer.candidate });
    expect(peer.probes[0].body).toMatchObject({
      model: "candidate-model",
      messages: [{ role: "user", content: "Reply with the word ready." }],
    });
    await writeFile(
      file,
      JSON.stringify(
        modelConfigSchema.parse({
          version: 1,
          upstreams: { codex: { kind: "codex", transport: "http" } },
          default: null,
          off: ["other-profile", "lifecycle-profile"],
        }),
      ),
    );
    peer.probes[0].response.writeHead(200, { "content-type": "application/json" }).end("{}");
    const result = await running.result;
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    const saved = modelConfigSchema.parse(JSON.parse(await readFile(file, "utf8")));
    expect(saved).toMatchObject({
      version: 1,
      upstreams: { codex: { kind: "codex", transport: "http" }, url: { baseUrl: peer.candidate } },
      default: { upstream: "url", model: "candidate-model" },
      off: ["other-profile"],
    });
    expect(peer.calls.map(({ call }) => call.method)).toEqual(["setOpenAiCompatibleModelSource"]);
  } finally {
    await peer.close();
  }
});

it.each(["failure", "interrupt"] as const)(
  "does not publish or assign a candidate after probe %s",
  async (mode) => {
    const peer = await fakePeer();
    try {
      const file = join(peer.home, MODEL_FILE);
      const original = await readFile(file, "utf8");
      const running = peer.start(
        "model",
        "url",
        peer.candidate,
        "--api",
        "chat",
        "--model",
        "candidate-model",
      );
      await expect.poll(() => peer.probes.length).toBe(1);
      if (mode === "failure") peer.probes[0].response.writeHead(401).end("candidate refused");
      else running.child.kill("SIGTERM");
      const result = await running.result;
      expect(result, result.stderr).toMatchObject({
        code: mode === "failure" ? 1 : 143,
        signal: null,
      });
      expect(await readFile(file, "utf8")).toBe(original);
      expect(peer.calls).toEqual([]);
      await expect.poll(() => peer.probes[0].response.destroyed).toBe(true);
    } finally {
      await peer.close();
    }
  },
);

it.each([
  ["--header", "missing colon"],
  ["--header-cmd", "X=printf key", "--header-ttl", "0"],
  ["--header-env", "X="],
])(
  "rejects invalid model input %j before discovering profiles or changing settings",
  async (...invalid) => {
    const peer = await fakePeer();
    try {
      const file = join(peer.home, MODEL_FILE);
      const original = await readFile(file, "utf8");
      const result = await peer.start(
        "model",
        "url",
        peer.candidate,
        "--api",
        "chat",
        "--model",
        "m",
        ...invalid,
      ).result;
      expect(result, result.stderr).toMatchObject({ code: 2, signal: null });
      expect(peer.discoveries).toBe(0);
      expect(peer.probes).toEqual([]);
      expect(await readFile(file, "utf8")).toBe(original);
    } finally {
      await peer.close();
    }
  },
);

it("model off reports the state after the profile confirms its model was cleared", async () => {
  const peer = await fakePeer();
  try {
    peer.state.model = {
      kind: "openai-compatible",
      baseUrl: `${peer.origin}/url/v1`,
      modelId: "old-model",
    };
    const result = await peer.start("model", "off").result;
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(result.stdout).toContain("has no model");
    expect(peer.calls.map(({ call }) => [call.method, call.args])).toEqual([
      ["setOpenAiCompatibleModelSource", [null]],
    ]);
    expect(
      modelConfigSchema.parse(JSON.parse(await readFile(join(peer.home, MODEL_FILE), "utf8"))),
    ).toMatchObject({ default: null, off: ["lifecycle-profile"] });
  } finally {
    await peer.close();
  }
});

it.each(["chosen model", "managed policy"] as const)(
  "first-use adoption respects a %s arriving during Codex discovery",
  async (change) => {
    const peer = await fakePeer();
    let writer: number | undefined;
    try {
      await writeFile(
        join(peer.home, MODEL_FILE),
        JSON.stringify(modelConfigSchema.parse({ version: 1, upstreams: {}, off: [] })),
      );
      const codex = join(peer.home, "config.toml");
      execFileSync("mkfifo", [codex]);
      const running = peer.start("ask", "hello", "--id", THREAD, "--detach");
      await expect
        .poll(() => {
          try {
            writer = openSync(codex, constants.O_WRONLY | constants.O_NONBLOCK);
            return true;
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENXIO") return false;
            throw error;
          }
        })
        .toBe(true);
      if (change === "chosen model")
        peer.state.model = {
          kind: "openai-compatible",
          baseUrl: "https://chosen.example/v1",
          modelId: "chosen",
        };
      else
        peer.state.managedPolicy = {
          modelBaseUrl: "https://managed.example/v1",
          modelId: "managed",
        };
      await peer.publishState();
      writeSync(
        writer!,
        'model_provider = "corp"\nmodel = "candidate"\n[model_providers.corp]\nbase_url = "https://candidate.example/v1"\n',
      );
      closeSync(writer!);
      writer = undefined;
      const result = await running.result;
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(peer.calls).toEqual([]);
      expect(result.stderr).not.toContain("had no model");
    } finally {
      if (writer !== undefined) closeSync(writer);
      await peer.close();
    }
  },
);

it.each([
  ["another endpoint", "https://gateway.example/v1", false],
  ["Codex's endpoint", "https://candidate.example/v1", true],
] as const)(
  "first-use adoption keeps a url upstream a scoped rook model set on %s",
  async (_case, baseUrl, adopted) => {
    const scoped = modelConfigSchema.parse({
      version: 1,
      upstreams: {
        url: {
          kind: "url",
          baseUrl,
          api: "chat",
          transport: "http",
          headers: [{ name: "authorization", command: "corp-token", prefix: "Bearer " }],
          query: {},
        },
      },
      off: [],
    });
    const peer = await fakePeer({ model: scoped });
    try {
      await writeFile(
        join(peer.home, "config.toml"),
        'model_provider = "corp"\nmodel = "candidate"\n[model_providers.corp]\nbase_url = "https://candidate.example/v1"\n',
      );
      const result = await peer.start("ask", "hello", "--id", THREAD, "--detach").result;
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      const saved = modelConfigSchema.parse(
        JSON.parse(await readFile(join(peer.home, MODEL_FILE), "utf8")),
      );
      expect(saved.upstreams).toEqual(scoped.upstreams);
      expect(saved.default).toEqual(adopted ? { upstream: "url", model: "candidate" } : undefined);
      expect(peer.writes).toEqual(adopted ? [PROFILE] : []);
    } finally {
      await peer.close();
    }
  },
);

const withDefault = modelConfigSchema.parse({
  version: 1,
  upstreams: { codex: { kind: "codex", transport: "ws" } },
  default: { upstream: "codex", model: "gpt-6-astra" },
  off: [],
});

it("a scoped model off outlives the profile's reconnect under a new host id when it has a verified email", async () => {
  const launch = async (id: string, model: ModelConfig) => {
    const peer = await fakePeer({ profiles: [id], threads: [], model });
    peer.state.profileVerification = { status: "verified", email: "Me@Example.com" };
    return peer;
  };
  const before = await launch("launch-before", withDefault);
  let saved: ModelConfig;
  try {
    await before.run("model", "off", "--profile", "me@example.com");
    saved = modelConfigSchema.parse(
      JSON.parse(await readFile(join(before.home, MODEL_FILE), "utf8")),
    );
    expect(saved).toMatchObject({ default: withDefault.default, off: ["me@example.com"] });
    expect(before.leases).toEqual(["POST /leases/model", "DELETE /leases/model"]);
  } finally {
    await before.close();
  }
  // Chrome restarted: the same profile dials in under another host id.
  const after = await launch("launch-after", saved);
  try {
    const result = await after.run("ask", "hello", "--detach", "--profile", "me@example.com");
    expect(result.stderr).not.toContain("had no model");
    expect(after.writes).toEqual([]);
  } finally {
    await after.close();
  }
});

it("a scoped model off holds for the current launch of a profile with no verified email", async () => {
  const peer = await fakePeer({ profiles: ["unverified"], threads: [], model: withDefault });
  try {
    await peer.run("model", "off", "--profile", "unverified");
    const result = await peer.run("ask", "hello", "--detach", "--profile", "unverified");
    expect(result.stderr).not.toContain("had no model");
    expect(peer.writes).toEqual([]);
    expect(
      modelConfigSchema.parse(JSON.parse(await readFile(join(peer.home, MODEL_FILE), "utf8"))),
    ).toMatchObject({ off: ["unverified"] });
  } finally {
    await peer.close();
  }
});
