# `dagyard` — el CLI de los agentes

Un solo archivo (`dist/dagyard.mjs`, Node ≥22, sin dependencias en runtime) sobre la API REST.

```bash
pnpm install && pnpm build
node dist/dagyard.mjs --help
```

## Config

Proyecto y servidor, en este orden: la flag (`--project`/`-p`, `--url`, antes o después del comando:
`dagyard --project p --url u node start x` vale) > `DAGYARD_PROJECT` / `DAGYARD_URL` > `.dagyard.json` >
`~/.config/dagyard/{project,url}`.

`.dagyard.json` va en la raíz del repo y se commitea; el CLI usa el primero que encuentra subiendo desde la
carpeta actual, sin pasar de la raíz del repo (el primer `.git`, carpeta o archivo) ni de `$HOME`. Así un
agente en cualquier repo sabe a qué proyecto de Dagyard pertenece:

```json
{ "project": "dagyard", "url": "https://dagyard.cofoundy-dev.workers.dev" }
```

Como el archivo viene con el repo, su `url` recibe la key solo si es https y su origen es de confianza:
`https://dagyard.cofoundy-dev.workers.dev`, `https://dagyard.run`, el de `DAGYARD_URL` o
`~/.config/dagyard/url`, o una línea de `~/.config/dagyard/trusted-urls`. Si no, el CLI la ignora con un aviso
en stderr y sigue con lo demás. Si no es JSON válido, el CLI lo dice con la ruta del archivo. **La key nunca sale de ahí** (aunque la
pongas, se ignora): solo de `DAGYARD_KEY` o `~/.config/dagyard/agent-key`, y nunca se imprime (los errores
la tapan con `***`).

