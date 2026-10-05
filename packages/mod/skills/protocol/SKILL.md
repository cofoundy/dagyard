---
name: protocol
description: This skill should be used when working in a repo that has a `.dagyard.json`, when a kickoff names a Dagyard node (such as `gh-91`), or when the user asks to "start your node", "leave a message on Dagyard", "report progress to Dagyard", "ask the owner a decision", "block on a decision", "wait for the answer", "close the task", "close it as replaced", "drop the node", "reopen the node", "create the nodes for your lanes", "record what the owner asked", "add a goal", or mentions the dagyard CLI, the sky or the factory's DAG. It teaches the protocol an agent follows to keep its work visible in Dagyard.
version: 0.2.0
---

# Dagyard: keep the plan alive while working

Dagyard is the factory's plan as a live DAG. People (PMs, the owner) watch it in the browser, «the sky»,
and answer there what is theirs. Agents move their own nodes with the `dagyard` CLI while they work, so
every change shows up in the sky within seconds. This skill is the protocol for doing that well.

## How to call the CLI (read this first)

The plugin puts `dagyard` on the PATH of every shell command. If `command -v dagyard` finds nothing,
call `${CLAUDE_PLUGIN_ROOT}/bin/dagyard` with the same arguments.

Two rules that broke real runs before; follow them every time:

1. **Command first, options after:** `dagyard msg gh-91 'Ready to review' --report <url>`. Only
   `--project`/`-p` and `--url` are also accepted before the command; any other option there fails.
2. **Spell out the binary on every call.** Never store it in a shell variable (`DY="dagyard --project x"`
   then `$DY msg …`): zsh does not split the variable into words and the call fails. Quote free text with
   single quotes so `$`, `!` and backticks stay literal.

Inside a repo with a `.dagyard.json` the project and server come from that file: no `--project` or
`--url` needed. The API key comes from `~/.config/dagyard/agent-key` (or `DAGYARD_KEY`); never print it,
never put it in a commit, a message or a file.

## Which node is mine

- A kickoff or issue names it: in the `dagyard` repo, issue `#n` is node `gh-<n>`.
- Otherwise, `dagyard next` prints the next task ready to start as `/goal …` (exit 3 when none is ready).
- If the work has no node yet, create one **born from** the node or goal it serves, with the reason:

  ```bash
  dagyard node add pay-retry --title 'Retry failed payments' --from payments --why 'Cards fail at night and nobody retries'
  ```

  Every task exists to serve another node or a goal. A node with no path to a goal is shown as possible
  waste, so always pass `--from` with its `--why`. Each `--why` belongs to the `--from` right before it
  (≤280 characters); repeat the pair when a node serves several (`--from a --why '…' --from b --why '…'`).
  Without `--kind` the node is a `task`; without `--stage` it goes to the project's first stage. Creation
  commands print only the new id.

One node = one owner, one session, one `/goal`. The agent's internal steps (read the code, write a test)
are not nodes.

## The lifecycle

| Moment | Command |
|---|---|
| Start working | `dagyard start <node> [--team '<site or session name>'] [--site <site>]` |
| Each milestone (PR opened, merged, deployed) | `dagyard msg <node> '<≤280 chars for a PM>' --report <url>` and `dagyard progress <node> <0..1>` |
| Something only a person can decide | `dagyard block <node> --kind decision --q '<question>' --opt '<A>' --opt '<B>'` |
| Cannot go on without that answer | `dagyard wait <node>` (exit 2 on timeout: call it again) |
| Work splits into lanes other sessions own | `dagyard node add <lane> --title '…' --from <node> --why '…'` per lane |
| A lane must finish before another starts | `dagyard edge add <from> <to>` (`<to>` needs `<from>` closed) |
| A person asked for something in chat | `dagyard request add <id> --title '…' --quote '<their exact words>' --author '<name>'` |
| The owner names a new long-lived outcome | `dagyard goal add <id> --title '…'` |
| Finished, with evidence | `dagyard node close <node> --as done --why '<what proves it>' [--report <url>]` |
| Superseded by another node | `dagyard node close <node> --as replaced --by <other> --why '…'` |
| Abandoned | `dagyard node close <node> --as dropped --why '…'` |
| Turned out to be a question, now answered | `dagyard node close <node> --as learned --why '<what we learned>'` |
| A closed node needs work again | `dagyard node update <node> --status working` (or `pending`), then a `msg` saying why |

`dagyard done <node> --report <url>` still works: it is the older shortcut and closes as `done` without
asking for a reason. Prefer `node close --as done --why`, so the sky shows what proves it.

### Starting and leaving a message

