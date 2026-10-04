# dagyard CLI: command reference

Shape of every call: `dagyard <command> [<args>] [<options>]`. Command first, options after, the binary
spelled out on each call (no shell variables). `dagyard <command> --help` is the ground truth for the
installed version.

Common options, accepted on any command (after it): `--project <p>`, `--url <url>`, `-h/--help`. Inside a
repo with `.dagyard.json` neither is needed. Precedence: `--project/--url` > `DAGYARD_PROJECT/DAGYARD_URL`
> `.dagyard.json` (the first one walking up from the current folder, never past the repo root or `$HOME`)
> `~/.config/dagyard/{project,url}`. The key comes only from `DAGYARD_KEY` or `~/.config/dagyard/agent-key`.

Node ids are short slugs: `T-314-A` is stored as `t-314-a`.

## Moving a node (available today)

| Command | What it does |
|---|---|
| `dagyard start <node> [--team '…']` | In progress (shortcut of `node start`). `--team` is optional: the human name of the site or session, so the sky shows who carries it |
| `dagyard progress <node> <p>` | progress as `0..1` or `40%` (shortcut of `node progress`) |
| `dagyard msg <node> '…' [--report <url>] [--from '…']` | a note for the PM, ≤280 characters. The server fills `--from` with the team name |
| `dagyard done <node> [--report <url>]` | Done (shortcut of `node done`). Fails with an open blocker. After #90 prefer `node close --as done` |
| `dagyard node update <node> [--title] [--stage] [--goal] [--team] [--status] [--progress] [--report] [--link]` | changes fields. Never set `--status blocked`: only `block` does |
| `dagyard edge add <from> <to>` | dependency: `<to>` needs `<from>` closed. Rejected if it closes a loop |

## Asking a person (available today)

| Command | What it does |
|---|---|
| `dagyard block <node> --kind decision --q '…' --opt '…' [--opt '…']…` | a decision, 1 to 6 options |
| `dagyard block <node> --kind review --q '…'` | a review; without `--opt` it offers Approve / Request changes in the project's language |
| `dagyard block <node> --kind access --q '…' --label '…'` | an access; `--label` names it («Payment gateway key») |
| `dagyard wait <node> [--blocker <id>] [--timeout <sec>] [--json]` | waits for the answer. First line: the option (or the access value); then `note: …`. Without `--blocker`, the node's latest open blocker. Exit 2 on timeout |

`block` prints the blocker id; pass it to `wait --blocker` when the node has more than one open.

## Creating nodes

Available today (older model, no purpose link):

```bash
dagyard node add <node> --title '…' --stage <stage> [--goal '…'] [--team '…'] [--dep <node>]… [--status pending|working|done] [--link <url>]
```

**Needs #90** (the DAG model, decision D12). Each prints only the new id:

```bash
dagyard node add <node> --title '…' [--kind goal|request|task|stream] [--from <node> --why '…']… [--quote '…'] [--author '…'] [--stage <stage>]
dagyard goal add <node> --title '…'
dagyard request add <node> --title '…' --quote '<the person's exact words>' [--author '…'] [--from <node>]
dagyard edge add <from> <to> --kind origin --why '…'
```

| Kind | What it is | `next` starts it | How it closes |
|---|---|---|---|
| `goal` | a living outcome, the root of the «whys» | never | `replaced`, `dropped` or `learned`, never `done` |
| `request` | a person's ask or decision, with their literal quote | never | any reason (`done` = fulfilled) |
| `task` | one owner, one session, one `/goal`, evidence to close | yes | any reason |
| `stream` | continuous work (tech debt, monitoring) that spawns tasks | never | `replaced`, `dropped` or `learned`, never `done` |

«Born from» (`--from … --why …`, or `edge add --kind origin`) is the purpose link: it never blocks
anything. «Needs» (`--dep`, plain `edge add`) is the dependency: `next` only starts a task whose needs are
closed (a need closed as `replaced` follows `replacedBy`). A node can be born from several nodes. A
`goal` or `stream` can never be the `<from>` of a «needs» edge (they never close).

## Closing (needs #90)

```bash
dagyard node close <node> --as done --why '<evidence>'
dagyard node close <node> --as replaced --by <other> --why '…'
dagyard node close <node> --as dropped --why '…'
dagyard node close <node> --as learned --why '<what we learned>'
```

- `--why` is required for `replaced`, `dropped` and `learned`; a `task` closed as `done` needs evidence
  (`--why`, or the report it already has).
- Closing a closed node → 409. Closing with an open blocker → 409.
- Splitting: close as `replaced --by <one part>`, then `node add` the other parts `--from <node>`.
- Merging two: close one as `replaced --by <the other>`.
- Reopening (`node update --status pending|working`) clears the close; the log keeps it.

## Looking around

| Command | What it does |
|---|---|
| `dagyard next [--json]` | the next task ready to start, printed as `/goal <mission>`; its sky link goes to stderr. Exit 3 when nothing is ready |
| `dagyard open [<node>] [--print]` | the sky link to the project or to a node's card; on macOS it opens it. Never contains the key |

## Factory-level (not for a single site)

| Command | What it does |
|---|---|
| `dagyard sync --github <owner/repo> [--label] [--stage] [--all] [--dry-run]` | creates or moves forward the `gh-<n>` nodes from GitHub issues; only adds, never rewinds. After #90, «born from #n» in an issue body becomes a «born from» link |
| `dagyard import --from <.cofoundy/tasks> [--project] [--name] [--lang en\|es] [--replace] [--dry-run]` | creates a project from the orchestrator's tasks |

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | done |
| 2 | `wait` timed out |
| 3 | `next`: nothing ready to start |
| other | error on stderr (the key always shows as `***`) |
