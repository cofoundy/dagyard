# QA del channel (#6) — 2026-10-04

Preview `https://dagyard.cofoundy-dev.workers.dev`, Claude Code 2.1.289 (Haiku 4.5), proyecto desechable
`canal-sonda` (borrado al terminar, `DELETE` → 204). La demo no se tocó.

Sesión: `claude --strict-mcp-config --mcp-config <mcp.json> --allowedTools mcp__dagyard__reply --dangerously-load-development-channels server:dagyard`
con `packages/channel/dist/dagyard-channel.mjs`. Debug log: `Channel notifications registered`.

| Paso | Medido |
|---|---|
| Decisión resuelta con el token del dueño (API) | servidor `07:56:10.999Z` → sesión `07:56:11.232Z` (**0,23 s**) |
| `reply` (pedido a la sesión) | mensaje `07:57:51Z` «Agregué Yape como opción de pago junto a tarjeta. Duda: ¿Mostramos Yape primero?» |
| Revisión aprobada **desde la UI** (agent-browser) | servidor `07:59:10.928Z` → sesión `07:59:11.118Z` (**0,19 s**) |
| `reply` **sin que nadie lo pida** | `07:59:15.626Z` «Recibí aprobación del diseño del botón Yape. Duda: …» (visible en `03-mensajes.png`) |

Código de la sonda inicial (server mínimo, Node + SDK de MCP): `sonda.mjs`.

Capturas: `01-ficha-antes.png` (revisión abierta), `02-resuelto.png` (aprobada), `03-mensajes.png` (los mensajes del canal en la ficha).

Observado una vez y no reproducido: el primer arranque dijo `server:dagyard · no MCP server configured with that name`
(`/mcp` → ✘); el relanzamiento con `--debug` conectó en 382 ms. Si pasa, relanza la sesión.
