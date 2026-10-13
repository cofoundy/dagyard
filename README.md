<h1 align="center">Dagyard</h1>

<p align="center">
  <b>Your agent factory's plan as a living sky.</b><br>
  Every task is a star. When an agent needs you, its star turns amber, you answer, and the agent keeps going.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-3a5a86?style=flat-square"></a>
  <a href="https://github.com/cofoundy/dagyard/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/cofoundy/dagyard/actions/workflows/ci.yml/badge.svg"></a>
  &nbsp;·&nbsp; <a href="README.es.md">Leer en español</a>
</p>

<p align="center">
  <img src="docs/media/hero.avif" width="880" alt="The example project «Booking marketplace»: the sky moves on its own as the teams work, you open the amber star «Commission model», pick an answer, and the star turns blue while the team picks the task back up">
</p>

Dagyard is for the person who runs a team of coding agents, usually a PM and not a developer. Tasks are
stars, dependencies are the lines between them, and stages are the constellations. You see at a glance what
stage the project is in, you only get what is yours to answer (a decision, a review, an access) and the
answer reaches the agent the moment you give it.

Under the hood it is a **real-time DAG** (a task graph) for **AI coding agents**: agents running in
**Claude Code** or any terminal report tasks, progress and questions through a small CLI, the plan updates live
over WebSocket, and the human-in-the-loop answer travels back to the agent. It ships as a **Claude Code
plugin** (a status band, a `/dagyard` menu and an optional MCP channel) and self-hosts on Cloudflare Workers.

## What you get

### The whole plan, in one look

<img src="docs/media/sky.avif" width="880" alt="The overview of «Booking marketplace»: five stages from Discovery to Launch, finished tasks in white, tasks in progress in blue and three amber tasks waiting for you">

White stars are done, blue ones are being worked on, amber ones are waiting for you. The rail at the bottom
says how far each stage is, and the header says where the project is now.

### Answer from the card

<img src="docs/media/decision.avif" width="880" alt="The card of «Commission model» open next to its star: the Design team asks who should pay the commission, with two options to pick from">

Click a star and its card opens: who is on it, what they said, what it needs and what it unlocks. When the
team asked you something, the question and its options are right there. A decision is one click, a review is
approve or ask for changes, and an access is pasted once and stored encrypted.

### It moves while you watch

<img src="docs/media/realtime.avif" width="880" alt="An agent runs «dagyard block» from its terminal and right away the star «Mobile speed check» turns amber and the counter goes from 3 to 4 waiting for you">

Agents move their own tasks with the `dagyard` CLI: start, progress, short messages, a question for you,
done. Every change shows up in the sky right away, for everyone looking at it.

### In Claude Code, too

<img src="docs/media/claude-code-band.png" width="880" alt="Claude Code with the Dagyard band above the prompt: the project's progress, what waits for you and the options of the first decision">

<img src="docs/media/claude-code-menu.png" width="880" alt="The /dagyard menu in Claude Code: the three things that need you, a decision, a review and an access, each with its buttons">

The mod puts a band above the prompt with what waits for you, and `/dagyard` opens everything at once. You
answer from the terminal and the sky updates. Access values are never typed here: they are given in the sky.

### The tab tells you

<img src="docs/media/tab-notice.avif" width="880" alt="A browser tab titled «(3) Dagyard» with an amber dot on its icon, next to another tab">

The browser tab counts what waits for you and its icon lights up, so you can leave Dagyard open and do
something else. «Notify me» also lets the browser alert you when something new needs you, even from another tab.

## How it works

<img src="docs/media/how-it-works.svg" width="880" alt="Your coding agents talk to Dagyard through the CLI and send tasks, progress and questions; Dagyard shows you what waits for you in the sky and in Claude Code; your decisions, reviews and accesses go back to the agents in real time">

Dagyard is a single Cloudflare Worker: a REST API and a WebSocket, with each project's state in a Durable
Object. Agents use the CLI (or the MCP channel, which pushes your answers into a Claude Code session). You use
the web app or the Claude Code mod. Everything speaks the same API, so what you do in one place appears in
the others at once.

## Quickstart

Requires Node ≥ 22 and pnpm 10.

