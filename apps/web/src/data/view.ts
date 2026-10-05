// Selectores puros sobre el snapshot y el DAG: lo que la escena y la interfaz leen.

import type { SceneGraph } from '../scene/contract';
import type { DagModel } from './dag';
import type { Blocker, DagNode, Message, Snapshot } from './types';

/** El DAG en la forma que dibuja la escena. */
export function toSceneGraph(m: DagModel, activity?: number[]): SceneGraph {
  return {
    nodes: m.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      kind: t.kind,
      born: t.born,
      closedAs: t.closedAs,
      loose: t.loose,
      parent: t.origins[0]?.from ?? null,
      children: [...t.children],
    })),
    edges: m.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
    now: m.now,
    activity,
  };
}

/** Momentos con actividad del proyecto (mensajes y respuestas): el eje no los pliega como silencio. */
export function activityOf(s: Snapshot): number[] {
  const out: number[] = [];
  for (const m of s.messages) {
    const t = Date.parse(m.at);
    if (Number.isFinite(t)) out.push(t);
  }
  for (const b of s.blockers) {
    const t = b.resolvedAt ? Date.parse(b.resolvedAt) : NaN;
    if (Number.isFinite(t)) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

export const EMPTY_GRAPH: SceneGraph = { nodes: [], edges: [], now: 0 };

export function isOpen(b: Blocker): boolean {
  return !b.resolvedAt;
}

/** Pedidos abiertos de tareas que existen, en el orden del snapshot. */
export function openBlockers(s: Snapshot): Blocker[] {
  const order = new Map(s.nodes.map((n, i) => [n.id, i]));
  return s.blockers.filter((b) => isOpen(b) && order.has(b.nodeId)).sort((a, b) => order.get(a.nodeId)! - order.get(b.nodeId)!);
}

export function openBlockerOf(s: Snapshot, nodeId: string): Blocker | undefined {
  return s.blockers.find((b) => b.nodeId === nodeId && isOpen(b));
}

export function resolvedBlockersOf(s: Snapshot, nodeId: string): Blocker[] {
  return s.blockers
    .filter((b) => b.nodeId === nodeId && !isOpen(b))
    .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));
}

/** Mensajes de una tarea, del más nuevo al más viejo. */
export function messagesOf(s: Snapshot, nodeId: string): Message[] {
  return s.messages.filter((m) => m.nodeId === nodeId).reverse();
}

export function nodeById(s: Snapshot, id: string | null | undefined): DagNode | undefined {
  return id ? s.nodes.find((n) => n.id === id) : undefined;
}
