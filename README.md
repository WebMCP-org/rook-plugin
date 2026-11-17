# rook

[Rook](https://rook.sigvelo.com) is a browser agent in your own Chrome, signed in as you. The `rook` command and its `rook-browser` skill let shell agents such as Claude Code, Codex and Cursor hand Rook web work: sites behind your login, pages that need a real browser, Playwright code, a page's WebMCP tools, and files in Rook's workspace.

```bash
rook ask "Open the team wiki and list next week's on-call rotation"
```

`rook` reaches Rook through `rook serve`, a relay on 127.0.0.1 that it starts on demand. `rook ls` lists every Chrome profile and whether Rook is connected or installed in it; it starts `rook serve` (or replaces an older one) but opens no Chrome window. Naming an unconnected profile on another command opens it, or the Web Store if Rook isn't there.

## Install

Add Rook to Chrome from the [Chrome Web Store](https://chromewebstore.google.com/detail/opojeelojlkcinlhkbahpcekdolfjmhi), then give your agent the skill:

- Claude Code: `/plugin marketplace add WebMCP-org/rook-plugin`, then `/plugin install rook@rook`. This puts `rook` on Claude Code's PATH and adds a `rook` sub-agent Claude can delegate web tasks to. To take a new release, run `/plugin marketplace update rook`, then `/plugin update rook@rook`.
- Codex: `codex plugin marketplace add WebMCP-org/rook-plugin`, then install Rook from `/plugins`.
- Other agents: `npx skills add WebMCP-org/rook-plugin`.
- Only the command: `npm install -g @mcp-b/rook`. `rook skill print` prints the skill.

The skill is a short entry point that names no version: it sends the agent to `rook guide`, which prints the instructions for the `rook` it is running.

`rook` needs Node.js 22.19 or later and Google Chrome.

## Model

A Rook profile with no model of its own uses one through `rook serve`: what Codex on this computer is set up for, a custom provider or your ChatGPT plan. `rook model` shows each profile's model and sets it:

```bash
rook model codex          # ChatGPT through your Codex sign-in
rook model url https://llm.example.com/v1 --api responses --model my-model \
  --header-cmd 'Authorization=print-token'    # any Responses or chat endpoint
rook model off            # no model from rook serve
```

`--profile`, `--model` and `--effort` pick the profile, model and reasoning effort, and `rook model codex --help` and `rook model url --help` describe their options. Each sends one test request and keeps the previous setting in `~/.rook/model.json` if it fails. A model you choose in Rook's side panel, or one your administrator sets, is never replaced. Rook's model calls stop while `rook serve` is not running, and any `rook` command starts it again.

## Threads

Each `rook ask` works in a thread in Rook's side panel. `rook ask --thread <id>` follows up there; on a working thread it runs after the current turn, and `rook stop <id>` ends that turn and skips messages queued behind it. A follow-up follows its own message, not the thread: it streams and reports only that message's turn and ends when that turn does, `stopped` when a stop skipped it, and a later message's turn or human wait is not its own. Against a Rook older than the CLI it follows the thread as `rook wait` does. `rook wait`, `show` and `stop` find a thread in every connected profile, and `rook show` works mid-turn, ending on stderr with whether the thread is still running, needs the user, stopped or failed, and why it failed. `rook ask` says on stderr whether its message started, was queued behind the current turn or repeats an earlier `--id`, and `rook stop` whether anything was running. With `--json`, `ask` starts with a `run.started` line and streams `message` and `tool` lines before its `result`, and `show` ends with a `status` line. `rook ps` lists threads, `rook rename <id> TITLE` sets one's title and `rook rm <id>…` deletes them, working or not, as the side panel's delete does. `rook rm` matches an id prefix across every connected profile, so pass the full id. A `rook run` without `--thread` removes its thread once the run has ended, and its record stays under `/executions` in Rook's workspace; if the CLI stops waiting first, it exits 124 on `--timeout` and 130 on Ctrl-C (143 on SIGTERM), the thread stays and `rook stop <thread>` still reaches the run. With `OTEL_TRACES_EXPORTER=otlp` and `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) set, the CLI exports its own spans over OTLP/HTTP, protobuf unless `OTEL_EXPORTER_OTLP_PROTOCOL` is `http/json`, as children of a valid `TRACEPARENT` and without error messages.

Several agents can share one Rook. Each keeps its own thread by passing `--thread <id>`, and all of them go through one `rook serve` with nothing to configure as long as they share one home and relay port: an agent given its own `HOME` or `ROOK_HOME` holds another token and gets exit 4. That daemon keeps the environment of whichever process started it, which is where the variables a `rook model url` header reads must be. It also takes turns among them: concurrent `~/.rook/model.json` updates never lose one, and when several agents start with Chrome closed, one opens it. Exit 5 saying to update every installed `rook` means an older installed copy keeps replacing the daemon.

## Verify a release

Every release is built and published by [this repository's release workflow](.github/workflows/release.yml) from its `v<version>` tag. npmjs.com shows the package's [provenance](https://docs.npmjs.com/generating-provenance-statements) badge, and each GitHub release carries the npm tarball, the `rook` executable, `SHA256SUMS` and a signed build attestation:

```bash
npm audit signatures   # verifies it in a project that has @mcp-b/rook as a dependency
gh release download v<version> -R WebMCP-org/rook-plugin
sha256sum -c SHA256SUMS
gh attestation verify mcp-b-rook-<version>.tgz -R WebMCP-org/rook-plugin
gh attestation verify rook -R WebMCP-org/rook-plugin
```

A tag whose push started no release run is released with `gh workflow run release.yml -R WebMCP-org/rook-plugin --ref v<version>`.

## Contributing

Issues are welcome here; report vulnerabilities as [SECURITY.md](SECURITY.md) says. This repository is a read-only mirror of the CLI's source, published from Rook's main repository on every Rook release, so pull requests aren't merged here.

## License

The CLI and its plugin are licensed under [Apache-2.0](LICENSE). The Rook Chrome extension it drives is required, and is separate software under its own license (not Apache-2.0).
