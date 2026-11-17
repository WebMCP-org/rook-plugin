// Model commands compose settings, provider transport, and the selected profile.
import { Effect, Option } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { z } from "zod";
import { chatgptSelection, codexConfig, codexDefault } from "./codex-config";
import { CommandError, EXIT, duration, optional, rootCommand } from "./command";
import { RookConfig } from "./config";
import { testModel } from "./model-probe";
import { CliSession } from "./output";
import { RookSessions, matching, profileEmail, type Profile } from "./session";
import {
  ModelSettings,
  redacted,
  selectionSchema,
  type Choice,
  type HeaderSource,
  type ModelConfig,
  type Selection,
  type Upstream,
} from "./model-settings";
import {
  DEFAULT_CHATGPT_MODEL_ID,
  DEFAULT_CHATGPT_REASONING_EFFORT,
  managedModelEndpoint,
  type OpenAiCompatibleModelInput,
  type RookDirectoryState,
  type RookModelSource,
} from "./wire/contracts";

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
function servedBy(source: RookModelSource, origin: string): string | undefined {
  if (source.kind !== "openai-compatible") return undefined;
  if (!source.baseUrl.startsWith(`${origin}/`)) return undefined;
  return source.baseUrl.slice(origin.length + 1).split("/")[0];
}

/** The source a profile gets for a selection. Declaring what it reads skips detection. */
export function servedSource(
  { upstream, choice }: Selection,
  origin: string,
): OpenAiCompatibleModelInput {
  // ChatGPT reads images and PDFs; another URL's model is looked up.
  const reads = upstream.kind === "codex" ? true : undefined;
  const chat = upstream.kind === "url" && upstream.api === "chat";
  return {
    api: chat ? "chat-completions" : "responses",
    baseUrl: `${origin}/${choice.upstream}/v1`,
    modelId: choice.model,
    reasoningEffort: choice.effort,
    acceptsImages: reads,
    acceptsPdfs: reads,
  };
}

function kept(state: RookDirectoryState | undefined): string {
  if (!state) return "sent no state";
  return managedModelEndpoint(state.managedPolicy)
    ? "kept the model its managed policy sets"
    : "kept the model chosen in its side panel";
}

/** A profile's model as `rook model` lists it: where, model, effort. */
function profileLine({ label, root }: Profile, origin: string): string {
  const state = root.state;
  if (!state) return `${label}\tsent no state`;
  if (needsModel(state)) return `${label}\tnone`;
  const managed = managedModelEndpoint(state.managedPolicy);
  if (managed) return [label, `${managed.baseUrl} (managed)`, managed.modelId, "-"].join("\t");
  const source = state.model;
  const where =
    source.kind === "chatgpt-oauth"
      ? `chatgpt ${source.status}`
      : (servedBy(source, origin) ?? source.baseUrl);
  const model = source.kind === "chatgpt-oauth" ? source.config?.modelId : source.modelId;
  const effort =
    source.kind === "chatgpt-oauth" ? source.config?.reasoningEffort : source.reasoningEffort;
  return [label, where, model ?? "-", effort ?? "-"].join("\t");
}

/** How `model.json`'s `off` list names a profile. */
function optOutKey({ id, root }: Profile): string {
  // ponytail: a profile with no verified email is keyed by its host id, which
  // lasts one Chrome launch, so its opt-out ends with that launch. The upgrade
  // is to keep the adoption preference in the profile's root Agent state.
  return (root.state && profileEmail(root.state))?.toLowerCase() ?? id;
}

const describeChoice = ({ upstream, model, effort }: Choice) =>
  `${upstream} ${model}${effort ? ` at ${effort} effort` : ""}`;

function selectionFromConfig(config: ModelConfig): Selection | undefined {
  const choice = config.default;
  return choice && Object.hasOwn(config.upstreams, choice.upstream)
    ? { upstream: config.upstreams[choice.upstream], choice }
    : undefined;
}

/** `Name<separator>rest`, both sides trimmed, with a name. */
function split(text: string, separator: string): Option.Option<readonly [string, string]> {
  const at = text.indexOf(separator);
  const name = text.slice(0, Math.max(at, 0)).trim();
  return name ? Option.some([name, text.slice(at + 1).trim()]) : Option.none();
}

