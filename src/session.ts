// Local sessions own discovery and sockets. Browser work belongs to Think.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { AgentClient } from "agents/client";
import {
  Clock,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Path,
  Result,
  Schedule,
  Schema,
  Scope,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import packageJson from "../package.json" with { type: "json" };
import { Chrome, STORE_URL } from "./chrome";
import { CommandError, EXIT } from "./command";
import { RookConfig, type ConfigError } from "./config";
import { CliSession, type OutputError } from "./output";
import { HOSTS_PATH, LEASES_PATH, SERVE_HEADER } from "./serve";
import {
  AGENT_CALL_TIMEOUT_MS,
  AGENT_CLASS_NAME,
  AGENT_INSTANCE_NAME,
  CONVERSATION_AGENT_CLASS_NAME,
  type RookDirectory,
  type RookDirectoryState,
  type RookConversation,
  type RookConversationState,
} from "./wire/contracts";
import {
  companionSeatAgentsPrefix,
  LOCAL_RELAY_RECONNECT_MAX_MS,
  TUNNEL_CONNECT_TIMEOUT_MS,
  TUNNEL_HEARTBEAT_ACK,
  TUNNEL_HEARTBEAT_REQUEST,
} from "./wire/relay";

type Directory = AgentClient<RookDirectory, RookDirectoryState>;
export type Profile = { id: string; label: string; root: Directory };
export type Conversation = AgentClient<RookConversation, RookConversationState>;
export type Located = { profile: Profile; threadId: string };
/** The daemon answering the relay port, from its `rook-serve` header and host list. */
type Serve = {
  hosts: string[];
  version: string;
  release: readonly number[];
  pid: number;
  /** Absent from daemons that predate it; such a daemon is treated as settled. */
  startedAt: number | undefined;
};

/** How long `rook serve` has to answer one host-list request. */
const SERVE_ANSWER_MS = 2_000;
/** How long a replaced older serve has to release the port. */
const SERVE_STOP_MS = 5_000;
const SERVE_POLL_MS = 100;
/** Every profile redials within its longest backoff; this margin covers the dial itself. */
const REDIAL_SETTLE_MS = LOCAL_RELAY_RECONNECT_MAX_MS + 1_000;
/** After the settle time, how long a fresh serve waits for a first profile. */
const FIRST_PROFILE_MS = 2_000;
/** How long a spawned daemon, or whichever one won the port, has to answer at all. */
const SERVE_START_MS = REDIAL_SETTLE_MS + FIRST_PROFILE_MS;
// ponytail: three replacements, then give up. Each is a whole stop-and-start
// cycle, so a daemon replaced under us more often than that is a fight between
// installed versions that another attempt would only prolong.
const REPLACEMENTS = 3;
const HOSTS_POLL_MS = 500;
/** How long a Chrome rook just opened has to dial in. */
const OPENED_PROFILE_MS = 30_000;
/** How long a profile has to report whether its Google account is verified. */
const VERIFICATION_MS = 10_000;
const VERIFICATION_POLL_MS = 200;
/** An exclusive section's lease; a holder that dies frees it this long after. */
const EXCLUSIVE_MS = 5_000;
const LEASE_RETRY_MS = 25;

const hostListSchema = Schema.Array(Schema.Struct({ id: Schema.String }));
const leaseSchema = Schema.Struct({ id: Schema.String });

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** A dotted numeric version (`1.1.1147`) as its segments, or undefined. */
function release(version: string): number[] | undefined {
  if (!/^\d+(?:\.\d+)*$/u.test(version)) return undefined;
  return version.split(".").map(Number);
}

/** Orders releases segment by segment; a missing segment counts as zero. */
function compareReleases(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const OWN_RELEASE = release(packageJson.version);

/** `<version> <pid> [<startedAtMs>]`; anything else did not come from rook serve. */
function serveIdentity(header: string | undefined): Omit<Serve, "hosts"> | undefined {
  const [version = "", pidText = "", startedText] = header?.split(" ") ?? [];
  const segments = release(version);
  const pid = Number(pidText);
  if (!segments || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const startedAt = Number(startedText);
  return {
    version,
    release: segments,
    pid,
    startedAt: startedText !== undefined && Number.isSafeInteger(startedAt) ? startedAt : undefined,
  };
}

/** The SDK's refusal of a method this Rook does not expose; the text is its only form. */
export const notCallable = (cause: unknown) =>
  /Method \S+ (?:does not exist|is not callable)/u.test(String(cause));

/** Rook in the profile predates an RPC this CLI calls. */
export const outdated = (profile: Profile, cause?: unknown) =>
  CommandError.unavailable(
    `Rook in ${profile.label} is older than rook ${packageJson.version}: ask the user to update Rook (chrome://extensions, Update), then run this again`,
    cause,
  );

/** Readiness remains interruptible; only allocation is acquired uninterruptibly. */
export const within = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: TUNNEL_CONNECT_TIMEOUT_MS * 2,
      orElse: () => Effect.fail(CommandError.unavailable(message)),
    }),
  );

