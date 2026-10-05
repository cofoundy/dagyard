# dagyard CLI: command reference

Shape of every call: `dagyard <command> [<args>] [<options>]`. Command first, options after, the binary
spelled out on each call (no shell variables). `dagyard <command> --help` is the ground truth for the
installed version.

Common options: `-p/--project <p>`, `--url <url>`, `-h/--help`. These three are the only ones also accepted
before the command. Inside a repo with `.dagyard.json` neither is needed. Precedence: `--project/--url` >
`DAGYARD_PROJECT/DAGYARD_URL` > `.dagyard.json` (the first one walking up from the current folder, never
past the repo root or `$HOME`; its url gets the key only if it is https and trusted) >
`~/.config/dagyard/{project,url}`. The key comes only from `DAGYARD_KEY` or `~/.config/dagyard/agent-key`.
Messages are in English; with `LANG=es` (or `LC_ALL`/`LC_MESSAGES`) they are in Spanish.

Node ids are short slugs: `T-314-A` is stored as `t-314-a`. Every command that writes a node prints only
its id.

## Moving a node

| Command | What it does |
|---|---|
| `dagyard start <node> [--team '…'] [--site <site>]` | In progress (shortcut of `node start`). `--team`: the human name of the site or session. `--site` (or `$COFOUNDY_AGENT`): the factory site that takes it; the server adds the task to that team and creates the team if needed. On a closed node it reopens it |
| `dagyard progress <node> <p>` | progress as `0..1` or `40%` (shortcut of `node progress`) |
| `dagyard msg <node> '…' [--report <url>] [--from '…']` | a note for the PM, ≤280 characters. The server fills `--from` with the team name |
| `dagyard node update <node> [--title '…'] [--stage <stage>] [--goal '…'] [--team '…'] [--status <status>] [--progress <p>] [--report <url>] [--link <url>]` | changes fields. `--status pending\|working` on a closed node reopens it (the history keeps the close); `--status done` closes as `done` with no reason. Never `--status blocked`: only `block` sets it |
| `dagyard done <node> [--report <url>]` | the older shortcut of `node done`: closes as `done` with no reason. Fails with an open blocker. Prefer `node close --as done` |
| `dagyard edge add <from> <to>` | dependency: `<to>` needs `<from>` closed. Rejected if it closes a loop, or if `<from>` is a goal or a stream |

`--goal` on `node add`/`node update` is the task's one-line mission (what `next` prints as `/goal …`), not a
goal node. `--link` is the technical detail (the issue or PR URL); `--report` the Basalt report.

## Asking a person

| Command | What it does |
|---|---|
| `dagyard block <node> --kind decision --q '…' --opt '…' [--opt '…']…` | a decision, 1 to 6 options |
| `dagyard block <node> --kind review --q '…'` | a review; without `--opt` it offers Approve / Request changes in the project's language |
| `dagyard block <node> --kind access --q '…' --label '…'` | an access; `--label` names it («Payment gateway key») |
| `dagyard wait <node> [--blocker <id>] [--timeout <sec>] [--json]` | waits for the answer (forever without `--timeout`). First line: the option (or the access value); then `note: …`. Without `--blocker`, the node's latest open blocker (or the latest answered one). Exit 2 on timeout |

`block` prints the blocker id; pass it to `wait --blocker` when the node has more than one open. A closed
node cannot get a blocker (409): a question never reopens it silently.

## Creating nodes

```bash
dagyard node add <node> --title '…' [--kind goal|request|task|stream] [--quote '…'] [--author '…'] [--from <node> [--why '…']]… [--stage <stage>] [--goal '…'] [--team '…'] [--dep <node>]… [--status <status>] [--link <url>]
dagyard goal add <node> --title '…' [--from <node> [--why '…']]… [--stage <stage>] [--goal '…'] [--team '…'] [--dep <node>]… [--status <status>] [--link <url>]
dagyard request add <node> --title '…' --quote '<the person's exact words>' [--author '…'] [--from <node> [--why '…']]… [--stage <stage>] [--goal '…'] [--team '…'] [--dep <node>]… [--status <status>] [--link <url>]
dagyard edge add <from> <to> --kind origin --why '…'
```

- Without `--kind` a node is a `task`. `goal add` = `node add --kind goal`; `request add` = `node add --kind request`.
- `--from <node>` says which node this one was born from; repeat it for several. Each `--why` belongs to
  the `--from` right before it (≤280 characters); a `--why` with no `--from` before it, or a second one for
  the same `--from`, is an error. Always give the why: it is the node's purpose in the sky.