The minimal correct session start, for node `gh-91`:

```bash
dagyard start gh-91 --team 'Plugin'
dagyard msg gh-91 'Started: Dagyard installs in Claude Code in one step'
```

- `--team` is the human name of the site or session, so the sky shows who carries the task.
- `--site <slug>` (or `$COFOUNDY_AGENT`, which a factory site already has) puts the task in that site's
  team on the timeline; the server creates the team if it does not exist yet. Inside a factory site,
  plain `dagyard start <node>` is enough.

### Writing for the PM

A `msg` is read by a product person, not an engineer:

- What changed for them, in one or two sentences, ≤280 characters.
- No branch names, file paths, PR numbers or stack traces. Put the PR or the report URL in `--report`
  instead; the first report that arrives becomes the node's report.
- Write in the language of whoever gave the work (the kickoff or the request). The sky shows the text as
  is: a person's words are never translated.

### Goals and requests: the roots of the whys

- A **goal** is a living outcome («Agents report without being asked»). It starts In progress, `next` never
  offers it, and it never closes as `done`: it ends `replaced`, `dropped` or `learned`. Add one only when
  the owner or the kickoff names a new outcome; otherwise hang your work from the goal that already exists.
- A **request** is what a person asked, in their own words. When the owner asks for something in chat,
  record it before doing it, then make the work born from it:

  ```bash
  dagyard request add ask-retry --title 'Retry failed payments' --quote 'que los cobros que fallan se reintenten solos' --author 'André' --from payments --why 'Part of getting paid on time'
  dagyard node add pay-retry --title 'Retry failed payments' --from ask-retry --why 'What André asked'
  ```

  `--quote` is required and literal (≤1000 characters, never translated or tidied up); `--author` is who
  said it. A request closes with any reason: `done` means it was fulfilled.
- A **stream** (`node add --kind stream`) is continuous work, such as tech debt or monitoring, that spawns
  tasks; like a goal, it never closes as `done`.

«Born from» (`--from`, or `edge add <from> <to> --kind origin --why '…'` for nodes that already exist) is the
purpose link: it never blocks anything. «Needs» (`--dep <node>` on `node add`, or plain `edge add`) is the
dependency: `next` only starts a task whose needs are closed. A goal or a stream can never be the one
needed (they never close).

### Blockers: what is a person's

A person's call is one of three kinds: `decision` (pick an option), `review` (approve or request
changes) and `access` (a credential or permission). Open it as a blocker on the node, not as an issue or
a chat message: the person answers in the sky.

- Keep working on everything else after `block`. Call `dagyard wait <node>` only when nothing else can
  move. It prints the chosen option on the first line and `note: …` after it if there is one.
- For `access`, the answer is the secret itself: use it, never echo it into a message, a commit or a log.
- An agent never resolves a blocker, not even its own.

### Closing with a reason

Branches die in plain sight, never silently. Close every node with what happened:

- `done` needs evidence: the `--why` says what proves it (the test, the deploy, the URL that works), or
  `--report` points to it.
- `replaced --by <node>`: the work continues in another node. To split a node, close it as replaced by
  one of the parts and create the others `--from` it. To merge two, close one as replaced by the other.
- `dropped`: no longer worth doing, and why.
- `learned`: it was a question; the `--why` is the answer.

`--why` is required for `replaced`, `dropped` and `learned` (≤500 characters). Closing can leave
continuations: new nodes created `--from` the closed one, each with its `--why`. A node with an open
blocker cannot be closed (409): get the answer first. Closing a closed node is also a 409; reopen it first
(`node update --status working`). Reopening clears the close; the history keeps it.

## Rules that are not negotiable

- Never resolve a blocker; never delete a node (nothing is deleted: dropping is an owner's close).
- `blocked` is set only by `dagyard block`; never set it with `node update`.
- Removing a «born from» link is the owner's: an agent only adds them.
- Report facts in `msg`, never permissions or promises on someone else's behalf.

## Exit codes worth handling

| Command | Exit | Meaning |
|---|---|---|
| `dagyard wait` | 2 | timed out: call it again (or keep working) |
| `dagyard next` | 3 | nothing ready to start |
| any | 64 | the call is malformed (unknown option, missing value): fix it, do not retry as is |
| any | 1 | the server said no (409 closed or blocked, 400 cycle…) or could not be reached: the reason is on stderr, the key shows as `***` |

## Additional resources

- **`references/commands.md`**: every command with its options, output and examples, including
  `edge add --kind origin`, `sync`, `import`, `open` and the factory commands (`team start/close`,
  `import-ledger`).
- `dagyard <command> --help` is always the ground truth for the installed CLI.
