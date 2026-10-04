# El modelo del DAG (#90, D12)

> Intención: §1 Mensaje 11 (2026-10-04 18:00-18:17): «no tenía que ser árbol, tenía que ser DAG. cada
> task tiene q tener un propósito o poder ser continuada no?» … «Sí go». Decisión **D12** y los siete
> principios, en `~/cofoundy/plugins/cofoundy-orchestrator/docs/intent/2026-10-03-panel-dag-de-la-fabrica.md`
> (§1 Mensaje 11). Si este archivo difiere de la intención, gana la intención.

## Los siete principios (intención §1 Mensaje 11, tal cual)

1. **Propósito:** toda tarea existe para servir a otra o a un objetivo; sin camino a un objetivo se
   marca como posible desperdicio.
2. **Terminado verificable:** misión de una línea (`/goal`) y evidencia de cierre.
3. **Cierre con motivo:** lista, reemplazada, descartada o «aprendimos», siempre con su porqué; al cerrar
   puede dejar continuaciones. Las ramas mueren a la vista, no en silencio.
4. **Historia inmutable:** nada se borra; cada cambio es un evento y el grafo se reproduce en el tiempo.
5. **El tiempo no es el orden de dependencia:** el eje x es cuándo nació; una arista «necesita» puede
   apuntar hacia atrás (A → B → C) y se muestra.
6. **Una tarea, un dueño, una sesión:** del tamaño de un `/goal`; los pasos internos de un agente no son
   nodos.
7. **Quién muta qué:** los agentes agregan; la fábrica reordena, parte o descarta (como cierre enlazado);
   el humano aprueba lo que toca el alcance; lo único que espera a una persona es un bloqueante tipado
   (decisión, revisión o acceso).

