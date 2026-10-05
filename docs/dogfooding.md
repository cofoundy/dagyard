# Dogfooding: Dagyard se construye con su propio grafo

El proyecto **«Dagyard»** (`dagyard` en `https://dagyard.cofoundy-dev.workers.dev`) es el plan de este
repo: cada feature es un nodo, y la fábrica y sus sitios lo mueven con el CLI mientras trabajan. André
lo mira en la URL y contesta ahí lo que es suyo. Épica: #44.

## Las piezas

| Pieza | Qué es |
|---|---|
| Nodo `gh-<n>` | la tarea del issue `#n` de `cofoundy/dagyard`. Los nodos sin issue (`intencion`, `spec`, `v1`…) los cura la fábrica a mano |
| Tipos de nodo (#90) | `task` (un dueño, una sesión, un `/goal`; la única que arranca), `goal` (un objetivo vivo), `request` (un pedido de André con su cita literal) y `stream` (trabajo continuo). Toda tarea nace de algo: una arista «nació de» la cuelga de su pedido, su objetivo o la tarea que la hizo surgir. Sin camino a un objetivo, es posible desperdicio. Contrato: `docs/spec/modelo.md` |
| `.dagyard.json` | en la raíz del repo: `{"project": "dagyard", "url": "…"}`. El CLI lo busca subiendo desde el cwd, así que dentro del repo (o de cualquier worktree suyo) no hace falta `--project` ni `DAGYARD_URL` |
| API key | `~/.config/dagyard/agent-key` (o `DAGYARD_KEY`). Nunca va en `.dagyard.json`, en un commit ni en un mensaje |
| URL de confianza | la key viaja a la `url` de `.dagyard.json` solo si es https y su origen es de confianza: la preview, `https://dagyard.run`, el de `DAGYARD_URL`/`~/.config/dagyard/url` o una línea de `~/.config/dagyard/trusted-urls`. Si no, el CLI la ignora y avisa. La búsqueda sube hasta la raíz del repo (el primer `.git`) o `$HOME`, nunca más arriba: un `.dagyard.json` plantado en `/tmp` no te roba la key |
| Precedencia | `--project`/`--url` > `DAGYARD_PROJECT`/`DAGYARD_URL` > `.dagyard.json` > `~/.config/dagyard/{project,url}` |
| `dagyard sync --github cofoundy/dagyard` | lo corre la fábrica: crea o actualiza los nodos `gh-<n>` desde la cola de issues (abajo) |
| `dagyard open [gh-<n>]` | el link al proyecto (`/?p=dagyard`) o a la ficha de la tarea (`&n=gh-<n>`), para mandárselo a André; en macOS lo abre (`--print` solo lo imprime). `next` también trae el link de la tarea |

## El protocolo de un sitio

Un sitio es una sesión de `/cto` que lleva un issue. Su nodo es `gh-<issue>`. Compila el CLI una vez por
worktree y llama siempre al binario completo (en zsh una variable `DY="node … --project …"` no se parte
en palabras, y las opciones globales antes del comando solo funcionan desde #45):

```bash
pnpm install && pnpm --filter @dagyard/cli build
node packages/cli/dist/dagyard.mjs <comando> …     # el proyecto y la URL salen de .dagyard.json
```

| Momento | Comando | Nota |
|---|---|---|
| Al arrancar | `node start gh-<n> --team <Nombre>` | el nodo pasa a «En progreso». `--team` es el nombre humano del sitio (`Dogfood`, `Avisos`) |
| Cada hito (PR abierto, merge, deploy) | `msg gh-<n> '<≤280, lenguaje de producto>' --report <url>` y `node progress gh-<n> <0..1>` | el mensaje lo lee un PM: qué cambió para él, sin ramas, archivos ni números de PR. `--report` cuelga el PR o el informe de Basalt; el primero que llega queda como informe del nodo |
| Algo que es de André | `block gh-<n> --kind decision --q '<pregunta>' --opt '<A>' --opt '<B>'` | **no** abras un issue `founder-input` para eso: la pregunta vive en el grafo y André la contesta en la URL. Sigue con lo demás; `wait gh-<n>` (exit 2 al vencer, vuelve a llamarlo) solo cuando ya no puedas avanzar sin la respuesta |
| Surge trabajo nuevo del tamaño de un `/goal` | `node add <id> --title '<en humano>' --from gh-<n> --why '<por qué>'` | los agentes agregan; nunca reordenan ni borran. Los pasos internos de tu sesión no son nodos. Si la tarea nueva espera a otra, `--dep <nodo>` (eso sí bloquea; `--from` nunca) |
| La tarea ya no va, se partió o enseñó algo | `node close gh-<n> --as dropped\|replaced\|learned --why '<por qué>' [--by <nodo>]` | las ramas mueren a la vista, con su porqué. Partir = cerrar como `replaced --by` una parte y agregar las otras con `--from gh-<n>`. Descartar (`DELETE`) es solo de André |
| Al mergear a `main` | `node done gh-<n> --report <url del PR>` (o `node close gh-<n> --as done --report <url>`) | `done` falla con un bloqueante abierto: no se cierra una tarea con una pregunta sin contestar. Si pasa, avísale a la fábrica por el bus |

**Al desplegar.** Regla de deploy (carrera medida por dogfood el 2026-10-04 16:12Z: dos sitios desplegaron con 6 s de diferencia y ganó el sha más viejo): despliega solo desde un checkout en `origin/main` HEAD recién traído (`git fetch && git checkout --detach origin/main`); después, `/api/health` tiene que dar el sha de `origin/main` en varias llamadas seguidas (durante ~30 s el borde puede alternar entre la versión vieja y la nueva). Si no, vuelve a traer y redespliega. Nunca despliegues desde tu rama.

Reglas que vienen del contrato de #31 y #90 y no se negocian: un agente nunca resuelve un bloqueante, nadie borra
una tarea (se cierra con motivo; descartar y quitar un «nació de» son de André), y `status: blocked` solo lo pone
`block`.

Además del grafo, el sitio sigue drenando su inbox del bus en cada checkpoint y cierra con un mensaje
`--to factory`: el grafo es lo que ve André; el bus es como se hablan los agentes.

### Párrafo para pegar en un kickoff

> Dogfood (épica #44): tu nodo es `gh-<n>` del proyecto «dagyard» en Dagyard. Compila el CLI una vez
> (`pnpm install && pnpm --filter @dagyard/cli build`) y llama `node packages/cli/dist/dagyard.mjs …`
> desde el repo (el proyecto y la URL salen de `.dagyard.json`): al arrancar `node start gh-<n> --team
> <Nombre>`; en cada hito (PR, merge, deploy) `msg gh-<n> '≤280 en lenguaje de producto' --report <url>`
> y `node progress gh-<n> <0..1>`; lo que es de André va con `block gh-<n> --kind decision --q … --opt …`
> (no como issue) y sigues con lo demás; trabajo nuevo que surja va con `node add <id> --title … --from gh-<n>
> --why …`, y una rama que muere, con `node close gh-<n> --as dropped|replaced|learned --why …`; al final,
> `node done gh-<n> --report <url del PR>`. Protocolo completo: `docs/dogfooding.md`.

## La sincronización con GitHub (la fábrica)

```bash
node packages/cli/dist/dagyard.mjs sync --github cofoundy/dagyard [--label <l>] [--stage <etapa>] [--all] [--dry-run]
```

Usa la API granular (nunca reemplaza el grafo), así cada cambio llega en vivo y lo curado se respeta:

- **Nodos.** Un issue abierto sin nodo crea `gh-<n>` (título del issue sin el prefijo `algo: `, etapa
  `--stage` o la de construcción, reconocida por id o nombre en cualquier idioma y sin crear etapas nunca,
  enlace técnico al issue). Los cerrados solo con `--all`; los cerrados como
  «no planeado», nunca. De un nodo que ya existe solo toca el estado y, si está vacío, el enlace: el
  título, la etapa, el equipo y el goal son de la fábrica. Si su enlace apunta a otro issue (otro repo
  con el mismo número), lo salta con un aviso. Las épicas (`epic`) no crean nodo.
- **Estado, solo hacia adelante.** Issue cerrado como completado → Lista (cerrado como duplicado o
  «no planeado» no cuenta). Abierto con un PR abierto que lo cierra
  (`closes|fixes|resolves|cierra|resuelve #n`) y el nodo Pendiente → En progreso. Nunca retrocede.
- **Aristas, solo se agregan.** «Parte de #n» → la épica `gh-n` necesita a este nodo. «depende de #n»,
  «blocked by #n» o «bloqueado por #n» → este nodo necesita a `gh-n`. «sale de la revisión de #n», «nace de #n»
  o «born from #n» → este nodo **nació de** `gh-n` (#90: no bloquea). Solo entre nodos que existen.
- **`founder-input`** → un bloqueante `decision` con el título como pregunta y las opciones `- **A:** …`
  del cuerpo. Si el nodo ya tiene esa pregunta, abierta o contestada, no la vuelve a hacer.
- **Idempotente.** Correrlo dos veces seguidas: la segunda no crea ni cambia nada.

## La migración al modelo D12 (#90)

`node apps/worker/scripts/migrate-d12.mjs <url> [--dry-run]` (clave de `DAGYARD_KEY` o `~/.config/dagyard/agent-key`)
agrega al proyecto el objetivo vivo, los pedidos de André con su cita y un «nació de» para cada tarea, desde
`apps/worker/scripts/migrate-d12.data.json`. Idempotente (la segunda corrida no escribe nada) y nunca borra; avisa
qué ids no existen y qué tareas siguen sin «nació de».

## Verifica

```bash
node packages/cli/dist/dagyard.mjs next                       # responde para «dagyard» sin --project
node packages/cli/dist/dagyard.mjs open gh-64 --print         # el link a la ficha de esa tarea
node packages/cli/dist/dagyard.mjs sync --github cofoundy/dagyard --dry-run
curl -s -H "Authorization: Bearer $(cat ~/.config/dagyard/agent-key)" \
  https://dagyard.cofoundy-dev.workers.dev/api/projects/dagyard | jq '.nodes | length'
```
