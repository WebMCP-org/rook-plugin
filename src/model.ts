// `rook model`: the model `rook serve` gives each Chrome profile (ADR 0082).
// serve's upstreams live in ROOK_HOME's model.json, one of each kind, named by
// it; a profile on serve has an openai-compatible source at /<kind>/v1 with
// its own model and effort. A profile with no model gets the default when rook
// first reaches it: what Codex here is configured to use. rook never replaces a model chosen in the side panel or set by
// managed policy, so a profile it takes off serve goes back to none.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveAuthFileCandidates } from "@openai-oauth/local/auth-file";
import type { AgentClient } from "agents/client";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import {
  DEFAULT_CHATGPT_MODEL_ID,
  DEFAULT_CHATGPT_REASONING_EFFORT,
  managedModelEndpoint,
  type OpenAiCompatibleModelInput,
  type RookDirectory,
  type RookDirectoryState,
  type RookModelSource,
} from "./wire/contracts";
import { LOCAL_RELAY_ORIGIN } from "./wire/relay";
import { parseJson } from "./wire/responses-socket";
import {
  MODEL_FILE,
  readConfig,
  type Choice,
  type HeaderSource,
  type ModelConfig,
  type Upstream,
} from "./relay";

type Root = AgentClient<RookDirectory, RookDirectoryState>;
export type Profile = { id: string; label: string; root: Root };

const TEST_PROMPT = "Reply with the word ready.";
const TEST_TIMEOUT_MS = 120_000;
const REDACTED = "<redacted>";

export const MODEL_USAGE = `rook model                  each profile's model, and rook serve's upstreams (secrets redacted)
rook model codex            ChatGPT through this machine's Codex sign-in
  [--transport ws|http]
rook model url BASE         any endpoint: BASE ends in /v1
  --api responses|chat  [--transport http|ws]
  [--header 'Name: value'] [--header-env 'Name=[prefix ]VAR'] [--header-cmd 'Name=command']
  [--header-ttl DUR]        headers, repeatable; a command reruns after a 401 or its ttl
rook model off              take profiles off rook serve, and give none a model on first use
Each takes [--profile P]; all but off take [--model ID] [--effort E] and send one test request first.
`;

/** A command line `rook model` cannot act on. */
export class UsageError extends Error {}

// ── model.json ─────────────────────────────────────────────────────────────

/** Replaces model.json whole, readable by this user only. */
export function writeConfig(home: string, config: ModelConfig): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, MODEL_FILE);
  const written = `${file}.${randomUUID()}`;
  writeFileSync(written, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(written, file);
}

/** The config without literal header or query values, which may be credentials. */
export function redacted(config: ModelConfig): ModelConfig {
  const upstreams = Object.fromEntries(
    Object.entries(config.upstreams).map(([name, upstream]) => [name, redactedUpstream(upstream)]),
  );
  return { ...config, upstreams };
}

function redactedUpstream(upstream: Upstream): Upstream {
  if (upstream.kind === "codex") return upstream;
  const headers = upstream.headers.map((header) =>
    "value" in header ? { ...header, value: REDACTED } : header,
  );
  const query = Object.fromEntries(Object.keys(upstream.query).map((name) => [name, REDACTED]));
  return { ...upstream, headers, query };
}

// ── What this machine's coding agents use ──────────────────────────────────

const codexSelectionSchema = z.object({
  model: z.string().optional(),
  model_provider: z.string().optional(),
  model_reasoning_effort: z.string().optional(),
});

