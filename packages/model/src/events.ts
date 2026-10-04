/**
 * Tiempo real: el formato de los mensajes del WebSocket y el reductor que aplica un evento a un
 * snapshot. La UI hace `snapshot = applyEvent(snapshot, ev)` por cada evento; si `needsRefetch`,
 * vuelve a pedir `GET /api/projects/:id`.
 */
import type { DagEvent, ProjectSnapshot, Team } from './types.js';

/** Servidor → cliente. */
export type ServerFrame =
  /** primer frame tras conectar: el seq actual del proyecto */
  | { type: 'hello'; projectId: string; seq: number }
  /** un evento nuevo (o uno de la recuperación si conectaste con `?since=`) */
  | { type: 'event'; event: DagEvent }
  /** el `since` pedido es demasiado viejo: vuelve a pedir el snapshot */
  | { type: 'resync'; seq: number }
  | { type: 'pong' };

/** Cliente → servidor. Opcional: el servidor también responde `ping` en texto plano con `pong`. */
export type ClientFrame = { type: 'ping' };

export const MESSAGES_IN_SNAPSHOT = 200;

/**
 * Orden de `ProjectSnapshot.teams` (#75): por `startedAt`, los que no arrancaron al final; a igualdad, como
 * llegaron (sort estable). Devuelve una lista nueva.
 */
export function sortTeams(teams: readonly Team[]): Team[] {
  return [...teams].sort((a, b) => (a.startedAt === b.startedAt ? 0 : a.startedAt === null ? 1 : b.startedAt === null ? -1 : a.startedAt < b.startedAt ? -1 : 1));
}

/** ¿Este evento exige recargar el snapshot entero? */
export function needsRefetch(ev: DagEvent): boolean {
  return ev.type === 'project.replaced';
}

/**
 * Aplica un evento a un snapshot y devuelve uno nuevo (no muta). Idempotente: ignora eventos con
 * `seq <= snapshot.seq`. `project.replaced` solo actualiza el proyecto y el seq; llama a
 * `needsRefetch` para saber cuándo recargar.
 */
export function applyEvent(s: ProjectSnapshot, ev: DagEvent): ProjectSnapshot {
  if (ev.projectId !== s.project.id || ev.seq <= s.seq) return s;
  const next: ProjectSnapshot = { ...s, seq: ev.seq };
  switch (ev.type) {
    case 'project.replaced':
    case 'project.updated':
      next.project = ev.payload.project;
      break;
    case 'node.added':
    case 'node.updated': {
      const n = ev.payload.node;
      const i = s.nodes.findIndex((x) => x.id === n.id);
      next.nodes = i < 0 ? [...s.nodes, n] : s.nodes.map((x, j) => (j === i ? n : x));
      break;
    }
    case 'node.removed': {
      const id = ev.payload.nodeId;
      next.nodes = s.nodes.filter((x) => x.id !== id);
      next.edges = s.edges.filter((e) => e.from !== id && e.to !== id);
      next.blockers = s.blockers.filter((b) => b.nodeId !== id);
      next.messages = s.messages.filter((m) => m.nodeId !== id);
      break;
    }
    case 'edge.added': {
      const e = ev.payload.edge;
      if (!s.edges.some((x) => x.from === e.from && x.to === e.to)) next.edges = [...s.edges, e];
      break;
    }
    case 'edge.removed': {
      const e = ev.payload.edge;
      next.edges = s.edges.filter((x) => !(x.from === e.from && x.to === e.to));
      break;
    }
    case 'blocker.opened':
    case 'blocker.resolved': {
      const b = ev.payload.blocker;
      const i = s.blockers.findIndex((x) => x.id === b.id);
      next.blockers = i < 0 ? [...s.blockers, b] : s.blockers.map((x, j) => (j === i ? b : x));
      break;
    }
    case 'message.posted': {
      const m = ev.payload.message;
      if (!s.messages.some((x) => x.id === m.id)) next.messages = [...s.messages, m].slice(-MESSAGES_IN_SNAPSHOT);
      break;
    }
    case 'team.updated': {
      const t = ev.payload.team;
      const teams = s.teams ?? [];
      const i = teams.findIndex((x) => x.id === t.id);
      next.teams = sortTeams(i < 0 ? [...teams, t] : teams.map((x, j) => (j === i ? t : x)));
      break;
    }
  }
  return next;
}
