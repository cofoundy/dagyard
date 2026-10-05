// El DAG que dibuja la vista (#75 «una sola vista», modelo de #90): cada tarea con cuándo nació, de qué nació (y por
// qué), qué necesita, qué la necesita, cómo se cerró y si quedó suelta. Puro: snapshot → modelo, sin DOM ni reloj.
//
// Con un servidor que ya habla #90 se leen `kind`, `bornAt`, `origins` y `closedAs` tal cual. Con uno anterior se
// deriva lo mínimo (regla 5 de design/arbol/shared/lineage.js): una tarea nació de su dependencia más antigua nacida
// antes que ella, y nada más. Esa derivación no se dibuja como «nació de» (repetiría la dependencia): solo ordena filas
// y arma «cómo llegamos aquí». El resto de lineage.js lee cuerpos de issues de GitHub y es un backfill del servidor
// (`dagyard backfill-dag`), no lógica de la UI.

import type { CloseAs, NodeKind, NodeStatus, Snapshot } from './types';

export interface DagOrigin {
  from: string;
  /** El porqué, tal como lo escribieron (datos: no se traduce). */
  why?: string;
  /** Inferido de una dependencia porque el servidor todavía no guarda orígenes. */
  derived: boolean;
}

export interface DagTask {
  id: string;
  title: string;
  status: NodeStatus;
  kind: NodeKind;
  /** Cuándo nació (ms). */
  born: number;
  /** El servidor dijo cuándo nació (si no, se ubica junto a lo más antiguo). */
  bornKnown: boolean;
  closedAs: CloseAs | null;
  closedReason?: string;
  replacedBy?: string;
  quote?: string;
  quoteBy?: string;
  team?: string;
  link?: string;
  reportUrl?: string;
  progress: number;
  origins: DagOrigin[];
  /** Lo que nació de esta tarea, del más viejo al más nuevo. */
  children: string[];
  /** Lo que necesita (sus dependencias). */
  needs: string[];
  /** Lo que la necesita. */
  neededBy: string[];
  /** Sin camino a una meta (#90 «posible desperdicio»); en un proyecto sin metas, terminada y sin ninguna relación. */
  loose: boolean;
  /** Generaciones por su primer origen hasta una raíz. */
  depth: number;
}

export type DagEdgeKind = 'needs' | 'origin';

/** Una línea del dibujo. `needs`: `to` necesita a `from`. `origin`: `to` nació de `from`. */
export interface DagEdge {
  from: string;
  to: string;
  kind: DagEdgeKind;
  why?: string;
}

export interface DagModel {
  tasks: DagTask[];
  byId: Map<string, DagTask>;
  edges: DagEdge[];
  /** El presente del proyecto (ms): el borde derecho del eje. */
  now: number;
  /** Los orígenes se dedujeron de las dependencias (servidor sin #90). */
  derived: boolean;
  hasGoals: boolean;
}

/** Cerrada con un motivo que no es «lista»: reemplazada, descartada o «aprendimos». */
export const isEnded = (t: Pick<DagTask, 'closedAs'>): boolean => t.closedAs === 'replaced' || t.closedAs === 'dropped' || t.closedAs === 'learned';

export function buildDag(s: Snapshot, now = Date.now()): DagModel {
  const ids = new Set(s.nodes.map((n) => n.id));
  const parsed = s.nodes.map((n) => (n.bornAt ? Date.parse(n.bornAt) : NaN));
  const known = parsed.filter((t) => Number.isFinite(t));
  // sin fecha (datos viejos o de prueba): junto a lo más antiguo, siempre en el mismo lugar
  const fallback = known.length ? Math.min(...known) : now;
  const tasks: DagTask[] = s.nodes.map((n, i) => {
    const b = parsed[i]!;
    const closedAs: CloseAs | null = n.closedAs ?? (n.status === 'done' ? 'done' : null);
    return {
      id: n.id,
      title: n.title,
      status: n.status,
      kind: n.kind ?? 'task',
      born: Number.isFinite(b) ? b : fallback,
      bornKnown: Number.isFinite(b),
      closedAs,
      closedReason: n.closedReason,
      replacedBy: n.replacedBy && ids.has(n.replacedBy) ? n.replacedBy : undefined,
      quote: n.quote,
      quoteBy: n.quoteBy,
      team: n.team,
      link: n.link,
      reportUrl: n.reportUrl,
      progress: n.progress,
      origins: [],
      children: [],
      needs: [],
      neededBy: [],
      loose: false,
      depth: 0,
    };
  });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const edges: DagEdge[] = [];
  const seen = new Set<string>();

  for (const e of s.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    const key = `${e.from}>${e.to}`;
    if (!a || !b || a === b || seen.has(key)) continue;
    seen.add(key);
    b.needs.push(a.id);
    a.neededBy.push(b.id);
    edges.push({ from: a.id, to: b.id, kind: 'needs' });
  }

  const derived = s.origins === undefined;
  if (!derived) {
    const oseen = new Set<string>();
    for (const o of s.origins!) {
      const a = byId.get(o.from), b = byId.get(o.to);
      const key = `${o.from}>${o.to}`;
      if (!a || !b || a === b || oseen.has(key)) continue;
      oseen.add(key);
      b.origins.push({ from: a.id, why: o.why, derived: false });
      edges.push({ from: a.id, to: b.id, kind: 'origin', why: o.why });
    }
  } else {
    // servidor sin #90: nació de su dependencia más antigua que no nació después que ella
    for (const t of tasks) {
      const first = t.needs
        .map((id) => byId.get(id)!)
        .filter((d) => d.born <= t.born)
        .sort((x, y) => x.born - y.born || x.id.localeCompare(y.id))[0];
      if (first) t.origins.push({ from: first.id, derived: true });
    }
  }
  // el primer origen manda en la fila, así que tiene que ser el más antiguo (el «tronco» de donde brota)
  for (const t of tasks) t.origins.sort((x, y) => byId.get(x.from)!.born - byId.get(y.from)!.born);
  for (const t of tasks) for (const o of t.origins) byId.get(o.from)!.children.push(t.id);
  for (const t of tasks) t.children.sort((x, y) => byId.get(x)!.born - byId.get(y)!.born || x.localeCompare(y));

  for (const t of tasks) t.depth = chainOf(byId, t.id).length - 1;

  const hasGoals = tasks.some((t) => t.kind === 'goal');
  if (hasGoals) {
    const lost = new Set(purposeless(tasks, tasks.flatMap((t) => t.origins.map((o) => ({ from: o.from, to: t.id })))));
    for (const t of tasks) t.loose = lost.has(t.id) && !isEnded(t);
  } else {
    for (const t of tasks)
      t.loose = t.status === 'done' && !isEnded(t) && !t.needs.length && !t.neededBy.length && !t.origins.length && !t.children.length;
  }

  const latest = tasks.reduce((m, t) => Math.max(m, t.born), -Infinity);
  return { tasks, byId, edges, now: Math.max(now, latest), derived, hasGoals };
}