// The parts of Codex's config.toml that say where it sends requests.
const codexConfigSchema = codexSelectionSchema.extend({
  profile: z.string().optional(),
  profiles: z.record(z.string(), codexSelectionSchema).default({}),
  model_providers: z
    .record(
      z.string(),
      z.object({
        base_url: z.url().optional(),
        // Codex dropped chat; an older config may still name it.
        wire_api: z.enum(["responses", "chat"]).default("responses"),
        env_key: z.string().optional(),
        http_headers: z.record(z.string(), z.string()).default({}),
        env_http_headers: z.record(z.string(), z.string()).default({}),
        query_params: z.record(z.string(), z.string()).default({}),
        auth: z
          .object({
            command: z.string(),
            args: z.array(z.string()).default([]),
            refresh_interval_ms: z.number().default(300_000),
          })
          .optional(),
      }),
    )
    .default({}),
});

type CodexProvider = z.infer<typeof codexConfigSchema>["model_providers"][string];

const quoted = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/** A Codex model provider as serve's url upstream, its key and headers as Codex sends them. */
function providerUpstream(provider: CodexProvider, baseUrl: string): Upstream {
  const headers: HeaderSource[] = [];
  if (provider.env_key) {
    headers.push({ name: "Authorization", env: provider.env_key, prefix: "Bearer " });
  }
  if (provider.auth) {
    headers.push({
      name: "Authorization",
      command: [provider.auth.command, ...provider.auth.args].map(quoted).join(" "),
      prefix: "Bearer ",
      // Codex's 0 refreshes only when a request is refused.
      ttl: provider.auth.refresh_interval_ms || undefined,
    });
  }
  for (const [name, value] of Object.entries(provider.http_headers)) {
    headers.push({ name, value });
  }
  // Codex sends these only when the variable is set.
  for (const [name, env] of Object.entries(provider.env_http_headers)) {
    headers.push({ name, env, optional: true });
  }
  return {
    kind: "url",
    baseUrl,
    api: provider.wire_api,
    transport: "http",
    headers,
    query: provider.query_params,
  };
}

function codexConfig() {
  const file = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
  const config = codexConfigSchema.parse(
    existsSync(file) ? parseToml(readFileSync(file, "utf8")) : {},
  );
  const active =
    config.profile !== undefined && Object.hasOwn(config.profiles, config.profile)
      ? config.profiles[config.profile]
      : {};
  return {
    config,
    provider: active.model_provider ?? config.model_provider ?? "openai",
    model: active.model ?? config.model,
    effort: active.model_reasoning_effort ?? config.model_reasoning_effort,
  };
}

/** ChatGPT through this machine's Codex sign-in, at its defaults where unset. */
function chatgptSelection(
  transport: "ws" | "http",
  model: string | undefined,
  effort: string | undefined,
): Selection {
  return {
    upstream: { kind: "codex", transport },
    choice: {
      upstream: "codex",
      model: model ?? DEFAULT_CHATGPT_MODEL_ID,
      effort: effort ?? DEFAULT_CHATGPT_REASONING_EFFORT,
    },
  };
}

/** What Codex here is configured to use, as serve's upstream: its custom provider, or ChatGPT through its sign-in. */
export function codexDefault(): Selection | undefined {
  const { config, provider, model, effort } = codexConfig();
  if (provider === "openai") {
    if (!resolveAuthFileCandidates().some((path) => existsSync(path))) return undefined;
    return chatgptSelection("ws", model, effort);
  }
  const custom = Object.hasOwn(config.model_providers, provider)
    ? config.model_providers[provider]
    : undefined;
  // ponytail: Codex's built-in ollama and lmstudio providers are not read; rook model url covers them.
  if (!custom?.base_url || !model) return undefined;
  return {
    upstream: providerUpstream(custom, custom.base_url),
    choice: { upstream: "url", model, effort },
  };
}

// ── Profiles ───────────────────────────────────────────────────────────────

/** An upstream and what a profile asks it for. */
export type Selection = { upstream: Upstream; choice: Choice };

/** Whether a profile has no model: the default signed-out ChatGPT source, and no managed one. */
export function needsModel({ model, managedPolicy }: RookDirectoryState): boolean {
  return (
    model.kind === "chatgpt-oauth" &&
    model.status === "signed-out" &&
    !model.config &&
    !managedModelEndpoint(managedPolicy)
  );
}

