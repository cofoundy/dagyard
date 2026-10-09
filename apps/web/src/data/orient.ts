// La brújula (#109): lo que un PM necesita saber en 5 segundos, sacado del DAG y del snapshot. Puro: sin DOM ni reloj.
//   1. ¿Algo te espera?  → los pedidos abiertos, con su tarea y su tipo (decisión, revisión, acceso).
//   2. ¿Qué se mueve?    → las tareas en curso (solo `kind: task`: un objetivo o un pedido «vivo» no es trabajo), con su
//                          última señal de vida (mensaje o arranque) para que lo quieto no pase por movimiento.
//   3. ¿Qué sigue?       → las tareas sin empezar: primero las que ya pueden arrancar, después las que esperan algo,
//                          con lo primero que esperan.

import type { DagModel, DagTask } from './dag';
import type { Blocker, Snapshot } from './types';
import { openBlockers } from './view';

export interface WaitingItem {
  task: DagTask;
  blocker: Blocker;
}

export interface MovingItem {
  task: DagTask;
  /** Última señal de vida (ms): su último mensaje o, sin mensajes, cuándo arrancó o nació. */
  lastSign: number;
  /** La última señal fue un mensaje del equipo (si no, el arranque). */
  news: boolean;
  /** Sin señales hace más de `QUIET_MS`: se dice, no se esconde. */
  quiet: boolean;
}

export interface NextItem {
  task: DagTask;
  /** Ya puede arrancar: todo lo que necesita está cerrado. */
  ready: boolean;
  /** Si no puede arrancar: lo primero (más viejo) que todavía espera. */
  after?: DagTask;
}

export interface Orientation {
  waiting: WaitingItem[];
  moving: MovingItem[];
  next: NextItem[];
}

/** Un día sin noticias: a partir de ahí, «en curso» se acompaña de «sin noticias hace N». */
export const QUIET_MS = 24 * 36e5;

const closed = (m: DagModel, id: string, seen = new Set<string>()): boolean => {
  const t = m.byId.get(id);
  if (!t || seen.has(id)) return true;
  if (t.closedAs === 'replaced' && t.replacedBy) return closed(m, t.replacedBy, seen.add(id));
  return t.closedAs !== null;
};

export function orientation(m: DagModel, s: Snapshot): Orientation {
  const waiting: WaitingItem[] = [];
  const seenTask = new Set<string>();
  for (const b of openBlockers(s)) {
    const task = m.byId.get(b.nodeId);
    if (!task || seenTask.has(task.id)) continue;
    seenTask.add(task.id);
    waiting.push({ task, blocker: b });
  }

  const lastMsg = new Map<string, number>();
  for (const msg of s.messages) {
    const at = Date.parse(msg.at);
    if (Number.isFinite(at) && at > (lastMsg.get(msg.nodeId) ?? -Infinity)) lastMsg.set(msg.nodeId, at);
  }
  const started = new Map(s.nodes.map((n) => [n.id, n.startedAt ? Date.parse(n.startedAt) : NaN]));

  const moving: MovingItem[] = m.tasks
    // una tarea va en un solo grupo: si te espera, no se repite como «en curso»
    .filter((t) => t.kind === 'task' && t.status === 'working' && !seenTask.has(t.id))
    .map((task) => {
      const st = started.get(task.id);
      const said = lastMsg.get(task.id) ?? -Infinity;
      const lastSign = Math.max(said, Number.isFinite(st) ? st! : task.born);
      return { task, lastSign, news: said === lastSign, quiet: m.now - lastSign > QUIET_MS };
    })
    // lo que se mueve de verdad primero; lo quieto después, y la cabecera lo cuenta aparte («2 · 1 sin noticias»)
    .sort((a, b) => Number(a.quiet) - Number(b.quiet) || b.lastSign - a.lastSign);

  const next: NextItem[] = m.tasks
    .filter((t) => t.kind === 'task' && t.status === 'pending' && t.closedAs === null)
    .map((task) => {
      const open = task.needs.filter((id) => !closed(m, id)).map((id) => m.byId.get(id)!).sort((a, b) => a.born - b.born);
      return { task, ready: open.length === 0, after: open[0] };
    })
    // lo que ya puede arrancar primero; dentro, lo más nuevo (lo que la fábrica acaba de pedir)
    .sort((a, b) => Number(b.ready) - Number(a.ready) || b.task.born - a.task.born);

  return { waiting, moving, next };
}

/** Filas por grupo en la brújula: 3 a la vista; desplegado, hasta 8 y el resto se busca por nombre (sin scroll dentro). */
export const ROWS = 3;
export const ROWS_MAX = 8;

export interface Rows {
  /** Filas que se pintan. */
  shown: number;
  /** Las que «+N más» despliega (0: no hay botón). */
  more: number;
  /** Las que ni desplegado caben: se buscan con «Busca una tarea». */
  rest: number;
}

/**
 * Cuántas filas de un grupo se ven. `cap` es lo que se ve plegado (3 en escritorio; 0 en celular o cuando el otro grupo
 * está desplegado: la columna crece sin scroll y no se come el pie).
 */
export function rowsShown(total: number, open: boolean, cap = ROWS): Rows {
  if (open) {
    const shown = Math.min(total, ROWS_MAX);
    return { shown, more: 0, rest: total - shown };
  }
  const shown = Math.min(total, cap);
  return { shown, more: total - shown, rest: 0 };
}

/**
 * Dos filas con el mismo título no se distinguen (#109, datos hostiles): a cada tarea cuyo título se repite le toca un
 * distintivo corto. El número del issue (`gh-109` → `#109`) si lo tiene; si no, `label(task)` (la hora en que nació);
 * y si aun así chocan, su orden (`· 2`). Un título único no lleva nada.
 */
export function twinTags(tasks: readonly DagTask[], label: (t: DagTask) => string): Map<string, string> {
  const norm = (s: string) => s.trim().toLocaleLowerCase();
  const byTitle = new Map<string, DagTask[]>();
  for (const t of tasks) {
    const k = norm(t.title);
    const list = byTitle.get(k) ?? [];
    if (!list.some((x) => x.id === t.id)) list.push(t);
    byTitle.set(k, list);
  }
  const out = new Map<string, string>();
  for (const list of byTitle.values()) {
    if (list.length < 2) continue;
    const tags = list.map((t) => {
      const gh = /^gh-(\d+)$/.exec(t.id);
      return gh ? `#${gh[1]}` : label(t);
    });
    list.forEach((t, i) => {
      const clash = tags.filter((x) => x === tags[i]).length > 1;
      out.set(t.id, clash ? `${tags[i]} · ${tags.slice(0, i + 1).filter((x) => x === tags[i]).length}` : tags[i]!);
    });
  }
  return out;
}