| Comando | Qué hace |
|---|---|
| `node add\|update\|start\|progress\|done`, `edge add` | mutan el DAG (`start`, `progress`, `done` también como atajo). `node add\|update --link <url>` cuelga el issue o el PR: la ficha lo muestra como «Detalle técnico ↗» |
| `node close`, `goal add`, `request add` | #90: `node close <n> --as done\|replaced\|dropped\|learned --why …` cierra con motivo (nunca se borra un nodo); `goal add` y `request add --quote …` son atajos de `node add --kind`. `node add --from <n> --why …` dice de qué nació; `edge add <a> <b> --kind origin` también |
| `node add\|goal add\|request add\|edge add … --if-absent` | #110: «agregar si no existe», para re-correr sin duplicar ni fallar. Si el id (o la arista) ya existe, no escribe nada, imprime `<id> exists` (o `<de> → <a> exists`) y sale 0. Solo el 409 que el servidor marca `reason: "exists"` cuenta como «ya existe»: cualquier otro 409 (un bloqueante abierto, el tope de un equipo) sigue saliendo 1. La marca `exists` no se traduce. Sin el flag, un duplicado sigue siendo `conflict` y exit 1 |
| `block <nodo> --kind decision\|review\|access --q "…" [--opt …]` | abre un bloqueante e imprime su id |
| `wait <nodo> [--blocker <id>] [--timeout <seg>]` | long-poll hasta que el humano resuelve; imprime la elección o el valor. Un long-poll que falla por la red, un 5xx o un 429 se reintenta con backoff (1 s → 10 s) sin pasar el plazo; un 4xx corta con exit 1 (#94) |
| `msg <nodo> "…" [--report <url>]` | mensaje ≤280 caracteres |
| `next` | `/goal …` en una sola línea (exit 3 si no hay nada arrancable); el link de la tarea va por stderr (`en el cielo: …`) y en `--json` como `link` |
| `open [<tarea>] [--print]` | imprime el link del cielo al proyecto (`<url>/?p=<proyecto>`) o a la tarea (`&n=<tarea>`, abre su ficha) y en macOS lo abre; `--print` solo lo imprime. No usa la key |
| `sync --github <owner/repo> [--label <l>] [--stage <etapa>] [--all] [--dry-run] [--json]` | crea o actualiza las tareas `gh-<n>` desde los issues (ver abajo) |
| `import --from <.cofoundy/tasks> [--lang en\|es] [--replace] [--dry-run]` | crea el proyecto desde las tareas del orchestrator; si ya existe, falla (`PUT` con `If-None-Match: *`) salvo `--replace` (`PUT` del grafo entero; con la clave de agente conserva las preguntas y respuestas del dueño y da 409 si quita una tarea que tiene alguna, con el token del dueño las recrea desde el archivo) |

Exit codes: 0 ok · 1 API o red · 2 `wait` venció · 3 `next` vacío · 64 uso.

## Idioma

Los mensajes para personas (ayuda, errores, resultados, avisos) salen en inglés; en español si el
entorno lo pide: `LC_ALL` > `LC_MESSAGES` > `LANG`, manda el primero no vacío y `es`/`es_*`/`es-*` es
español (`C`, `POSIX` o nada → inglés). Comandos, flags, JSON y exit codes no cambian con el idioma.

Lo que el CLI escribe en un proyecto (etapas y misiones del import, opciones por defecto de `block --kind
review` y de `sync`) va en el idioma **del proyecto** (`project.lang`, #77), nunca en el de `LANG`: un mismo
proyecto no mezcla idiomas según quién lo toque. Un proyecto nuevo es `en` salvo `import --lang es`; un
proyecto guardado sin el campo (como `dagyard`) es `es`. Las tablas viven en `src/defaults.ts`.

## Contrato REST

`docs/api.md` (tipos y validación de `@dagyard/model`, que esbuild mete en el bundle). Las rutas viven
solo en `src/api.ts` (`ROUTES`). `wait` sin `--blocker` lee el snapshot del proyecto y espera el último
bloqueante abierto del nodo en `GET /api/projects/:p/blockers/:b/wait`. `import` valida el grafo con
`parseProjectGraphInput` antes de enviarlo (también en `--dry-run`).

## Import tolerante

`src/tasks/parse.ts` lee front matter, un bloque ```yaml y la cabecera del cuerpo (antes del primer
`## `). `deps ∪ blockedBy`, solo ids que existen en el directorio; `—`, `none` o `[]` al inicio = sin
dependencias, y lo que va entre paréntesis se ignora. `blocked` que espera a otra tarea queda
Pendiente; solo es «Te espera» si no espera a nadie o si el status nombra a un humano. Etapas por
`phase` si todas la traen; si no, por profundidad con nombre humano: «Getting started», «Next», «Then»…
y «Finally», o «Para empezar», «Después», «Luego»… y «Al final» en un proyecto en español (máximo 12, lo
que acepta el modelo; nunca «Etapa N»). Sin `--lang`, un import nuevo es `en` y `--replace` conserva el
idioma del proyecto que reemplaza.
Los títulos visibles pasan por `legibleTitle` (D10, #21): sin `T-xxx` ni `#123`, sin prefijos de
ruta, archivo o código (`lib/x.ts —`, `SEC —`, `P0.1`), sin nombres de archivo (`verify.sh` →
`verify`), sin paréntesis (notas y llamadas: `var()` → `var`) y sin MAYÚSCULAS enfáticas (las
siglas como MCP o CI se quedan). Si el título es `role: x`, se usa la primera frase del `**Issue:**`.

## `sync --github`

Lleva la cola de issues al grafo con la API granular (`GET` del snapshot + `POST` nodo, `PATCH`, `POST`
arista, `POST` bloqueante), **nunca `PUT`**: no toca el resto del grafo y cada cambio llega en vivo. Lee
GitHub con `gh api --paginate` (necesita `gh` autenticado); los PRs del listado no cuentan como issues.

- **Tarea `gh-<n>` nueva:** solo issues abiertos (con `--all`, también los cerrados como completados, ya
  Listos; los cerrados como `not_planned` nunca; los de la etiqueta `epic` tampoco). Título = el del issue
  sin el prefijo `algo: `, sin referencias (`desde #35`) y pasado por `legibleTitle` del import; etapa `--stage`, o la de construcción («Build» / «Construcción») si existe, o la primera; `--stage` acepta id o
  nombre en cualquiera de los dos idiomas (`build` encuentra «Construcción») y sync nunca crea una etapa;
  enlace = la URL del issue.
- **Tarea que ya existe:** nunca le cambia título, etapa, equipo ni misión (los cura la fábrica); el
  enlace, solo si no tiene. Si su enlace es de otro issue (otro repo u otro número; su PR en este repo sí
  vale), la salta con un aviso.
- **El estado solo avanza:** cerrado como completado → Lista (como duplicado o no planeado, no); abierto con un PR abierto que dice `closes|fixes|resolves|cierra|resuelve #n`
  (título o cuerpo, sin distinguir mayúsculas) y tarea Pendiente → En progreso. Una tarea con una pregunta
  abierta no cambia de estado: aviso, no error.
- **Aristas** (solo si las dos tareas existen; nunca borra): «Parte de #n» → la épica `gh-n` necesita esta;
  «depende de #n», «blocked by #n» o «bloqueado por #n» → esta necesita `gh-n`. Repetida o con ciclo → aviso.
- **`founder-input`** → decisión para el dueño: la pregunta es el título y las opciones salen de las líneas
  `- **A (…):** texto`, `- **A:** texto` o `- A) texto` del cuerpo (máx. 6; sin ninguna, «Yes» / «No» o «Sí» / «No»
  según el idioma del proyecto). Solo
  si la tarea no tiene ya una decisión, abierta o respondida y con el texto que sea (contrato #31).

Salida: `Sincronicé N issues: X nuevas · Y actualizadas · Z sin cambios` y los avisos. Correrlo dos veces
seguidas da `0 nuevas · 0 actualizadas` la segunda. `--dry-run` lee y cuenta sin escribir; `--json` da el
reporte completo.