/** The serve upstream a source uses, if it is on serve. */
function servedBy(source: RookModelSource): string | undefined {
  if (source.kind !== "openai-compatible") return undefined;
  if (!source.baseUrl.startsWith(`${LOCAL_RELAY_ORIGIN}/`)) return undefined;
  return source.baseUrl.slice(LOCAL_RELAY_ORIGIN.length + 1).split("/")[0];
}

/** The source a profile gets for a selection. Declaring what it reads skips detection. */
export function servedSource({ upstream, choice }: Selection): OpenAiCompatibleModelInput {
  // ChatGPT reads images and PDFs; another URL's model is looked up.
  const reads = upstream.kind === "codex" ? true : undefined;
  const chat = upstream.kind === "url" && upstream.api === "chat";
  return {
    api: chat ? "chat-completions" : "responses",
    baseUrl: `${LOCAL_RELAY_ORIGIN}/${choice.upstream}/v1`,
    modelId: choice.model,
    reasoningEffort: choice.effort,
    acceptsImages: reads,
    acceptsPdfs: reads,
  };
}

const describeChoice = ({ upstream, model, effort }: Choice) =>
  `${upstream} ${model}${effort ? ` at ${effort} effort` : ""}`;

/** Points a profile with no model of its own at a selection; says what it did. */
async function point(profile: Profile, selection: Selection): Promise<string | null> {
  const state = profile.root.state;
  if (!state) return null;
  if (managedModelEndpoint(state.managedPolicy)) return null;
  if (!needsModel(state) && !servedBy(state.model)) return null;
  await profile.root.stub.setOpenAiCompatibleModelSource(servedSource(selection));
  return `uses ${describeChoice(selection.choice)}`;
}

function kept(state: RookDirectoryState | undefined): string {
  if (!state) return "sent no state";
  return managedModelEndpoint(state.managedPolicy)
    ? "kept the model its managed policy sets"
    : "kept the model chosen in its side panel";
}

/** Gives a profile with no model the default; says so on stderr. */
export async function adoptModel(profile: Profile, home: string): Promise<void> {
  const { id, label, root } = profile;
  if (!root.state || !needsModel(root.state)) return;
  try {
    const config = readConfig(home);
    if (config.default === null || config.off.includes(id)) return;
    let choice = config.default;
    if (!choice) {
      const found = codexDefault();
      if (!found) return;
      choice = found.choice;
      config.upstreams[choice.upstream] = found.upstream;
      config.default = choice;
      writeConfig(home, config);
    }
    if (!Object.hasOwn(config.upstreams, choice.upstream)) return;
    const upstream = config.upstreams[choice.upstream];
    await root.stub.setOpenAiCompatibleModelSource(servedSource({ upstream, choice }));
    process.stderr.write(
      `rook: ${label} had no model, so it now uses ${describeChoice(choice)} through rook serve (rook model off undoes this)\n`,
    );
  } catch (error) {
    process.stderr.write(`rook: could not give ${label} a model: ${String(error)}\n`);
  }
}

/** A profile's model as `rook model` lists it: where, model, effort. */
function profileLine({ label, root }: Profile): string {
  const state = root.state;
  if (!state) return `${label}\tsent no state`;
  if (needsModel(state)) return `${label}\tnone`;
  const managed = managedModelEndpoint(state.managedPolicy);
  if (managed) return [label, `${managed.baseUrl} (managed)`, managed.modelId, "-"].join("\t");
  const source = state.model;
  const where =
    source.kind === "chatgpt-oauth"
      ? `chatgpt ${source.status}`
      : (servedBy(source) ?? source.baseUrl);
  const model = source.kind === "chatgpt-oauth" ? source.config?.modelId : source.modelId;
  const effort =
    source.kind === "chatgpt-oauth" ? source.config?.reasoningEffort : source.reasoningEffort;
  return [label, where, model ?? "-", effort ?? "-"].join("\t");
}