export class RookSessions extends Context.Service<
  RookSessions,
  {
    readonly profiles: (
      wanted?: string,
    ) => Effect.Effect<Profile[], CommandError | ConfigError | OutputError, Scope.Scope>;
    /** How many hosts the relay listed that have not answered this process. */
    readonly unanswered: Effect.Effect<number>;
    /** The profiles connected now, never opening Chrome to reach one. */
    readonly connected: Effect.Effect<
      Profile[],
      CommandError | ConfigError | OutputError,
      Scope.Scope
    >;
    readonly conversation: (
      profile: Profile,
      id: string,
    ) => Effect.Effect<Conversation, CommandError | ConfigError, Scope.Scope>;
    readonly ready: (
      client: Directory | Conversation,
      message: string,
    ) => Effect.Effect<void, CommandError>;
    readonly call: <A>(
      profile: Profile,
      operation: () => PromiseLike<A>,
    ) => Effect.Effect<A, CommandError>;
    /** Runs `effect` while no other rook on this machine runs one under `name`. */
    readonly exclusive: <A, E, R>(
      name: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("rook/RookSessions") {
  static readonly layer = Layer.effect(
    RookSessions,
    Effect.gen(function* () {
      const config = yield* RookConfig;
      const output = yield* CliSession;
      const http = yield* HttpClient.HttpClient;
      const path = yield* Path.Path;
      const chrome = yield* Chrome;
      if (!OWN_RELEASE)
        return yield* Effect.die(`rook ${packageJson.version} is not a dotted numeric version`);
      const ownRelease = OWN_RELEASE;
      const relay = new URL(config.relayOrigin);
      const logPath = path.join(config.home, "serve.log");
      const write = output.stderr;
      const call = <A>(profile: Profile, operation: () => PromiseLike<A>) =>
        Effect.tryPromise({
          try: () => Promise.resolve(operation()),
          catch: (cause) =>
            notCallable(cause)
              ? outdated(profile, cause)
              : CommandError.failed(errorText(cause), cause),
        });
      const ready = (client: Directory | Conversation, failure: string) =>
        within(
          Effect.tryPromise({
            try: () => client.ready,
            catch: (cause) => CommandError.failed(errorText(cause), cause),
          }).pipe(Effect.asVoid),
          failure,
        );
      const client = Effect.fnUntraced(function* <Agent, State>(
        hostId: string,
        agent: string,
        name: string,
      ) {
        const token = yield* config.token;
        return yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              class TokenWebSocket extends WebSocket {
                constructor(url: string | URL, protocols?: string | string[]) {
                  super(url, { protocols, headers: { authorization: `Bearer ${token}` } });
                  this.addEventListener("message", (event) => {
                    if (event.data !== TUNNEL_HEARTBEAT_REQUEST) return;
                    event.stopImmediatePropagation();
                    this.send(TUNNEL_HEARTBEAT_ACK);
                  });
                }
              }
              return new AgentClient<Agent, State>({
                agent,
                name,
                host: relay.host,
                protocol: "ws",
                prefix: companionSeatAgentsPrefix(hostId),
                WebSocket: TokenWebSocket,
                minReconnectionDelay: 250,
                maxReconnectionDelay: 1_000,
                connectionTimeout: TUNNEL_CONNECT_TIMEOUT_MS + 2_000,
                defaultCallTimeout: AGENT_CALL_TIMEOUT_MS,
              });
            },
            catch: (cause) => CommandError.failed(errorText(cause), cause),
          }),
          (connection) => Effect.sync(() => connection.close()),
        );
      });

      /** The daemon on the relay port and its online hosts; undefined when nothing
       * listens. Unbounded: a poll waits out a slow answer under its own deadline. */
      const polledHosts = Effect.gen(function* () {
        const token = yield* config.token;
        const response = yield* http
          .get(new URL(HOSTS_PATH, relay), { headers: { authorization: `Bearer ${token}` } })
          .pipe(
            // Only a request that reached no listener means no daemon is running.
            Effect.catchReason(
              "HttpClientError",
              "TransportError",
              () => Effect.succeed(undefined),
              (_, error) =>
                Effect.fail(
                  CommandError.unavailable(`could not ask rook serve: ${error.message}`, error),
                ),
            ),
          );
        if (!response) return undefined;
        if (response.status === 401)
          return yield* new CommandError({
            code: EXIT.token,
            message: "the running rook serve holds another token; stop it and retry",
          });
        if (response.status < 200 || response.status >= 300)
          return yield* CommandError.unavailable(`rook serve answered ${response.status}`);
        const identity = serveIdentity(response.headers[SERVE_HEADER]);
        if (!identity)
          return yield* CommandError.unavailable(
            `something other than rook serve answers on port ${config.relayPort}`,
          );
        const hosts = yield* HttpClientResponse.schemaBodyJson(hostListSchema)(response).pipe(
          Effect.mapError((cause) =>
            CommandError.unavailable(
              `rook serve sent an unreadable host list: ${cause.message}`,
              cause,
            ),
          ),
        );
        const serve: Serve = { ...identity, hosts: hosts.map(({ id }) => id) };
        return serve;
      });

      /** One answer, for the question that is asked once. */
      const onlineHosts = polledHosts.pipe(
        Effect.timeoutOrElse({
          duration: SERVE_ANSWER_MS,
          orElse: () => Effect.fail(CommandError.unavailable("rook serve did not answer")),
        }),
      );

      // The platform spawner has no inherited file-descriptor output. A Sink
      // needs its parent alive, whereas this daemon must keep its log after exit.
      const spawnDaemon = Effect.callback<number | undefined, CommandError>((resume) => {
        let log: number | undefined;
        try {
          log = openSync(logPath, "a");
          const child = spawn(config.node, [config.entry, "serve"], {
            detached: true,
            stdio: ["ignore", log, log],
          });
          child.once("error", (cause) =>
            resume(Effect.fail(CommandError.failed(errorText(cause), cause))),
          );
          child.once("spawn", () => resume(Effect.succeed(child.pid)));
          // Ownership transfers to the OS. Canceling discovery must not kill
          // this shared daemon; its once-listeners also absorb a late spawn error.
          child.unref();
        } catch (cause) {
          resume(Effect.fail(CommandError.failed(errorText(cause), cause)));
        } finally {
          if (log !== undefined) closeSync(log);
        }
      });

      /** Spawns a daemon and returns whichever one wins the port bind. */
      const startDaemon = Effect.fnUntraced(function* () {
        const child = yield* spawnDaemon;
        const serve = yield* polledHosts.pipe(
          Effect.repeat({
            schedule: Schedule.spaced(SERVE_POLL_MS),
            until: (answer) => answer !== undefined,
          }),
          Effect.timeoutOrElse({
            duration: SERVE_START_MS,
            orElse: () =>
              Effect.fail(CommandError.unavailable(`rook serve did not start; see ${logPath}`)),
          }),
        );
        if (!serve) return yield* Effect.die("the start poll ended without an answer");
        if (serve.pid === child)
          yield* write("started rook serve; waiting for Chrome profiles to connect\n");
        return serve;
      });

      /** SIGTERMs an older daemon and waits until it no longer holds the port. */
      const stopOlder = Effect.fnUntraced(function* (serve: Serve) {
        const delivered = yield* Effect.try({
          try: () => process.kill(serve.pid, "SIGTERM"),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) => {
            const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
            // Another CLI replacing the same daemon got there first.
            if (code === "ESRCH") return Effect.succeed(false);
            const message = `could not stop rook serve ${serve.version} (pid ${serve.pid}): ${errorText(cause)}`;
            return Effect.fail(
              code === "EPERM"
                ? CommandError.unavailable(message, cause)
                : CommandError.failed(message, cause),
            );
          }),
        );
        // Done once that pid stops answering: the port is quiet, or a daemon
        // someone else started holds it and the next round judges it.
        yield* polledHosts.pipe(
          Effect.repeat({
            schedule: Schedule.spaced(SERVE_POLL_MS),
            until: (answer) => answer?.pid !== serve.pid,
          }),
          Effect.timeoutOrElse({
            duration: SERVE_STOP_MS,
            orElse: () =>
              Effect.fail(
                CommandError.unavailable(
                  `rook serve ${serve.version} (pid ${serve.pid}) did not stop`,
                ),
              ),
          }),
        );
        if (delivered)
          yield* write(`stopped rook serve ${serve.version}; starting ${packageJson.version}\n`);
      });

      /** The port bind elects the daemon; an older one is replaced, never a newer one. */
      const elect = Effect.fnUntraced(function* () {
        for (let replaced = 0; ; replaced++) {
          const serve = (yield* onlineHosts) ?? (yield* startDaemon());
          if (compareReleases(serve.release, ownRelease) >= 0) return serve;
          if (replaced === REPLACEMENTS)
            return yield* CommandError.unavailable(
              `an older rook serve came back on port ${config.relayPort} after ${REPLACEMENTS} stops; update every installed rook, then run this again`,
            );
          yield* stopOlder(serve);
        }
      });

      /** Hosts the daemon lists that `known` lacks, polled until one appears or `within` passes. */
      const newHosts = (known: ReadonlySet<string>, within: number) =>
        polledHosts.pipe(
          Effect.map((answer) => (answer?.hosts ?? []).filter((id) => !known.has(id))),
          Effect.repeat({
            schedule: Schedule.spaced(HOSTS_POLL_MS),
            until: (hosts) => hosts.length > 0,
          }),
          Effect.timeoutOrElse({
            duration: within,
            orElse: () => Effect.succeed<string[]>([]),
          }),
        );

      /** The host list once the daemon has settled, by its own start time. */
      const connectedHosts = Effect.fnUntraced(function* () {
        const serve = yield* elect();
        const now = yield* Clock.currentTimeMillis;
        // Clamped: a start time ahead of this clock must not stretch the wait.
        const settle = Math.min(
          Math.max((serve.startedAt ?? 0) + REDIAL_SETTLE_MS - now, 0),
          REDIAL_SETTLE_MS,
        );
        const fresh = settle > 0;
        if (!fresh && serve.hosts.length) return serve.hosts;
        yield* Effect.sleep(settle);
        return yield* newHosts(new Set(), fresh ? FIRST_PROFILE_MS : REDIAL_SETTLE_MS);
      });

      const leaseUrl = (name: string, query: Record<string, string>) => {
        const url = new URL(LEASES_PATH + encodeURIComponent(name), relay);
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
        return url;
      };

      /** The daemon's lease on `name`: its id when granted, "held" while another
       * rook holds it, and undefined for any other answer or none, which goes
       * ahead as granted so a lease never fails a command on its own. */
      const lease = (name: string, ms: number) =>
        Effect.gen(function* () {
          const token = yield* config.token;
          const response = yield* http.post(leaseUrl(name, { ms: String(ms) }), {
            headers: { authorization: `Bearer ${token}` },
          });
          if (response.status === 409) return "held" as const;
          if (response.status !== 200) return undefined;
          const { id } = yield* HttpClientResponse.schemaBodyJson(leaseSchema)(response);
          return id;
        }).pipe(
          Effect.timeoutOption(SERVE_ANSWER_MS),
          Effect.map(Option.getOrUndefined),
          Effect.catch(() => Effect.succeed(undefined)),
        );

      const release = (name: string, id: string) =>
        Effect.gen(function* () {
          const token = yield* config.token;
          yield* http.del(leaseUrl(name, { id }), {
            headers: { authorization: `Bearer ${token}` },
          });
        }).pipe(Effect.timeoutOption(SERVE_ANSWER_MS), Effect.ignore);

      const exclusive = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          // A holder frees the lease or dies, and it expires; past that wait,
          // going ahead is the behaviour from before there were leases.
          const answer = yield* lease(name, EXCLUSIVE_MS).pipe(
            Effect.repeat({
              schedule: Schedule.spaced(LEASE_RETRY_MS),
              until: (answer) => answer !== "held",
            }),
            Effect.timeoutOption(EXCLUSIVE_MS + SERVE_ANSWER_MS),
            Effect.map(Option.getOrUndefined),
          );
          if (answer === undefined || answer === "held") return yield* effect;
          return yield* effect.pipe(Effect.ensuring(release(name, answer)));
        });

      /** Whether this process opens Chrome in `dir`. The claim is never released:
       * it lapses once a Chrome another rook opened has had its time to dial in. */
      const claimChrome = (dir: string | undefined) =>
        lease(`chrome:${dir ?? "any"}`, OPENED_PROFILE_MS).pipe(
          Effect.map((answer) => answer !== "held"),
        );

      const connect = Effect.fnUntraced(function* (id: string) {
        const root = yield* client<RookDirectory, RookDirectoryState>(
          id,
          AGENT_CLASS_NAME,
          AGENT_INSTANCE_NAME,
        );
        yield* ready(root, `profile ${id.slice(0, 8)} did not answer`);
        yield* directory(root).pipe(
          Effect.repeat({
            schedule: Schedule.spaced(VERIFICATION_POLL_MS),
            until: (state) => state.profileVerification.status !== "unknown",
          }),
          Effect.timeoutOption(VERIFICATION_MS),
        );
        const state = yield* directory(root);
        const profile: Profile = { id, root, label: profileEmail(state) ?? id.slice(0, 8) };
        return profile;
      });

      // Hosts the relay listed that did not answer: a command that needs one
      // profile cannot take the others as the whole choice.
      let unanswered = 0;
      const answering = Effect.fnUntraced(function* (hosts: readonly string[]) {
        const owner = yield* Effect.scope;
        const results = yield* Effect.forEach(
          hosts,
          (id) =>
            Effect.gen(function* () {
              const scope = yield* Scope.fork(owner);
              const result = yield* connect(id).pipe(Scope.provide(scope), Effect.result);
              if (Result.isSuccess(result)) return [result.success];
              yield* Scope.close(scope, Exit.fail(result.failure));
              yield* write(`rook: skipped ${result.failure.message}\n`);
              unanswered++;
              return [];
            }),
          { concurrency: "unbounded" },
        );
        return results.flat();
      });

      const chromeToOpen = Effect.fnUntraced(function* (wanted?: string) {
        const profiles = yield* chrome.profiles;
        const installed = profiles.filter(({ rook }) => rook);
        const names = installed.map(({ dir, email }) => email || dir).join(", ");
        if (!wanted && installed.length > 1)
          return yield* CommandError.usage(
            `Rook is in Chrome profiles ${names} and none is connected: ask the user which one, then pass --profile <email> on every rook call; rook opens that profile`,
          );
        const target = wanted
          ? profiles.find(({ email }) => email.toLowerCase() === wanted.toLowerCase())
          : installed[0];
        if (wanted && !target)
          return yield* CommandError.usage(
            `no connected profile or Chrome profile is ${wanted}${names ? `; Chrome profiles with Rook: ${names}` : ""}`,
          );
        if (target?.rook) return target;
        const claimed = yield* claimChrome(target?.dir);
        if (claimed)
          yield* profiles.length
            ? chrome.open({ profile: target?.dir, url: STORE_URL })
            : chrome.openUrl(STORE_URL);
        const opener = claimed ? "Opened" : "Another rook opened";
        return yield* CommandError.unavailable(
          profiles.length
            ? `Rook is not installed in Chrome${target?.email ? ` profile ${target.email}` : ""}. ${opener} ${STORE_URL} in Chrome: ask the user to click Add to Chrome and follow Rook's setup tab, then run this again`
            : `found no Google Chrome profile here. ${opener} ${STORE_URL}: ask the user to install or open Chrome, add Rook from that page if it isn't there and follow Rook's setup tab, then run this again`,
        );
      });

      const profiles = Effect.fn("rook.profiles")(function* (wanted?: string) {
        const hosts = yield* connectedHosts();
        const connected = yield* answering(hosts);
        if (matching(connected, wanted).length) return connected;
        if (hosts.length && !connected.length)
          return yield* CommandError.unavailable(
            "no connected profile answered: ask the user to restart Chrome, then run this again",
          );
        // The named profile may be the one that did not answer, and Chrome
        // already has it open.
        if (connected.length < hosts.length)
          return yield* CommandError.unavailable(
            `a connected profile did not answer, and none that did is ${wanted}: run this again, and if it repeats ask the user to restart Chrome`,
          );
        const selected = yield* chromeToOpen(wanted);
        const where = selected.email ? ` profile ${selected.email}` : "";
        // Concurrent cold starts open one window: the rest wait for its host.
        if (yield* claimChrome(selected.dir)) {
          yield* chrome.open({ profile: selected.dir });
          yield* write(`opened Chrome${where}; waiting for Rook to connect\n`);
        } else yield* write(`another rook is opening Chrome${where}; waiting for Rook to connect\n`);
        // Another profile may dial in first: wait for the one this command names.
        const known = new Set(hosts);
        const until = (yield* Clock.currentTimeMillis) + OPENED_PROFILE_MS;
        let reached = connected;
        while (!matching(reached, wanted).length) {
          const added = yield* newHosts(known, until - (yield* Clock.currentTimeMillis));
          if (!added.length) break;
          for (const id of added) known.add(id);
          reached = [...reached, ...(yield* answering(added))];
        }
        if (matching(reached, wanted).length) return reached;
        return yield* CommandError.unavailable(
          `Rook did not connect from Chrome${where}: ask the user to open Rook's side panel there and keep Allow local agents on in its menu, then run this again`,
        );
      });

      return {
        profiles,
        unanswered: Effect.sync(() => unanswered),
        connected: connectedHosts().pipe(Effect.flatMap(answering)),
        ready,
        call,
        exclusive,
        conversation: (profile: Profile, id: string) =>
          client<RookConversation, RookConversationState>(
            profile.id,
            CONVERSATION_AGENT_CLASS_NAME,
            id,
          ),
      };
    }),
  );
}

