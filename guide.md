Rook is an agent in the user's Chrome. Each Chrome profile with Rook is its own Rook, signed in as that profile's email, with its own threads and its own workspace filesystem.

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

Without a terminal, `rook ask` and `rook wait` return 124 after 100 seconds, inside a tool call's time limit; the run goes on in Chrome. `--timeout` takes `700ms`, `30s`, `2m` or `1h` (a bare number is seconds) and `0` waits indefinitely; it bounds only the waiting, never Rook's work. A reply with no text and no files counts as failed. To keep output and the exit status, redirect to files (`> reply.txt 2> err.txt`) or `set -o pipefail` before `| tee`, with a new file per call.

- `rook ask --thread <id> "…"` follows up in a thread; on a working thread it runs after the current turn. It streams and reports only that message's own turn and ends when that turn does, exit 6 if a stop skipped it; a later message's turn or human wait is not its own. `--id <uuid>` makes an ask safe to repeat; `--detach` prints the id and returns. stderr says whether the message started, runs after the current turn, or was already submitted under that `--id`.
- `rook show <id>` prints the thread as the user sees it, even mid-turn, `--tools` with its tool calls and their errors; stderr then says if it is still running, needs the user, stopped or failed, and why it failed. `rook stop <id>` ends the current turn or script and skips messages queued behind it; stderr says whether anything was running.
- To redirect a working thread, `rook stop <id>`, then `rook ask --thread <id> "…"`: the thread keeps what it had read and done.
- `rook wait`, `show` and `stop` find a thread id in every connected profile; no `--profile` needed.
- After a failure, `rook ask --thread <id> "Summarize what you did and found, as text only"` recovers the work.
- `rook rename <id> TITLE` sets a thread's title in the user's list, 1 to 48 characters. `rook rm <id>…` deletes threads, working ones too, as the side panel's delete does. Your threads sit in the user's list beside theirs: remove one that was only scratch for your task once you have what you need, and keep one the user will want to read or continue.
- After 3, `rook wait <id> --wait-human` waits for the user.

## Profiles

With one profile connected, every command uses it. With several, a command exits 2 listing their emails: ask the user which, then pass `--profile <email>` on every `rook` call for the rest of the session (or set `ROOK_PROFILE`). When that Chrome profile isn't open, rook opens it, or the Web Store if Rook isn't there. `rook ls` lists every Chrome profile and whether Rook is connected or installed in it, opening nothing; `rook ps` lists threads, and its `updatedAt` is when a thread's status last changed, not its latest activity.

Several agents can use one Rook at once. Each keeps its own thread and passes `--thread <id>` to stay in it, and all of them share one `rook serve`. That needs no configuring while they share one home and port; an agent given its own `HOME` or `ROOK_HOME` holds another token and gets exit 4. `rook rm` matches id prefixes across every profile, so pass your own full thread id. Exit 5 saying to update every installed `rook` means an older copy keeps replacing `rook serve`: tell the user. `rook serve` keeps the environment of whichever process started it. When several agents start with Chrome closed, one opens it and the rest print `another rook is opening Chrome` and wait for it.

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
- A run without `--thread <id>` gets a thread of its own, removed once the run ends; its record stays under `/executions`.
- `rook run` waits however long the script takes. With `--timeout` it exits 124 and names the record, `/executions/results/<id>.trace.json`, that gets the script's status, result and logs when it ends. Read that record to follow the run, since `rook wait` follows a prompt's turn; the run's thread stays, so `rook stop <thread>` still reaches it.

## Tools

Open pages can register WebMCP tools, and the user can connect MCP servers to Rook. `rook tools` lists both, a line per tool: its name, where it is (`tab <id> <url>` or `server <id>`) and what it does. `rook call` runs one the way Rook's own code does, without a prompt:

```bash
rook tools
rook call search_issues --tab 1234 --args '{"query":"login bug"}'
```

- stdout is the result's text, then a `file: <path>` line for each image or resource, saved under `~/.rook/files/`; a resource the tool only links to prints its URI there. A tool that reports an error exits 1 with its text on stderr.
- A name on more than one tab or server exits 2 saying where; pass `--tab <id>` or `--server <id>`.

## Model

A selected profile with no model gets what Codex here uses, through `rook serve`, before its first action; stderr says so. Listing profiles or threads does not change models. A model chosen in the side panel or set by policy stays.
When the user asks for another, `rook model` lists each profile's, `rook model codex` or `rook model url` sets it after one test request that fails with the upstream's status and body, and `rook model off` takes profiles off serve; `rook model codex -h` and `rook model url -h` list their flags.
A variable for `--header-env` must be in `rook serve`'s environment.

## Notes

- `rook ask`, `rook run`, `rook call` and `rook bash` act as the user, and writes under `/mounts` are real.
- In a sandbox, `rook` needs 127.0.0.1:7391, write access to `~/.rook`, and to start `rook serve` on first use.
- `--json` prints NDJSON. `ask` starts with a `run.started` line (`new`, `queued`, `repeat`, `message`: its submission id), streams a `message` line per text and a `tool` line (`name`) per tool call, and with `--detach` prints only that first line; `ask` and `wait` print a `needs_human` line (`reason`, `tab`, `expiresAt`) when the thread waits for the user and end with a `result` line (`status`, `exit`, `text`, `files`), after an `error` line with Rook's reason when it failed, `run` with an `execution` line, `show` prints a `message` line per message and a last `status` line (`status`, `detail`), `tools` a line per tool with its `inputSchema`, `call` the tool's MCP result, and `ls`, `ps`, `stop` (with `wasRunning`), `rm` and `rename` a line per row. When `rook` itself fails, the last line is an `error` with `exit`.
