# `dagyard-channel` — el channel de Claude Code para Dagyard

Un server MCP por stdio (`dist/dagyard-channel.mjs`, Node ≥22, un solo archivo con el SDK de MCP
adentro) que Claude Code carga como *channel* (capability `claude/channel`, research preview):

- Escucha el tiempo real del proyecto y, cuando el dueño resuelve un bloqueante de uno de tus nodos,
  lo empuja a la sesión como `notifications/claude/channel`. Llega como
  `<channel source="dagyard" project="…" node="…" blocker="…" kind="…">` con la pregunta, la elección,
  la nota y qué hacer. Un `access` nunca trae el valor: el texto dice que corras
  `dagyard wait <nodo> --blocker <id>` para recibirlo.
- Expone la tool `reply` (D6): `node`, `hice`, `duda?`, `reporte?` (URL). Compone un mensaje ≤280
  caracteres y lo publica en el nodo (`POST …/nodes/:nid/messages`, con `reportUrl`).

```bash
pnpm install && pnpm build   # desde la raíz del repo
```

## Config

La misma que el CLI: `DAGYARD_URL`, `DAGYARD_KEY` (la API key del agente), `DAGYARD_PROJECT`; si faltan,
`~/.config/dagyard/{url,agent-key,project}`. Opcional `DAGYARD_NODES=pagos,login` para escuchar solo
esos nodos (sin él, todos los del proyecto). Los logs van a stderr y la key sale como `***`.

## Como plugin (lo recomendado)

`plugin/` es el plugin `dagyard-channel` del marketplace del repo: su `bin/dagyard-channel.mjs` es este
bundle, commiteado (lo regenera `node scripts/plugin-bundle.mjs` desde la raíz; el CI lo verifica con
`--check`). Instalarlo es el opt-in, y se activa por sesión:

```bash
claude plugin marketplace add cofoundy/dagyard   # o "$PWD" desde la raíz de un clon
claude plugin install dagyard-channel@dagyard
claude --dangerously-load-development-channels plugin:dagyard-channel@dagyard
```

El server se llama `dagyard`, así que los eventos siguen llegando como `<channel source="dagyard" …>`.

## Registrarlo a mano en un proyecto

En el `.mcp.json` **del proyecto** donde trabaja el agente (nunca en `~/.mcp.json`: cada MCP global
se paga en cada sesión abierta). La key no va en el archivo: sale de `~/.config/dagyard/agent-key`.

```json
{
  "mcpServers": {
    "dagyard": {
      "command": "node",
      "args": ["/ruta/a/dagyard/packages/channel/dist/dagyard-channel.mjs"],
      "env": {
        "DAGYARD_URL": "https://dagyard.cofoundy-dev.workers.dev",
        "DAGYARD_PROJECT": "<proyecto>",
        "DAGYARD_NODES": "<nodo>"
      }
    }
  }
}
```

Y se lanza la sesión con el channel cargado (el nombre es la clave de `mcpServers`):

```bash
claude --dangerously-load-development-channels server:dagyard
```

Los eventos aparecen como `← dagyard: …` en unos segundos. Las `instructions` del server solas no
bastan para que el modelo actúe (medido en la sonda de T-canal): por eso cada evento dice qué hacer.

## Cómo funciona

`src/live.ts`: `GET /api/projects/:pid` → `seq`; WebSocket a `/api/projects/:pid/live?since=<seq>` con
el subprotocolo `['dagyard', 'token.<key>']` (el token no queda en la URL). Reconecta con backoff
(1 s → 30 s) reanudando desde el último `seq` visto; ante `resync` salta al `seq` del snapshot, así no
reemite resoluciones viejas. `ping` cada 25 s; sin respuesta en 2,5 intervalos, reconecta.
`src/notify.ts` decide qué evento se avisa (solo `blocker.resolved` con actor `owner`, de nodos
filtrados) y redacta el texto. Las rutas REST y la config salen del CLI (`packages/cli/src/api.ts`,
`config.ts`), que siguen siendo la única fuente.