/** The profile's synchronized state as of each run, which arrives with its first frame. */
export const directory = (root: Directory) =>
  Effect.suspend(() =>
    root.state
      ? Effect.succeed(root.state)
      : Effect.fail(CommandError.unavailable("the profile sent no state")),
  );

/** The account a profile's state vouches for: its verified Chrome sign-in or
 * its employee binding. Unlike the host id, it survives a Chrome restart. */
export function profileEmail(state: RookDirectoryState): string | undefined {
  if (state.profileVerification.status === "verified") return state.profileVerification.email;
  if (state.operatingIdentity.kind === "employee") return state.operatingIdentity.email;
  return undefined;
}

/** The profiles `wanted` names by label (any case) or host-id prefix; all of
 * them when it is omitted. */
export function matching(all: Profile[], wanted: string | undefined): Profile[] {
  return wanted
    ? all.filter(
        ({ id, label }) => label.toLowerCase() === wanted.toLowerCase() || id.startsWith(wanted),
      )
    : all;
}

/** Profiles by label; two with one label are told apart by the id --profile also takes. */
const named = (all: Profile[]) =>
  all
    .map(({ id, label }) =>
      all.filter((other) => other.label === label).length > 1
        ? `${label} (--profile ${id.slice(0, 8)})`
        : label,
    )
    .join(", ");