/**
 * #90 `purposeless` (packages/model de sprint/modelo), copiada mientras no entre a main: los ids de los nodos que no son
 * `goal` y no tienen camino por «nació de» (de `to` hacia `from`) hasta un `goal`. En el orden de `nodes`.
 */
export function purposeless(nodes: readonly { id: string; kind?: NodeKind }[], origins: readonly { from: string; to: string }[]): string[] {
  const parents = new Map<string, string[]>();
  for (const o of origins) (parents.get(o.to) ?? parents.set(o.to, []).get(o.to)!).push(o.from);
  const kind = new Map(nodes.map((n) => [n.id, n.kind ?? 'task']));
  const memo = new Map<string, boolean>();
  const reaches = (start: string): boolean => {
    const seen = new Set<string>([start]);
    const q = [start];
    while (q.length) {
      const u = q.shift()!;
      if (kind.get(u) === 'goal' || memo.get(u) === true) return true;
      for (const p of parents.get(u) ?? []) if (!seen.has(p)) (seen.add(p), q.push(p));
    }
    return false;
  };
  const out: string[] = [];
  for (const n of nodes) {
    if ((n.kind ?? 'task') === 'goal') continue;
    const ok = reaches(n.id);
    memo.set(n.id, ok);
    if (!ok) out.push(n.id);
  }
  return out;
}

function chainOf(byId: Map<string, DagTask>, id: string): DagTask[] {
  const out: DagTask[] = [];
  const seen = new Set<string>();
  let t = byId.get(id);
  while (t && !seen.has(t.id)) {
    seen.add(t.id);
    out.unshift(t);
    const p = t.origins[0]?.from;
    t = p ? byId.get(p) : undefined;
  }
  return out;
}

/** «Cómo llegamos aquí»: de la raíz a la tarea, por su primer origen. */
export function chain(m: DagModel, id: string): DagTask[] {
  return chainOf(m.byId, id);
}

/** La meta más cercana por «nació de» (o la tarea misma si es una meta). */
export function goalOf(m: DagModel, id: string): DagTask | undefined {
  const start = m.byId.get(id);
  if (!start) return undefined;
  const seen = new Set([id]);
  const q = [start];
  while (q.length) {
    const t = q.shift()!;
    if (t.kind === 'goal') return t;
    for (const o of t.origins) if (!seen.has(o.from)) (seen.add(o.from), q.push(m.byId.get(o.from)!));
  }
  return undefined;
}

/** Lo que una tarea tiene cerca en el grafo: orígenes, lo que nació de ella, lo que necesita y lo que la necesita. */
export function relatedOf(m: DagModel, id: string): Set<string> {
  const t = m.byId.get(id);
  if (!t) return new Set();
  return new Set([id, ...t.origins.map((o) => o.from), ...t.children, ...t.needs, ...t.neededBy, ...(t.replacedBy ? [t.replacedBy] : [])]);
}

export interface DagCounts {
  total: number;
  working: number;
  pending: number;
  waiting: number;
  loose: number;
}

export function dagCounts(m: DagModel): DagCounts {
  const c = { total: m.tasks.length, working: 0, pending: 0, waiting: 0, loose: 0 };
  for (const t of m.tasks) {
    if (t.status === 'working') c.working++;
    else if (t.status === 'pending') c.pending++;
    else if (t.status === 'blocked') c.waiting++;
    if (t.loose) c.loose++;
  }
  return c;
}
