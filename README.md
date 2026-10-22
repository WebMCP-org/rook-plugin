# rook

[Rook](https://rook.sigvelo.com) is a browser agent in your own Chrome, signed in as you. The `rook` command and its `rook-browser` skill let shell agents such as Claude Code, Codex and Cursor hand Rook web work: sites behind your login, pages that need a real browser, Playwright code, a page's WebMCP tools, and files in Rook's workspace.

```bash
rook ask "Open the team wiki and list next week's on-call rotation"
```

`rook` reaches Rook through `rook serve`, a relay on 127.0.0.1 that it starts on demand.

## Install

Add Rook to Chrome from the [Chrome Web Store](https://chromewebstore.google.com/detail/opojeelojlkcinlhkbahpcekdolfjmhi), then give your agent the skill:

- Claude Code: `/plugin marketplace add WebMCP-org/rook-plugin`, then `/plugin install rook@rook`. This puts `rook` on Claude Code's PATH and adds a `rook` sub-agent Claude can delegate web tasks to. To take a new release, run `/plugin marketplace update rook`, then `/plugin update rook@rook`.
- Codex: `codex plugin marketplace add WebMCP-org/rook-plugin`, then install Rook from `/plugins`.
- Other agents: `npx skills add WebMCP-org/rook-plugin`.
- Only the command: `npm install -g @mcp-b/rook`. `rook skill print` prints the skill.

`rook` needs Node.js 22.18 or later and Google Chrome.

## Model

A Rook profile with no model of its own uses one through `rook serve`: what Codex on this computer is set up for, a custom provider or your ChatGPT plan. `rook model` shows each profile's model and sets it:

```bash
rook model codex          # ChatGPT through your Codex sign-in
rook model url https://llm.example.com/v1 --api responses --model my-model \
  --header-cmd 'Authorization=print-token'    # any Responses or chat endpoint
rook model off            # no model from rook serve
```

`--profile`, `--model` and `--effort` pick the profile, model and reasoning effort, and `rook model -h` lists the rest. Each sends one test request and keeps the previous setting in `~/.rook/model.json` if it fails. A model you choose in Rook's side panel, or one your administrator sets, is never replaced. Rook's model calls stop while `rook serve` is not running, and any `rook` command starts it again.

## Verify a release

Every release is built and published by [this repository's release workflow](.github/workflows/release.yml) from its `v<version>` tag. npmjs.com shows the package's [provenance](https://docs.npmjs.com/generating-provenance-statements) badge, and each GitHub release carries the npm tarball, the `rook` executable, `SHA256SUMS` and a signed build attestation:

```bash
npm audit signatures   # verifies it in a project that has @mcp-b/rook as a dependency
gh release download v<version> -R WebMCP-org/rook-plugin
sha256sum -c SHA256SUMS
gh attestation verify mcp-b-rook-<version>.tgz -R WebMCP-org/rook-plugin
gh attestation verify rook -R WebMCP-org/rook-plugin
```

## Contributing

Issues are welcome here; report vulnerabilities as [SECURITY.md](SECURITY.md) says. This repository is a read-only mirror of the CLI's source, published from Rook's main repository on every Rook release, so pull requests aren't merged here.

## License

The CLI and its plugin are licensed under [Apache-2.0](LICENSE). The Rook Chrome extension it drives is required, and is separate software under its own license (not Apache-2.0).
