// Reducer puro: snapshot + evento → snapshot nuevo. No muta, es idempotente (ignora `seq <= snapshot.seq`)
// y tolera eventos fuera de orden de entidades que ya no existen.

import type { DagEvent, Snapshot } from './types';

/** Cuántos mensajes guarda la UI (el servidor manda los últimos 200 en el snapshot). */
export const MAX_MESSAGES = 200;

export function reduce(s: Snapshot, e: DagEvent): Snapshot {
  if (e.seq <= s.seq) return s;
  const next: Snapshot = { ...s, seq: e.seq };
  switch (e.type) {
    case 'node.added':
    case 'node.updated': {
      const i = s.nodes.findIndex((n) => n.id === e.node.id);
      if (i < 0) {
        // Un `node.updated` parcial de un nodo desconocido no alcanza para pintarlo.
        if (e.type === 'node.updated' && !isFullNode(e.node)) return next;
        next.nodes = [...s.nodes, e.node as Snapshot['nodes'][number]];
      } else {
        // Nodo completo (lo que manda el servidor) = reemplazo: un campo ausente se borró.
        // Parcial = mezcla sobre lo que había.
        const full = isFullNode(e.node);
        next.nodes = s.nodes.map((n, j) =>
          j === i ? (full ? (e.node as Snapshot['nodes'][number]) : { ...n, ...stripUndefined(e.node) }) : n,
        );
      }
      break;
    }
    case 'node.removed': {
      const id = e.nodeId;
      next.nodes = s.nodes.filter((n) => n.id !== id);
      next.edges = s.edges.filter((x) => x.from !== id && x.to !== id);
      if (s.origins) next.origins = s.origins.filter((x) => x.from !== id && x.to !== id);
      next.blockers = s.blockers.filter((b) => b.nodeId !== id);
      next.messages = s.messages.filter((m) => m.nodeId !== id);
      break;
    }
    case 'edge.added':
      if (!s.edges.some((x) => x.from === e.edge.from && x.to === e.edge.to)) next.edges = [...s.edges, e.edge];
      break;
    case 'edge.removed':
      next.edges = s.edges.filter((x) => !(x.from === e.edge.from && x.to === e.edge.to));
      break;
    case 'origin.added': {
      // El primer origen que llega de un servidor con #90 deja de lado lo derivado: desde aquí los orígenes son reales.
      const list = s.origins ?? [];
      const i = list.findIndex((x) => x.from === e.origin.from && x.to === e.origin.to);
      next.origins = i < 0 ? [...list, e.origin] : list.map((x, j) => (j === i ? e.origin : x));
      break;
    }
    case 'origin.removed':
      next.origins = (s.origins ?? []).filter((x) => !(x.from === e.origin.from && x.to === e.origin.to));
      break;
    case 'blocker.opened':
    case 'blocker.resolved':
      next.blockers = upsert(s.blockers, e.blocker);
      break;
    case 'message.posted':
      if (!s.messages.some((m) => m.id === e.message.id)) next.messages = [...s.messages, e.message].slice(-MAX_MESSAGES);
      break;
  }
  return next;
}

/** Aplica una lista de eventos en orden. */
export function reduceAll(s: Snapshot, events: DagEvent[]): Snapshot {
  return events.reduce(reduce, s);
}

/** Inserta o reemplaza un bloqueante por id sin tocar el `seq` (respuesta directa de la API). */
export function upsertBlocker(s: Snapshot, b: Snapshot['blockers'][number]): Snapshot {
  return { ...s, blockers: upsert(s.blockers, b) };
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  return i < 0 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
}

function isFullNode(n: Partial<Snapshot['nodes'][number]>): boolean {
  return (
    typeof n.stageId === 'string' &&
    typeof n.title === 'string' &&
    typeof n.status === 'string' &&
    typeof n.progress === 'number'
  );
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