// ── The command ────────────────────────────────────────────────────────────

const testEventSchema = z.object({ type: z.string() });

/** The data of each server-sent event. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replaceAll("\r\n", "\n");
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const data = buffer
        .slice(0, end)
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      buffer = buffer.slice(end + 2);
      if (data) yield data;
    }
  }
}

/** One small request through serve; a refusal comes back with the upstream's status and body. */
export async function testModel(
  { upstream, choice }: Selection,
  token: string,
  origin: string = LOCAL_RELAY_ORIGIN,
): Promise<void> {
  const chat = upstream.kind === "url" && upstream.api === "chat";
  const path = chat ? "chat/completions" : "responses";
  const url = `${origin}/${choice.upstream}/v1/${path}`;
  const prompt = { role: "user", content: TEST_PROMPT };
  const body = chat
    ? { model: choice.model, messages: [prompt], reasoning_effort: choice.effort }
    : {
        model: choice.model,
        input: [{ role: "user", content: [{ type: "input_text", text: TEST_PROMPT }] }],
        reasoning: choice.effort ? { effort: choice.effort } : undefined,
        store: false,
        stream: true,
      };
  const reply = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      // A Responses WebSocket opens only for a conversation.
      "session-id": randomUUID(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
  });
  if (!reply.ok || !reply.body) {
    throw new Error(
      `the ${choice.upstream} upstream answered ${reply.status}: ${await reply.text()}`,
    );
  }
  if (chat) {
    await reply.text();
    return;
  }
  for await (const data of sseData(reply.body)) {
    const type = parseJson(testEventSchema, data)?.type;
    if (type === "response.completed" || type === "response.incomplete") return;
    if (type === "response.failed" || type === "error") {
      throw new Error(`the ${choice.upstream} upstream failed: ${data}`);
    }
  }
  throw new Error(`the ${choice.upstream} upstream ended its stream before the response finished`);
}

/** `rook model`'s command line; positionals are the kind and its argument. */
export function parseFlags(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      profile: { type: "string", default: process.env.ROOK_PROFILE },
      model: { type: "string" },
      effort: { type: "string" },
      transport: { type: "string" },
      api: { type: "string" },
      header: { type: "string", multiple: true, default: [] },
      "header-env": { type: "string", multiple: true, default: [] },
      "header-cmd": { type: "string", multiple: true, default: [] },
      "header-ttl": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

type Flags = ReturnType<typeof parseFlags>["values"];

function split(text: string, separator: string, flag: string): [string, string] {
  const at = text.indexOf(separator);
  if (at < 1) throw new UsageError(`${flag} ${text}: expected Name${separator}…`);
  return [text.slice(0, at).trim(), text.slice(at + 1).trim()];
}

/** The --header* flags as header sources. */
export function headerSources(flags: Flags, ttl: number | undefined): HeaderSource[] {
  return [
    ...flags.header.map((header): HeaderSource => {
      const [name, value] = split(header, ":", "--header");
      return { name, value };
    }),
    ...flags["header-env"].map((header): HeaderSource => {
      const [name, source] = split(header, "=", "--header-env");
      const space = source.lastIndexOf(" ");
      if (space < 0) return { name, env: source };
      return { name, env: source.slice(space + 1), prefix: source.slice(0, space + 1) };
    }),
    ...flags["header-cmd"].map((header): HeaderSource => {
      const [name, command] = split(header, "=", "--header-cmd");
      return { name, command, ttl };
    }),
  ];
}

/** A duration flag, such as 90s, 5m or 1h, in milliseconds. */
export function duration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/u.exec(value);
  if (!match) throw new UsageError(`bad duration ${value}: use 90s, 5m or 1h`);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] ?? "s"] ?? 1_000;
  return Number(match[1]) * unit;
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  const found = allowed.find((option) => option === value);
  if (found === undefined) throw new UsageError(`${flag} takes ${allowed.join(" or ")}`);
  return found;
}