const headerFlag = <A extends HeaderSource>(
  name: string,
  description: string,
  parse: (text: string) => Option.Option<A>,
  expected: string,
) =>
  Flag.String(name).pipe(
    Flag.withDescription(description),
    Flag.filterMap(parse, () => expected),
    Flag.atLeast(0),
  );

const transportFlag = (fallback: "ws" | "http", note = "") =>
  Flag.Literals("transport", ["ws", "http"]).pipe(
    Flag.withDescription(`Transport: ws or http. Defaults to ${fallback}${note}.`),
    Flag.withDefault(fallback),
  );

const codexFlags = {
  model: optional("model").pipe(
    Flag.withDescription(
      `Model ID. Defaults to Codex's configured model, or ${DEFAULT_CHATGPT_MODEL_ID}.`,
    ),
  ),
  effort: optional("effort").pipe(
    Flag.withDescription(
      `Reasoning effort. Defaults to Codex's setting, or ${DEFAULT_CHATGPT_REASONING_EFFORT}.`,
    ),
  ),
  transport: transportFlag("ws"),
};

const urlFlags = {
  model: Flag.String("model").pipe(Flag.withDescription("Model ID the endpoint serves.")),
  effort: optional("effort").pipe(
    Flag.withDescription("Reasoning effort. Defaults to the endpoint's own."),
  ),
  api: Flag.Literals("api", ["responses", "chat"]).pipe(
    Flag.withDescription("API the endpoint speaks: responses or chat."),
  ),
  transport: transportFlag("http", "; ws needs --api responses"),
  header: headerFlag(
    "header",
    "Literal header: 'Name: value'. Repeatable.",
    (text) => Option.map(split(text, ":"), ([name, value]) => ({ name, value })),
    "'Name: value'",
  ),
  "header-env": headerFlag(
    "header-env",
    "Header from an environment variable: 'Name=[prefix ]VAR'. Repeatable.",
    (text) =>
      Option.flatMap(split(text, "="), ([name, source]): Option.Option<HeaderSource> => {
        const space = source.lastIndexOf(" ");
        const env = source.slice(space + 1);
        if (!env) return Option.none();
        return Option.some(
          space < 0 ? { name, env } : { name, env, prefix: source.slice(0, space + 1) },
        );
      }),
    "'Name=[prefix ]VAR'",
  ),
  "header-cmd": headerFlag(
    "header-cmd",
    "Header from command output: 'Name=command'. Repeatable; reruns after a 401 or its TTL.",
    (text) =>
      Option.flatMap(split(text, "="), ([name, command]) =>
        command ? Option.some({ name, command }) : Option.none<{ name: string; command: string }>(),
      ),
    "'Name=command'",
  ),
  "header-ttl": duration("header-ttl").pipe(
    Flag.withDescription(
      "Refresh command headers after DUR, such as 90s, 5m or 1h. Without a TTL, refresh after a 401.",
    ),
  ),
  base: Argument.String("BASE").pipe(
    Argument.withDescription("Upstream base URL ending in /v1"),
    Argument.filterMap(
      (text) => Option.fromNullishOr(z.url().safeParse(text).data),
      () => "a URL ending in /v1",
    ),
  ),
};

type CodexInput = Command.Command.Config.Infer<typeof codexFlags>;
type UrlInput = Command.Command.Config.Infer<typeof urlFlags>;

/** The released schema has the last word on what reaches model.json. */
const validated = (chosen: Selection) =>
  Effect.try({
    try: () => selectionSchema.parse(chosen),
    catch: (cause) => CommandError.usage(String(cause)),
  });

/** ChatGPT through Codex's sign-in, with Codex's own model when it uses ChatGPT too. */
export const codexSelection = Effect.fnUntraced(function* (input: CodexInput) {
  const codex = yield* codexConfig;
  const own = codex.provider === "openai" ? codex : { model: undefined, effort: undefined };
  return yield* validated(
    chatgptSelection(input.transport, input.model ?? own.model, input.effort ?? own.effort),
  );
});

