---
name: rook-browser
description: Hands web work to Rook, the browser agent in the user's own Chrome, signed in as them, through the `rook` CLI. Use for sites behind the user's login (internal tools, SSO, dashboards, tickets, email), anything that needs a real browser, driving a page with Playwright code, calling a page's WebMCP tools, or moving files in and out of Rook's workspace.
allowed-tools: Bash(rook ls:*), Bash(rook ps:*), Bash(rook wait:*), Bash(rook show:*), Bash(rook tools:*)
---

# rook-browser

Rook is an agent in the user's Chrome. Each Chrome profile with Rook is its own Rook, signed in as that profile's email, with its own threads and its own workspace filesystem. If `rook --version` doesn't print `rook 1.1.1005 (@mcp-b/rook)`, use `npx -y @mcp-b/rook@1.1.1005` in place of `rook`.

## The loop

```bash
rook ask "Open the team wiki and list next week's on-call rotation"
```

stdout is Rook's reply as the user sees it in the side panel: its text, then a `file: <path>` line for each image or file it sent, saved under `~/.rook/files/<thread>/`. stderr carries `thread <id> on <email>` and the next command to run. The first command starts `rook serve` and opens Chrome, or Rook's Chrome Web Store page if Rook isn't installed; what only the user can do, stderr spells out.

| Exit | Meaning                                 |
| ---- | --------------------------------------- |
| 0    | done                                    |
| 1    | failed; stderr says why                 |
| 2    | usage; stderr says what to fix          |
| 3    | needs the user (a sign-in…)             |
| 4    | token mismatch; restart `rook serve`    |
| 5    | Rook not reachable yet; stderr says why |
| 6    | stopped                                 |
| 124  | still running: `rook wait <id>`         |

Without a terminal, `rook ask` and `rook wait` return 124 after 100 seconds, inside a tool call's time limit; the run goes on in Chrome. A reply with no text and no files counts as failed.

- `rook ask --thread <id> "…"` follows up in a thread; `--id <uuid>` makes an ask safe to repeat; `--detach` prints the id and returns.
- `rook show <id>` prints the thread as the user sees it, `--tools` with its tool calls. `rook stop <id>` cancels a run or a script.
- After 3, `rook wait <id> --wait-human` waits for the user.

## Profiles

With one profile connected, every command uses it. With several, a command exits 2 listing their emails: ask the user which, then pass `--profile <email>` on every `rook` call for the rest of the session (or set `ROOK_PROFILE`). When that Chrome profile isn't open, rook opens it. `rook ls` lists profiles, `rook ps` their threads.

## The workspace

`rook bash SCRIPT` runs a fresh shell on Rook's workspace at `/`. Piped stdin goes in; stdout, stderr and the exit status come back:

```bash
rook bash 'cat /sites/example.com/export.json' | jq '.rows' > rows.json
base64 < chart.png | rook bash 'base64 -d > /tmp/chart.png'
rook bash 'base64 /tmp/report.pdf' | base64 -d > report.pdf
```

```
/
├── SOUL.md                  who Rook is and works for
├── WORKING.md               its live plan and open obligations
├── memory/MEMORY.md         durable memory, shared by every thread
├── skills/<name>/SKILL.md   its skills, with scripts/ and lib/
├── automations/*.ts         saved jobs; `rook run` takes these
├── sites/<host>/            what it knows about each site
│   ├── NOTES.md
│   ├── scripts/<name>.ts    code that worked there
│   └── runs/<name>/         each run's args, outcome, logs
├── executions/              run records: results/, logs/, traces; kept 30 days
├── correspondence/          drafts awaiting review
├── uploads/<thread>/        files attached to a thread
├── mounts/<name>/           real folders on the user's disk; writes are real
└── tmp/                     scratch
```

- just-bash builtins (grep, sed, awk, jq, find, rg, base64…; `help` lists them). No network, git, node or python. 30 seconds per script, then exit 124.
- Stdin is read only from a shell pipe or file; with nothing piped, add `< /dev/null` if it waits.

## Code

To drive a page with code instead of a prompt, write a script to `/automations/` and `rook run` it. Only `/automations/*.ts` and `.js` run.

```bash
rook bash 'cat > /automations/page-info.ts' <<'TS'
export default async function run(args: { url: string }) {
  const { page } = await browser.getTab({ url: args.url });
  if (page.url() !== args.url) await page.goto(args.url, { waitUntil: "domcontentloaded" });
  return { title: await page.title(), links: await page.locator("a").count() };
}
TS
rook run /automations/page-info.ts --args '{"url":"https://example.com/"}'
```

- stdout is the returned value as JSON; stderr has `execution <id>`, the `console.log` lines and saved file paths. A throw or type error exits 1; `rook stop <thread>` makes it exit 6.
- Globals: `browser`, `workspace`, `ai`, `mcp`, `human` and more. `browser.getTab({ url })` returns `{ page, tabId }`, a Playwright page in the user's Chrome; it reuses a tab at that URL or opens one without waiting for load.
- Each run without `--thread <id>` adds a thread to the user's list.
- `rook run` waits however long the script takes. With `--timeout` it exits 124 and names the record, `/executions/results/<id>.trace.json`, that gets the script's status, result and logs when it ends.

## Tools

Open pages can register WebMCP tools, and the user can connect MCP servers to Rook. `rook tools` lists both, a line per tool: its name, where it is (`tab <id> <url>` or `server <id>`) and what it does. `rook call` runs one the way Rook's own code does, without a prompt:

```bash
rook tools
rook call search_issues --tab 1234 --args '{"query":"login bug"}'
```

- stdout is the result's text, then a `file: <path>` line for each image or resource, saved under `~/.rook/files/`. A tool that reports an error exits 1 with its text on stderr.
- A name on more than one tab or server exits 2 saying where; pass `--tab <id>` or `--server <id>`.

## Model

A profile with no model gets what Codex here uses, through `rook serve`, when rook first reaches it; stderr says so. A model chosen in the side panel or set by policy stays.
When the user asks for another, `rook model` lists each profile's, `rook model codex` or `rook model url` sets it after one test request that fails with the upstream's status and body, and `rook model off` takes profiles off serve; `rook model -h` has the flags.
A variable for `--header-env` must be in `rook serve`'s environment.

## Notes

- `rook ask`, `rook run`, `rook call` and `rook bash` act as the user, and writes under `/mounts` are real.
- In a sandbox, `rook` needs 127.0.0.1:7391, write access to `~/.rook`, and to start `rook serve` on first use.
- `--json` prints NDJSON. `ask` and `wait` end with a `result` line (`status`, `exit`, `text`, `files`), `run` with an `execution` line, `show` prints a `message` line per message, `tools` a line per tool with its `inputSchema`, `call` the tool's MCP result, and `ls` and `ps` a line per row. When `rook` itself fails, the last line is an `error` with `exit`.