/** The upstream and choice a `rook model <kind>` command line names. */
export async function selection(
  kind: string,
  rest: string[],
  flags: Flags,
  ttl: number | undefined,
): Promise<Selection> {
  const headers = headerSources(flags, ttl);
  const effort = flags.effort;
  if (kind === "codex") {
    const transport = oneOf("--transport", flags.transport ?? "ws", ["ws", "http"]);
    // Codex's own model applies when it uses ChatGPT too.
    const codex = codexConfig();
    const own = codex.provider === "openai" ? codex : { model: undefined, effort: undefined };
    return chatgptSelection(transport, flags.model ?? own.model, effort ?? own.effort);
  }
  if (kind === "url") {
    const baseUrl = z.url().safeParse(rest[0]).data;
    if (!baseUrl) throw new UsageError("usage: rook model url BASE --api responses|chat");
    const api = oneOf("--api", flags.api ?? "", ["responses", "chat"]);
    const transport = oneOf("--transport", flags.transport ?? "http", ["http", "ws"]);
    if (transport === "ws" && api !== "responses") {
      throw new UsageError("--transport ws needs --api responses");
    }
    if (!flags.model) throw new UsageError("rook model url needs --model ID");
    return {
      upstream: { kind: "url", baseUrl, api, transport, headers, query: {} },
      choice: { upstream: "url", model: flags.model, effort },
    };
  }
  throw new UsageError(`rook model ${kind}: use codex, url or off`);
}

export type ModelContext = {
  home: string;
  token: () => string;
  /** The connected profiles `wanted` names, all of them without it; starts serve. */
  profiles: (wanted: string | undefined) => Promise<Profile[]>;
};

const write = (line: string) => process.stdout.write(`${line}\n`);

/** `rook model …`; returns the exit code. */
export async function modelCommand(argv: string[], context: ModelContext): Promise<number> {
  const { values: flags, positionals } = parseFlags(argv);
  const [kind, ...rest] = positionals;
  if (flags.help) {
    process.stdout.write(MODEL_USAGE);
    return 0;
  }
  const { home } = context;
  if (kind === undefined) {
    write(JSON.stringify(redacted(readConfig(home)), null, 2));
    for (const profile of await context.profiles(flags.profile)) write(profileLine(profile));
    return 0;
  }
  if (kind === "off") {
    const profiles = await context.profiles(flags.profile);
    const config = readConfig(home);
    config.off = [...new Set([...config.off, ...profiles.map(({ id }) => id)])];
    if (!flags.profile) config.default = null;
    writeConfig(home, config);
    for (const { label, root } of profiles) {
      const state = root.state;
      if (state && !managedModelEndpoint(state.managedPolicy) && servedBy(state.model)) {
        await root.stub.setOpenAiCompatibleModelSource(null);
      }
      write(`${label}\t${state && needsModel(state) ? "has no model" : kept(state)}`);
    }
    return 0;
  }
  const chosen = await selection(kind, rest, flags, duration(flags["header-ttl"]));
  // The test goes through serve, which reaching the profiles starts.
  const profiles = await context.profiles(flags.profile);
  const before = readConfig(home);
  const config = {
    ...before,
    upstreams: { ...before.upstreams, [chosen.choice.upstream]: chosen.upstream },
  };
  writeConfig(home, config);
  try {
    await testModel(chosen, context.token());
  } catch (error) {
    writeConfig(home, before);
    throw error;
  }
  if (!flags.profile) config.default = chosen.choice;
  config.off = config.off.filter((id) => !profiles.some((profile) => profile.id === id));
  writeConfig(home, config);
  let pointed = false;
  for (const profile of profiles) {
    const did = await point(profile, chosen);
    pointed ||= did !== null;
    write(`${profile.label}\t${did ?? kept(profile.root.state)}`);
  }
  return pointed ? 0 : 1;
}