/** A URL endpoint with the headers its flags name. */
export const urlSelection = (input: UrlInput) =>
  validated({
    upstream: {
      kind: "url",
      baseUrl: input.base,
      api: input.api,
      transport: input.transport,
      headers: [
        ...input.header,
        ...input["header-env"],
        ...input["header-cmd"].map((source) => ({ ...source, ttl: input["header-ttl"] })),
      ],
      query: {},
    },
    choice: { upstream: "url", model: input.model, effort: input.effort },
  });

const profilesFor = Effect.fnUntraced(function* (wanted: string | undefined) {
  const sessions = yield* RookSessions;
  return matching(yield* sessions.profiles(wanted), wanted);
});

/** Points a profile at serve's model for a selection. */
const assign = Effect.fnUntraced(function* (profile: Profile, chosen: Selection) {
  const sessions = yield* RookSessions;
  const { relayOrigin } = yield* RookConfig;
  yield* sessions.call(profile, () =>
    profile.root.stub.setOpenAiCompatibleModelSource(servedSource(chosen, relayOrigin)),
  );
});

/** Whether `existing` is the endpoint `found` names, so it serves `found`'s model. */
const sameEndpoint = (existing: Upstream, found: Upstream) =>
  existing.kind === "codex"
    ? found.kind === "codex"
    : found.kind === "url" && found.baseUrl === existing.baseUrl;

/** What a profile with no model gets on first use. With no default yet, Codex's
 * own provider becomes the default unless another process set one meanwhile.
 * An upstream `rook model --profile` configured under that name is kept: Codex's
 * model is adopted on it only when it is Codex's endpoint, and otherwise not. */
const firstUse = Effect.fnUntraced(function* (profile: Profile) {
  const settings = yield* ModelSettings;
  const sessions = yield* RookSessions;
  const key = optOutKey(profile);
  const config = yield* settings.read;
  if (config.default === null || config.off.includes(key)) return undefined;
  if (config.default) return selectionFromConfig(config);
  const found = yield* codexDefault;
  if (!found) return undefined;
  const name = found.choice.upstream;
  const latest = yield* sessions.exclusive(
    "model",
    settings.update((latest) => {
      if (latest.default !== undefined) return latest;
      const existing = Object.hasOwn(latest.upstreams, name) ? latest.upstreams[name] : undefined;
      if (existing && !sameEndpoint(existing, found.upstream)) return latest;
      return {
        ...latest,
        upstreams: { ...latest.upstreams, [name]: existing ?? found.upstream },
        default: found.choice,
      };
    }),
  );
  return latest.off.includes(key) ? undefined : selectionFromConfig(latest);
});

/** Automatic adoption is best effort, but cancellation is never swallowed. */
export const adoptModel = Effect.fn("rook.model.adopt")(function* (profile: Profile) {
  const output = yield* CliSession;
  if (!profile.root.state || !needsModel(profile.root.state)) return;
  yield* Effect.gen(function* () {
    const chosen = yield* firstUse(profile);
    const current = profile.root.state;
    // File reads yield to synchronized updates from Chrome. A selection
    // or policy arriving meanwhile takes precedence over first-use adoption.
    if (!chosen || !current || !needsModel(current)) return;
    yield* assign(profile, chosen);
    yield* output.stderr(
      `rook: ${profile.label} had no model, so it now uses ${describeChoice(chosen.choice)} through rook serve (rook model off undoes this)\n`,
    );
  }).pipe(
    Effect.catchTag(["SettingsError", "CommandError"], (error) =>
      output.stderr(`rook: could not give ${profile.label} a model: ${error.message}\n`),
    ),
  );
});