Cómo los encarna el modelo: (1) la arista «nació de» y `purposeless`; (2) `goal` + la evidencia que exige
cerrar una tarea como lista; (3) `closedAs` + `closedReason` + `replacedBy`, y «al cerrar puede dejar
continuaciones» = nodos nuevos que nacen del cerrado; (4) ningún camino borra la fila de un nodo y el log se
reproduce con `applyEvent`; (5) `bornAt` y aristas «necesita» sin restricción de tiempo; (6) es una regla de
uso del CLI y la skill (#91), no una validación; (7) descartar (`DELETE`) y quitar un porqué son del dueño;
los bloqueantes no cambian. Partir un nodo = cerrarlo como reemplazado por una de las partes y hacer nacer
las demás de él; unir dos = cerrar uno como reemplazado por el otro.

## Primitivas

### Nodo (`DagNode`)

Campos nuevos, todos presentes en cada snapshot (opcionales en el tipo solo para leer servidores viejos):

| Campo | Tipo | Qué |
|---|---|---|
| `kind` | `'goal' \| 'request' \| 'task' \| 'stream'` | tipo; los nodos guardados antes de #90 son `task` |
| `bornAt` | ISO | cuándo nació. Por defecto la hora de la escritura; un agente puede mandarlo al crear (traer historia), nunca en el futuro. Los viejos: su `createdAt` |
| `quote` | `string \| null` (≤1000) | `request`: la cita literal de la persona, obligatoria. Los demás: null |
| `quoteBy` | `string \| null` (≤80) | `request`: quién lo dijo, p. ej. «André». Opcional |
| `closedAs` | `'done' \| 'replaced' \| 'dropped' \| 'learned' \| null` | motivo de cierre; null = abierto |
| `closedReason` | `string \| null` (≤500) | por qué; obligatorio para `replaced`, `dropped` y `learned` |
| `replacedBy` | `string \| null` | id del nodo que lo reemplaza; obligatorio con `replaced`, prohibido con los demás |
| `closedAt` | `ISO \| null` | cuándo se cerró |

`status` sigue con los cuatro valores de siempre. Un nodo cerrado (con cualquier motivo) queda en
`status: 'done'`; `closedAs` dice cuál. Pasar a `done` por `PATCH {status: 'done'}` cierra como `done` (sin exigir evidencia, como hoy; en un `goal` o `stream` → 400);
volver a `pending` o `working` reabre (limpia los cuatro campos de cierre; el log guarda el cierre anterior).

| Tipo | Qué es | Arranca (`next`) | Cómo se cierra |
|---|---|---|---|
| `goal` | un resultado vivo, raíz de los porqués | nunca | no se cierra como `done`; sí `replaced`, `dropped` o `learned` |
| `request` | pedido o decisión de una persona, con su cita | nunca | cualquier motivo (`done` = cumplido) |
| `task` | un dueño, una sesión, un `/goal`, evidencia de cierre | sí | cualquier motivo |
| `stream` | trabajo continuo (deuda técnica, monitoreo); suelta tareas | nunca | no se cierra como `done`; sí `replaced`, `dropped` o `learned` |

Un `goal` o `stream` nuevo nace `working` si no se dice otra cosa (está vivo). `stage` pasa a ser opcional
en la API: sin él, la primera etapa del proyecto.

### Aristas

| | «Necesita» (`Edge`, `snapshot.edges`) | «Nació de» (`Origin`, `snapshot.origins`) |
|---|---|---|
| Sentido | `to` necesita que `from` esté cerrado | `to` nació de `from` |
| Campos | `projectId, from, to` (como siempre) | `projectId, from, to, why: string \| null` (≤280), `createdAt` |
| Eventos | `edge.added`, `edge.removed` | `origin.added`, `origin.removed` |
| Ciclos | prohibidos (400 `cycle`, como siempre) | prohibidos, por separado (400 `cycle`) |
| Restricción | `from` no puede ser `goal` ni `stream` (nunca se cierran: bloquearían para siempre) | ninguna |
| Quitar | dueño o agente (como hoy) | solo el dueño (es el porqué) |

Van en dos listas para que un cliente viejo, que solo conoce `edges`, siga viendo exactamente las mismas
dependencias: «nació de» nunca se dibuja ni se cuenta como bloqueo por error.

Un nodo puede nacer de varios (es un DAG, no un árbol) y puede tener las dos aristas con el mismo vecino.

### Lo arrancable

`startable` y `nextStartable` miran solo `kind: 'task'`, `status: 'pending'` y solo `edges`. Una dependencia
está satisfecha si está cerrada; si se cerró como `replaced`, se sigue `replacedBy` (en cadena, sin ciclos)
y cuenta el estado del último. `origins` nunca entra.

### Propósito

`purposeless(nodes, origins): string[]` devuelve los ids de los nodos que no son `goal` y no tienen camino
por `origins` (de `to` hacia `from`) hasta un `goal`. Es una función pura del modelo; la UI decide cómo
marcarlos.

## API (Worker)

| Método | Ruta | Quién | Qué |
|---|---|---|---|
| `POST` | `/api/projects/:pid/nodes` | ambos | acepta `kind`, `bornAt`, `quote`, `quoteBy` y `origins: [{from, why?}]` (además de `deps`) |
| `PATCH` | `/api/projects/:pid/nodes/:nid` | ambos | acepta `kind`, `quote`, `quoteBy`; `status: 'done'` cierra como `done`; no acepta `closedAs` (para eso, `close`) |
| `POST` | `/api/projects/:pid/nodes/:nid/close` | ambos | `{as, why?, by?, reportUrl?}`: cierra con motivo; emite `node.updated`. Reglas de la tabla de tipos; una `task` cerrada como `done` necesita evidencia (`why`, `reportUrl` en el cuerpo o el que ya tenía) → si no, 400; cerrar un nodo ya cerrado → 409; con una pregunta abierta → 409 (como `done` hoy) |
| `DELETE` | `/api/projects/:pid/nodes/:nid` | solo el dueño | **descartar**: cierra como `dropped` (motivo opcional en `?why=`), con las reglas de `close` (ya cerrado o con pregunta abierta → 409). Nunca borra la fila. Agente → 403 |
| `POST` | `/api/projects/:pid/edges` | ambos | `{from, to, kind?: 'requires' \| 'origin', why?}`; sin `kind`, `requires` |
| `DELETE` | `/api/projects/:pid/edges?from&to[&kind=origin]` | `requires`: ambos; `origin`: dueño | |
| `PUT` | `/api/projects/:pid` | ambos | en un proyecto existente que no es demo, un nodo que el cuerpo no trae ya no se borra: queda con sus aristas, orígenes, preguntas y mensajes, cerrado como `dropped` («no está en el import») si estaba abierto y sin una pregunta abierta (con una, queda como está). Si el cuerpo cambia las etapas y uno de esos nodos usa una que desaparece → 400. Un nodo que el cuerpo sí trae conserva su `kind`, `quote`, `quoteBy` y `bornAt` si no los manda (como `link`). Las aristas «necesita» que llegan a un nodo del cuerpo salen de sus `deps`; los orígenes existentes se conservan y se suman los del cuerpo. Los nodos del cuerpo aceptan `kind`, `bornAt`, `quote`, `quoteBy`, `origins` |

- Ningún camino de escritura borra la fila de un nodo, salvo dos que no son caminos de nodo y quedan
  documentados como tales: re-sembrar una **demo** (la demo es una fixture que vuelve a su guion) y borrar
  el **proyecto entero** (`DELETE /api/projects/:pid`, solo el dueño).
- Migración nueva en `apps/worker/src/schema.ts` (nunca editar una aplicada): columnas `kind` (default
  `task`), `born_at` (backfill = `created_at`), `quote`, `quote_by`, `closed_as`, `closed_reason`,
  `replaced_by`, `closed_at` en `nodes`; los nodos `done` existentes quedan `closed_as = 'done'` y
  `closed_at = COALESCE(done_at, updated_at)`. Tabla nueva `origins (project_id, from_id, to_id, why,
  created_at)`. Las aristas existentes ya son «necesita»: no cambian.
- `node.removed` queda en el tipo `DagEvent` y en `applyEvent` para reproducir logs viejos; nada nuevo lo
  emite.

## CLI

- `dagyard node add <nodo> --title "…" [--kind goal|request|task|stream] [--from <nodo> --why "…"]… [--quote "…"] [--author "…"]` (el resto como hoy; `--stage` opcional).
- `dagyard node close <nodo> --as done|replaced|dropped|learned [--why "…"] [--by <nodo>]`.
- `dagyard goal add <nodo> --title "…"` y `dagyard request add <nodo> --title "…" --quote "…" [--author "…"] [--from <nodo>]`: atajos de `node add --kind`.
- `dagyard edge add <from> <to> [--kind origin --why "…"]`.
- `dagyard sync --github`: «Parte de #n» sigue siendo «necesita» (la épica `gh-n` necesita a este nodo);
  «sale de la revisión de #n», «nace de #n» o «born from #n» → «nació de» desde `gh-n`.

## El proyecto «dagyard»

Migrado con `apps/worker/scripts/migrate-d12.mjs` (idempotente, con la clave de agente): objetivos vivos,
los pedidos de André de los Mensajes 7 a 11 como `request` con su cita, y una arista «nació de» para cada
tarea.

## Verifica

- `pnpm typecheck && pnpm test && pnpm build` con exit 0.
- `curl -s -H "Authorization: Bearer $(cat ~/.config/dagyard/agent-key)" <url>/api/projects/dagyard | jq
  '[.nodes[] | select(.kind=="task")] as $t | [.origins[].to] as $o | [$t[] | select(.id as $i | $o | index($i) | not)] | length'` → `0`.
- `GET /api/projects/<demo>/next` igual antes y después del deploy.