- `--quote` (≤1000) and `--author` (≤80) are only for a request, and a request needs `--quote`.
- Without `--stage` the node goes to the project's first stage. `--dep` takes several, repeated or
  comma-separated. Statuses: `pending`, `working`, `done`.
- `edge add --kind origin` adds a «born from» link between nodes that already exist (`<to>` was born from
  `<from>`). `--why` only goes with `--kind origin`.

| Kind | What it is | `next` starts it | How it closes |
|---|---|---|---|
| `goal` | a living outcome, the root of the «whys»; starts In progress | never | `replaced`, `dropped` or `learned`, never `done` |
| `request` | a person's ask or decision, with their literal quote; starts In progress | never | any reason (`done` = fulfilled) |
| `task` | one owner, one session, one `/goal`, evidence to close | yes | any reason |
| `stream` | continuous work (tech debt, monitoring) that spawns tasks; starts In progress | never | `replaced`, `dropped` or `learned`, never `done` |

«Born from» is the purpose link: it never blocks anything, and only the owner removes one. «Needs» (`--dep`,
plain `edge add`) is the dependency: `next` only starts a task whose needs are closed (a need closed as
`replaced` follows its replacement). A node can be born from several nodes. A `goal` or `stream` can never
be the `<from>` of a «needs» edge (they never close). A node with no «born from» path to a goal is shown as
possible waste.

## Closing

```bash
dagyard node close <node> --as done --why '<evidence>' [--report <url>]
dagyard node close <node> --as replaced --by <other> --why '…'
dagyard node close <node> --as dropped --why '…'
dagyard node close <node> --as learned --why '<what we learned>'
```

- `--why` (≤500) is required for `replaced`, `dropped` and `learned`. A `task` closed as `done` needs
  evidence: `--why`, `--report`, or the report it already had. `--by` goes only with `replaced`.
- A goal or a stream never closes as `done`.
- Closing a closed node → 409. Closing with an open blocker → 409.
- Splitting: close as `replaced --by <one part>`, then `node add` the other parts `--from <node>`.
- Merging two: close one as `replaced --by <the other>`.
- Reopening: `node update <node> --status pending|working` (or `start <node>`) clears the close; the
  history keeps it.
- Closing leaves the node in the plan, in plain sight. Deleting does not exist for an agent: dropping is
  the owner's close.

## Looking around

| Command | What it does |
|---|---|
| `dagyard next [--json]` | the next task ready to start, printed as `/goal <mission>`; its sky link goes to stderr («in the sky: …»), and `--json` carries it in `link`. Exit 3 when nothing is ready |
| `dagyard open [<node>] [--print]` | the sky link to the project or to a node's card; on macOS it opens it, `--print` only prints it. Never contains the key and never calls the server |

## Factory-level (not for a single site)

| Command | What it does |
|---|---|
| `dagyard sync --github <owner/repo> [--label <l>] [--stage <stage>] [--all] [--dry-run] [--json]` | creates or moves forward the `gh-<n>` tasks from GitHub issues (needs `gh` signed in); only adds, never rewinds. «Part of #n» → task n needs this one; «depends on #n» / «blocked by #n» → this one needs n; «born from #n» → a «born from» link. The `founder-input` label opens a decision with the body's options; the `epic` label creates no task |
| `dagyard import --from <path to .cofoundy/tasks> [--project <p>] [--name '…'] [--lang en\|es] [--titles <json>] [--replace] [--dry-run] [--json]` | creates a new project from the orchestrator's tasks. An existing project is never overwritten without `--replace`; with the agent key, `--replace` keeps the owner's questions and answers. `--titles`: PM-friendly titles, `{ "node id": "title" }` inline or a `.json` path |
| `dagyard team start <site> [--name '…'] [--issues 45,46] [--at <iso date>]` | a factory site starts: its team appears on the timeline. `--issues` adds `gh-<n>` tasks to the team. Starting it again keeps the first start and reopens it if closed |
| `dagyard team close <site> --outcome <merged\|pr-open\|stopped> [--at <iso date>]` | a factory site closes, with how it ended (or a short note). Idempotent with the same outcome |
| `dagyard import-ledger [<sites.jsonl>] [--repo <repo>] [--dry-run] [--json]` | brings the factory's history in as teams, with their dates. Default file `~/cofoundy/.coordination/factory/sites.jsonl`, default repo the current folder's origin. Idempotent |

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | done |
| 1 | the server rejected the call (409, 400 `cycle`, 401…) or could not be reached: the reason is on stderr |
| 2 | `wait` timed out |
| 3 | `next`: nothing ready to start |
| 64 | malformed call (unknown option, missing value or argument) |

The key always shows as `***` on stderr.