/** Validate first, then merge the latest settings under the `model` lease. */
const configure = Effect.fnUntraced(function* (chosen: Selection) {
  const { profile: wanted } = yield* rootCommand;
  const settings = yield* ModelSettings;
  const sessions = yield* RookSessions;
  const output = yield* CliSession;
  const { relayOrigin } = yield* RookConfig;
  const profiles = yield* profilesFor(wanted);
  yield* testModel(chosen);
  const keys = new Set(profiles.map(optOutKey));
  yield* sessions.exclusive(
    "model",
    settings.update((latest) => ({
      ...latest,
      upstreams: { ...latest.upstreams, [chosen.choice.upstream]: chosen.upstream },
      default: wanted ? latest.default : chosen.choice,
      off: latest.off.filter((key) => !keys.has(key)),
    })),
  );
  let assigned = false;
  for (const profile of profiles) {
    const state = profile.root.state;
    // Only a profile with no model, or one already on serve, is reassigned.
    const eligible =
      state &&
      !managedModelEndpoint(state.managedPolicy) &&
      (needsModel(state) || servedBy(state.model, relayOrigin));
    if (eligible) yield* assign(profile, chosen);
    assigned ||= Boolean(eligible);
    yield* output.stdout(
      `${profile.label}\t${eligible ? `uses ${describeChoice(chosen.choice)}` : kept(profile.root.state)}\n`,
    );
  }
  yield* output.finish(assigned ? EXIT.done : EXIT.failed);
});

const list = Effect.fn("rook.model.list")(function* () {
  const { profile: wanted } = yield* rootCommand;
  const settings = yield* ModelSettings;
  const output = yield* CliSession;
  const { relayOrigin } = yield* RookConfig;
  const config = yield* settings.read;
  yield* output.stdout(`${JSON.stringify(redacted(config), null, 2)}\n`);
  for (const profile of yield* profilesFor(wanted)) {
    yield* output.stdout(`${profileLine(profile, relayOrigin)}\n`);
  }
  yield* output.finish(EXIT.done);
});

const off = Effect.fn("rook.model.off")(function* () {
  const { profile: wanted } = yield* rootCommand;
  const settings = yield* ModelSettings;
  const sessions = yield* RookSessions;
  const output = yield* CliSession;
  const { relayOrigin } = yield* RookConfig;
  const profiles = yield* profilesFor(wanted);
  yield* sessions.exclusive(
    "model",
    settings.update((latest) => ({
      ...latest,
      off: [...new Set([...latest.off, ...profiles.map(optOutKey)])],
      default: wanted ? latest.default : null,
    })),
  );
  for (const profile of profiles) {
    const state = profile.root.state;
    if (state && !managedModelEndpoint(state.managedPolicy) && servedBy(state.model, relayOrigin)) {
      yield* sessions.call(profile, () => profile.root.stub.setOpenAiCompatibleModelSource(null));
    }
    const current = profile.root.state;
    yield* output.stdout(
      `${profile.label}\t${current && needsModel(current) ? "has no model" : kept(current)}\n`,
    );
  }
  yield* output.finish(EXIT.done);
});

export const codexCommand = Command.make(
  "codex",
  codexFlags,
  Effect.fn("rook.model.codex")(function* (input) {
    yield* configure(yield* codexSelection(input));
  }),
).pipe(
  Command.withDescription(
    "Send one test request through this machine's Codex sign-in, then assign ChatGPT to eligible profiles. Without a profile selection, also set the default for first use.",
  ),
);

export const urlCommand = Command.make(
  "url",
  urlFlags,
  Effect.fn("rook.model.url")(function* (input) {
    yield* configure(yield* urlSelection(input));
  }),
).pipe(
  Command.validate(({ api, transport }) =>
    transport === "ws" && api !== "responses"
      ? Effect.fail(
          new CliError.ValidationError({ message: "--transport ws needs --api responses" }),
        )
      : Effect.void,
  ),
  Command.withDescription(
    "Send one test request to a URL endpoint, then assign its model to eligible profiles. Without a profile selection, also set the default for first use.",
  ),
);

export const modelCommand = Command.make("model", {}, list).pipe(
  Command.withDescription(
    "Show each profile's model and rook serve's upstreams, with secrets redacted. Use a subcommand to configure models.",
  ),
  Command.withSubcommands([
    codexCommand,
    urlCommand,
    Command.make("off", {}, off).pipe(
      Command.withDescription(
        "Remove rook serve's models from selected profiles. Without a profile selection, also disable first-use model adoption.",
      ),
    ),
  ]),
);
