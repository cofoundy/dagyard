/** Reglas puras del grafo. Las usan el Worker (`next`, ciclos) y la UI/CLI (conteos). */
import { DEFAULT_KIND, type DagNode, type Edge, type NextResult, type NodeKind, type Origin, type ProjectCounts, type Stage } from './types.js';

type E = Pick<Edge, 'from' | 'to'>;

/** Devuelve un ciclo (lista de ids, cerrando en el primero) o null si el grafo es un DAG. */
export function findCycle(ids: readonly string[], edges: readonly E[]): string[] | null {
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e.to);
  }
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const visit = (u: string): string[] | null => {
    color.set(u, GREY);
    stack.push(u);
    for (const v of out.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GREY) return [...stack.slice(stack.indexOf(v)), v];
      if (c === WHITE) {
        const r = visit(v);
        if (r) return r;
      }
    }
    stack.pop();
    color.set(u, BLACK);
    return null;
  };
  for (const id of out.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      const r = visit(id);
      if (r) return r;
    }
  }
  return null;
}

/** ¿Agregar from → to cierra un ciclo? (incluye from === to) */
export function wouldCreateCycle(edges: readonly E[], from: string, to: string): boolean {
  if (from === to) return true;
  // hay ciclo si desde `to` ya se llega a `from`
  const out = new Map<string, string[]>();
  for (const e of edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  const seen = new Set<string>();
  const q = [to];
  while (q.length) {
    const u = q.pop()!;
    if (u === from) return true;
    if (seen.has(u)) continue;
    seen.add(u);
    q.push(...(out.get(u) ?? []));
  }
  return false;
}

export function depsOf(nodeId: string, edges: readonly E[]): string[] {
  return edges.filter((e) => e.to === nodeId).map((e) => e.from);
}

export function dependentsOf(nodeId: string, edges: readonly E[]): string[] {
  return edges.filter((e) => e.from === nodeId).map((e) => e.to);
}

/** El tipo de un nodo; sin el campo (guardado antes de #90 o de un servidor viejo), `task`. */
export function nodeKind(n: { kind?: NodeKind | null }): NodeKind {
  return n.kind ?? DEFAULT_KIND;
}

/** ¿Nunca se cierra como `done`? (`goal` y `stream`: tampoco pueden ser el `from` de un «necesita», bloquearían para siempre) */
export function neverDone(kind: NodeKind): boolean {
  return kind === 'goal' || kind === 'stream';
}

type Closable = Pick<DagNode, 'id' | 'status' | 'closedAs' | 'replacedBy'>;

/**
 * ¿La dependencia `id` está satisfecha? Si está cerrada; si se cerró como `replaced`, cuenta la última de la cadena
 * de `replacedBy` (sin ciclos: una cadena que vuelve sobre sí misma o que lleva a un nodo que no está, no satisface).
 */
export function depSatisfied(byId: ReadonlyMap<string, Closable>, id: string): boolean {
  const seen = new Set<string>();
  let n = byId.get(id);
  while (n) {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    if (n.status !== 'done') return false;
    if (n.closedAs !== 'replaced' || !n.replacedBy) return true;
    n = byId.get(n.replacedBy);
  }
  return false;
}

/**
 * Un nodo es arrancable si es una `task` `pending` y todas sus dependencias («necesita», solo `edges`) están
 * satisfechas (`depSatisfied`). «Nació de» nunca entra.
 */
export function startable(nodes: readonly DagNode[], edges: readonly E[]): DagNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes.filter(
    (n) => nodeKind(n) === 'task' && n.status === 'pending' && depsOf(n.id, edges).every((d) => depSatisfied(byId, d)),
  );
}

/**
 * Propósito (#90): los ids de los nodos que no son `goal` y no tienen camino por «nació de» (de `to` hacia `from`)
 * hasta un `goal`: posible desperdicio. La UI decide cómo marcarlos. En el orden de `nodes`.
 */
export function purposeless(
  nodes: readonly Pick<DagNode, 'id' | 'kind'>[],
  origins: readonly Pick<Origin, 'from' | 'to'>[],
): string[] {
  const parents = new Map<string, string[]>();
  for (const o of origins) (parents.get(o.to) ?? parents.set(o.to, []).get(o.to)!).push(o.from);
  const kind = new Map(nodes.map((n) => [n.id, nodeKind(n)]));
  const memo = new Map<string, boolean>();
  const reaches = (start: string): boolean => {
    // BFS hacia arriba; los ciclos (prohibidos, pero un log viejo puede traerlos) no cuelgan
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
    if (nodeKind(n) === 'goal') continue;
    const ok = reaches(n.id);
    memo.set(n.id, ok);
    if (!ok) out.push(n.id);
  }
  return out;
}

/** La línea que la fábrica le inyecta al agente. */
export function goalLine(node: Pick<DagNode, 'title' | 'goal'>): string {
  return `/goal ${(node.goal ?? node.title).replace(/\s+/g, ' ').trim()}`;
}

/** El siguiente nodo arrancable: primero por etapa, luego por antigüedad, luego por id. */
export function nextStartable(
  stages: readonly Stage[],
  nodes: readonly DagNode[],
  edges: readonly E[],
): NextResult {
  const order = new Map(stages.map((s, i) => [s.id, i]));
  const [node] = startable(nodes, edges).sort(
    (a, b) =>
      (order.get(a.stage) ?? 99) - (order.get(b.stage) ?? 99) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  return node ? { node, goalLine: goalLine(node) } : { node: null, goalLine: null };
}

export function countNodes(nodes: readonly Pick<DagNode, 'status'>[]): ProjectCounts {
  const c: ProjectCounts = { total: nodes.length, pending: 0, working: 0, blocked: 0, done: 0 };
  for (const n of nodes) c[n.status]++;
  return c;
}

/** Etapas «vivas» (con algo en progreso o esperando al humano), para el «ahora en …» de la UI. */
export function liveStages(stages: readonly Stage[], nodes: readonly DagNode[]): Stage[] {
  return stages.filter((s) => nodes.some((n) => n.stage === s.id && (n.status === 'working' || n.status === 'blocked')));
}
