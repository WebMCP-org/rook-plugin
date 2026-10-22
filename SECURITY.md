# Security

Report a vulnerability in the `rook` CLI, `rook serve` or the plugin through [GitHub's private vulnerability reporting](https://github.com/WebMCP-org/rook-plugin/security/advisories/new), not a public issue. Reports about the Rook Chrome extension are welcome there too.

We aim to acknowledge a report within three business days and to ship a fix in the next release. Only the latest release is supported.

`rook serve` listens only on `127.0.0.1`. It admits the Rook extension by its exact Origin and the CLI by the Bearer token in `~/.rook/token`, a file only your user can read. The extension can't yet authenticate the relay: whichever local process binds the port first receives every profile whose "Allow local agents" switch is on. Turn that switch off in Rook's menu where that matters.
