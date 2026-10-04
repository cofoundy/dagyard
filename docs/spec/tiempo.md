# La fábrica en el tiempo (#75)

> Intención: §1 Mensaje 9 (2026-10-04 14:05): «q esta plataforma reemplace el reporte de factory para q
> tenga seecuencia temporal, q podamos ver cuando abrieron cada agente y q los nuevos se vayan
> desplegando, also no se xq siempre lo pones como matriz». Diseño: `design/tiempo/handoff.md`
> (prototipos A, B y C; la elección de André queda en el bloqueante de `gh-75`).

> **Estado (2026-10-04 18:30 -05).** Entra a `main` solo la base: equipos, tiempos por tarea e
> `import-ledger`. La vista «Timeline» de abajo **quedó descartada**: André rechazó los prototipos A, B y C
> (`design/tiempo/`) y pidió una sola vista, el DAG que crece en el tiempo (intención §1 Mensajes 10 y 11,
> D12). Su modelo lo define `docs/spec/modelo.md` (#90) y la vista sigue en #75 sobre esa base.

## Qué ve el PM (descartado, se conserva como registro)

Además de la vista por etapas («Plan»), el proyecto tiene una vista **Timeline**: el día de la fábrica
en el tiempo. Cada equipo (un sitio de `/factory`) aparece a la hora en que arrancó, con las tareas que
llevó naciendo cuando ocurrieron y lo que le esperó al humano marcado con su duración. Se reproduce con
play. Ninguna etapa se dibuja como rejilla. El informe de una corrida de la fábrica es el link de
Dagyard (`/?p=<proyecto>&v=timeline`), ya no `harvest.py` → Basalt.

## Contrato de datos (`packages/model/src/types.ts`, ya escrito)

- `Team` = un sitio: `id` (slug del sitio), `name`, `nodeIds`, `requestedAt`, `startedAt`, `closedAt`,
  `outcome`, `updatedAt`. Las fechas son las del sitio, no las de la escritura: así se puede traer la
  historia después.
- `DagNode` gana `startedAt` (primera vez en `working`), `doneAt` (al pasar a `done`; se limpia si deja
  de estarlo) y `teamId`. Opcionales en el tipo por compatibilidad; el servidor siempre los manda.
- Evento nuevo `team.updated { team }`. `ProjectSnapshot.teams` (por `startedAt`, nulos al final).

## API (Worker)

| Método | Ruta | Quién | Qué |
|---|---|---|---|
| `PUT` | `/api/projects/:pid/teams/:tid` | agente u dueño | upsert parcial `{name?, nodeIds?, requestedAt?, startedAt?, closedAt?, outcome?}`; emite `team.updated` solo si algo cambió (idempotente). `tid` = slug `[a-z0-9-]{1,64}`; fechas ISO válidas; `nodeIds` ≤ 50 |
| `GET` | `/api/projects/:pid` | ambos | el snapshot incluye `teams` |
| `PATCH` | `/api/projects/:pid/nodes/:nid` | ambos | acepta `teamId`; el servidor pone `startedAt`/`doneAt` en las transiciones de estado (el cliente no los escribe) |

- Migración nueva (nunca editar una aplicada): tabla `teams`, columnas `started_at`, `done_at`,
  `team_id` en `nodes`. Backfill de los nodos existentes desde el log de eventos (primer `working`,
  último `done`).
- `project.replaced` conserva el `createdAt` de los bloqueantes que llegan en el cuerpo (hoy se pierde
  la hora real de la pregunta al recrear).
- Borrar un proyecto borra sus equipos.

## CLI

- `dagyard team start <sitio> --name <Nombre> [--issues 45,46]` y `dagyard team close <sitio> --outcome <merged|pr-open|stopped>`.
- `dagyard start gh-<n>` manda `teamId` = `$COFOUNDY_AGENT` si existe (o `--site <sitio>`), y agrega el
  nodo a ese equipo.
- `dagyard import-ledger [<sites.jsonl>] [--repo <r>]`: trae la historia de la fábrica (por defecto
  `~/cofoundy/.coordination/factory/sites.jsonl`, repo = el del cwd) como equipos con sus fechas;
  `issues: ["75"]` → `nodeIds: ["gh-75"]`. Idempotente: correrlo dos veces no emite eventos la segunda.

## Web (descartado: lo reemplaza la vista del DAG)

La variante elegida en `gh-75` (por defecto A, «Team lanes»), portada desde `design/tiempo/` según su
`handoff.md`: el modelo puro `apps/web/src/data/timeline.ts` (desde `shared/timeline.js`), la escena de
la vista en el tiempo, el transporte (play, scrub, velocidad, Now) y el switch Plan · Timeline. Con
`teams` del servidor cuando existen; con la inferencia del prototipo (issue → sitio, nombre del team)
para los datos viejos. Textos por el catálogo i18n (`timeline.*`). El link directo de #64 sigue igual.

## Verifica

- `pnpm typecheck && pnpm test && pnpm build` con exit 0.
- `dagyard import-ledger` sobre el ledger real dos veces: la segunda, 0 eventos.
- En la preview, `/?p=dagyard&v=timeline` muestra los 24 equipos de hoy en orden de llegada y la
  reproducción corre de 00:35 a ahora (filmstrip en `docs/qa/tiempo/`).