**1. Try it in 30 seconds, no server.** The example project lives in memory:

```bash
pnpm install
pnpm --filter @dagyard/web dev:fixture
```

**2. Deploy your own.** With a Cloudflare account and `wrangler` logged in:

```bash
pnpm install && pnpm build
cd apps/worker
npx wrangler secret put OWNER_TOKEN    # any long random string; also AGENT_KEY and VAULT_KEY
npx wrangler deploy --var VERSION:$(git rev-parse --short HEAD)
```

Open the URL wrangler prints and sign in with `OWNER_TOKEN`. To load the example project, put the same token
in `~/.config/dagyard/owner-token` (chmod 600) and run `node apps/worker/scripts/seed.mjs <your-url>`.

**3. Connect your agents.** They use `AGENT_KEY`:

```bash
pnpm --filter @dagyard/cli build
export DAGYARD_URL=<your-url> DAGYARD_KEY=<AGENT_KEY> DAGYARD_PROJECT=booking-marketplace
node packages/cli/dist/dagyard.mjs next      # the next task an agent can start
node packages/cli/dist/dagyard.mjs --help
```

A repo can commit a `.dagyard.json` (`{"project": "…", "url": "…"}`) so its agents need no flags. Details in
[`packages/cli/README.md`](packages/cli/README.md).

**4. Add Dagyard to Claude Code** (one step, no clone needed):

```bash
claude plugin marketplace add cofoundy/dagyard && claude plugin install dagyard@dagyard
```

It brings the band, the `/dagyard` menu, the `dagyard` CLI on your agents' PATH and the `dagyard:protocol` skill that teaches any agent to work in plain sight. From a clone, use
`claude plugin marketplace add "$PWD"` instead. The optional channel: [`packages/mod/README.md`](packages/mod/README.md).

The interface, the CLI and the mod speak English by default and Spanish when your system is in Spanish.

<details>
<summary><b>Run the full stack locally</b></summary>

```bash
pnpm install && pnpm build

# 1. Three secrets for the Worker (any long random strings), never committed
cat > apps/worker/.dev.vars <<EOF
OWNER_TOKEN=$(openssl rand -hex 32)
AGENT_KEY=$(openssl rand -hex 32)
VAULT_KEY=$(openssl rand -hex 32)
EOF

# 2. The Worker (API + built UI) on http://127.0.0.1:8787
pnpm --filter @dagyard/worker dev

# 3. Optional, in another terminal: the UI with hot reload, proxied to the Worker
pnpm --filter @dagyard/web dev
```

Sign in with `OWNER_TOKEN` and seed the example with `node apps/worker/scripts/seed.mjs http://127.0.0.1:8787`.
`GET /api/health` answers with the running `version`.

</details>

<details>
<summary><b>What's inside</b></summary>

| Path | What it is |
|---|---|
| `apps/worker` | Cloudflare Worker: REST API + WebSocket, state in Durable Objects with SQLite, serves the UI |
| `apps/web` | Vite + React + three.js: the 3D sky, the task card, the stage rail |
| `packages/model` | Shared types, validation, graph helpers and the example project |
| `packages/cli` | `dagyard`: the CLI agents use to move their tasks, open blockers and wait for answers |
| `packages/channel` | MCP server that Claude Code loads as a *channel*: pushes your answers into the agent's session (plugin `dagyard-channel` in `plugin/`) |
| `packages/mod` | Claude Code plugin `dagyard`: the band over the prompt, the `/dagyard` menu and the CLI in `bin/` |
| `docs/` | API contract (`docs/api.md`), v0 spec and the README media (`docs/media/`, the only folder with images) |

</details>

## Development

```bash
pnpm typecheck && pnpm test && pnpm build   # the same three gates CI runs
```

See [CONTRIBUTING.md](CONTRIBUTING.md). The media in this README is recorded from the example project with
`docs/media/capture/` (see its README).

## Status

v0, built in the open by Cofoundy's own agent factory, which uses Dagyard to plan Dagyard
([`docs/dogfooding.md`](docs/dogfooding.md)). One owner per deployment; multi-tenant is out of scope for v0.

## License

MIT, see [LICENSE](LICENSE).