const silent = (unanswered: number) =>
  `${unanswered} connected profile${unanswered === 1 ? "" : "s"} did not answer`;

/** The profile `wanted` names; omitted, the only profile online. `unanswered`
 * counts connected profiles that did not answer and so are not in `all`. */
export const pick = Effect.fnUntraced(function* (
  all: Profile[],
  wanted: string | undefined,
  unanswered = 0,
) {
  const matches = matching(all, wanted);
  const [only] = matches;
  const choices = named(all);
  // The only profile that answered is not the only one connected.
  if (!wanted && unanswered)
    return yield* CommandError.unavailable(
      `${silent(unanswered)}, so rook cannot tell which profile to use: run this again, or pass --profile <email> (answering: ${choices})`,
    );
  if (only && matches.length === 1) return only;
  // A name that matches nothing is usually a profile that is closed or opted out.
  if (wanted && !matches.length) {
    return yield* CommandError.unavailable(
      `no connected profile matches ${wanted}; connected: ${choices}`,
    );
  }
  return yield* CommandError.usage(
    `${all.length} profiles are connected: ${choices}. Ask the user which one, then pass --profile <email> on every rook call`,
  );
});

/** A thread id or unique prefix, searched in every profile unless one is named. */
export const locate = Effect.fnUntraced(function* (
  all: Profile[],
  wanted: string | undefined,
  prefix: string,
  unanswered = 0,
) {
  const candidates = wanted ? [yield* pick(all, wanted)] : all;
  const found: Located[] = [];
  for (const profile of candidates) {
    const state = yield* directory(profile.root);
    for (const { id } of state.threads)
      if (id.startsWith(prefix)) found.push({ profile, threadId: id });
  }
  const [only] = found;
  if (only && found.length === 1) return only;
  // The thread may live in a profile that did not answer.
  if (!found.length && !wanted && unanswered)
    return yield* CommandError.unavailable(
      `no thread ${prefix} in ${named(candidates)}, and ${silent(unanswered)}: run this again`,
    );
  return yield* CommandError.usage(
    found.length
      ? `${prefix} matches ${found.map(({ threadId }) => threadId).join(", ")}`
      : `no thread ${prefix} in connected profiles ${named(candidates)}`,
  );
});
