// Único punto de traducción entre el cable del servidor (`@dagyard/model`, docs/api.md de nucleo) y el
// modelo de la UI (`./types`). Los tipos del cable vienen del paquete, no de copias: si el servidor cambia
// su contrato, el typecheck de la web se rompe aquí. La UI y la escena siguen consumiendo `./types`.

import type {
  Blocker as WireBlocker,
  DagEvent as WireEvent,
  DagNode as WireNode,
  Edge as WireEdge,
  Message as WireMessage,
  Origin as WireOrigin,
  ProjectSnapshot as WireSnapshot,
  ProjectSummary as WireProjectSummary,
  ResolveInput as WireResolveInput,
  ServerFrame as WireServerFrame,
  Stage as WireStage,
} from '@dagyard/model';
import { REVIEW_OPTIONS } from '@dagyard/model';
import type { Blocker, DagEvent, DagNode, Edge, Message, Origin, ProjectSummary, Resolution, Snapshot, Stage } from './types';
import { t } from '../i18n';

export type {
  WireBlocker,
  WireEdge,
  WireEvent,
  WireMessage,
  WireNode,
  WireOrigin,
  WireProjectSummary,
  WireResolveInput,
  WireServerFrame,
  WireSnapshot,
  WireStage,
};

/* ------------------------------------------------------------------ cable → UI */

const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);

export function toStage(s: WireStage): Stage {
  return { id: s.id, name: s.name };
}

export function toNode(n: WireNode): DagNode {
  return {
    id: n.id,
    stageId: n.stage,
    title: n.title,
    status: n.status,
    progress: clamp01(n.progress),
    team: opt(n.team),
    goal: opt(n.goal),
    reportUrl: opt(n.reportUrl),
    link: opt(n.link),
    // #90: tipo, nacimiento, cita y cierre con motivo. Un servidor anterior no los manda: es una tarea nacida al crearse
    kind: n.kind ?? 'task',
    bornAt: n.bornAt ?? n.createdAt,
    quote: opt(n.quote),
    quoteBy: opt(n.quoteBy),
    closedAs: opt(n.closedAs),
    closedReason: opt(n.closedReason),
    replacedBy: opt(n.replacedBy),
    closedAt: opt(n.closedAt),
    updatedAt: opt(n.updatedAt),
    startedAt: opt(n.startedAt),
  };
}

/** «Nació de» (#90), con su porqué tal como lo escribieron. */
export function toOrigin(o: Pick<WireOrigin, 'from' | 'to'> & { why?: string | null }): Origin {
  return o.why ? { from: o.from, to: o.to, why: o.why } : { from: o.from, to: o.to };
}

export function toEdge(e: WireEdge): Edge {
  return { from: e.from, to: e.to };
}

/**
 * Las opciones que el servidor pone a una revisión que no trae las suyas, en el idioma del proyecto (`REVIEW_OPTIONS`
 * de `@dagyard/model`, #77). Son datos del cable, no texto de la interfaz: la UI las reconoce en cualquiera de los
 * dos idiomas y las pinta en el suyo (`reviewLabels`). Esta es la de un proyecto guardado sin idioma.
 */
export const DEFAULT_REVIEW_OPTIONS: readonly [string, string] = ['Aprobar', 'Pedir cambios'];

/** ¿Son las opciones por defecto de una revisión, en cualquier idioma? */
export function isDefaultReviewOptions(options: readonly string[]): boolean {
  return Object.values(REVIEW_OPTIONS).some((d) => options.length === d.length && options.every((o, i) => o === d[i]));
}

/** Quién resolvió un pedido: centinelas sin texto; la UI los traduce al pintar. Otro valor es un nombre, tal cual. */
export const RESOLVED_BY_YOU = 'you';
export const RESOLVED_BY_AGENT = 'agent';
/** El centinela de antes de #73; el fixture ya usa `RESOLVED_BY_YOU` (#83). Queda por datos viejos. */
const LEGACY_YOU = 'Tú';

export function isResolvedByYou(by: string | undefined): boolean {
  return by === RESOLVED_BY_YOU || by === LEGACY_YOU;
}

/** Resumen legible de una resolución, en el idioma actual. Nunca incluye el valor de un acceso. */
export function resolutionSummary(b: Pick<WireBlocker, 'kind' | 'options' | 'resolution'>): string {
  const r = b.resolution;
  if (!r) return '';
  if (b.kind === 'access') return t('resolution.access');
  if (b.kind === 'review') {
    const approved = r.choice !== null && r.choice === (b.options[0] ?? DEFAULT_REVIEW_OPTIONS[0]);
    if (approved) return r.note ? t('resolution.approvedNote', { note: r.note }) : t('resolution.approved');
    return r.note ? t('resolution.changesNote', { note: r.note }) : t('resolution.changes');
  }
  if (!r.choice) return t('resolution.decided');
  return r.note ? t('resolution.choiceNote', { choice: r.choice, note: r.note }) : t('resolution.choice', { choice: r.choice });
}

export function toBlocker(b: WireBlocker): Blocker {
  const resolved = b.status === 'resolved';
  return {
    id: b.id,
    nodeId: b.nodeId,
    kind: b.kind,
    question: b.question,
    options: b.kind === 'access' ? [] : b.options.length ? b.options : b.kind === 'review' ? [...DEFAULT_REVIEW_OPTIONS] : [],
    label: b.kind === 'access' ? opt(b.accessLabel) : undefined,
    resolution: resolved ? resolutionSummary(b) : undefined,
    resolvedBy: resolved ? (b.resolvedBy === 'agent' ? RESOLVED_BY_AGENT : RESOLVED_BY_YOU) : undefined,
    resolvedAt: resolved ? opt(b.resolvedAt) ?? new Date(0).toISOString() : undefined,
  };
}

export function toMessage(m: WireMessage): Message {
  return { id: m.id, nodeId: m.nodeId, from: m.from, text: m.text, reportUrl: opt(m.reportUrl), at: m.createdAt };
}

export function toSnapshot(w: WireSnapshot): Snapshot {
  return {
    project: { id: w.project.id, name: w.project.name },
    stages: w.project.stages.map(toStage),
    nodes: w.nodes.map(toNode),
    edges: w.edges.map(toEdge),
    // sin el campo (servidor anterior a #90) la vista los deduce de las dependencias
    origins: w.origins?.map(toOrigin),
    blockers: w.blockers.map(toBlocker),
    messages: w.messages.map(toMessage),
    seq: w.seq,
  };
}

export function toProjectSummary(p: WireProjectSummary): ProjectSummary {
  return { id: p.id, name: p.name };
}

/**
 * Traduce un evento del cable. `null` = el evento no existe en el modelo de la UI y obliga a recargar el
 * snapshot (`project.replaced`, `project.updated`: cambian etapas o nombre).
 */
export function toEvent(e: WireEvent): DagEvent | null {
  switch (e.type) {
    case 'node.added':
      return { seq: e.seq, type: 'node.added', node: toNode(e.payload.node) };
    case 'node.updated':
      return { seq: e.seq, type: 'node.updated', node: toNode(e.payload.node) };
    case 'node.removed':
      return { seq: e.seq, type: 'node.removed', nodeId: e.payload.nodeId };
    case 'edge.added':
      return { seq: e.seq, type: 'edge.added', edge: toEdge(e.payload.edge) };
    case 'edge.removed':
      return { seq: e.seq, type: 'edge.removed', edge: toEdge(e.payload.edge) };
    case 'blocker.opened':
      return { seq: e.seq, type: 'blocker.opened', blocker: toBlocker(e.payload.blocker) };
    case 'blocker.resolved':
      return { seq: e.seq, type: 'blocker.resolved', blocker: toBlocker(e.payload.blocker) };
    case 'message.posted':
      return { seq: e.seq, type: 'message.posted', message: toMessage(e.payload.message) };
    case 'project.replaced':
    case 'project.updated':
    case 'team.updated': // #75: hasta que la UI tenga equipos, recarga el snapshot
      return null;
    case 'origin.added':
      return { seq: e.seq, type: 'origin.added', origin: toOrigin(e.payload.origin) };
    case 'origin.removed':
      return { seq: e.seq, type: 'origin.removed', origin: { from: e.payload.origin.from, to: e.payload.origin.to } };
  }
}

/* ------------------------------------------------------------------ UI → cable */

export function toResolveInput(r: Resolution): WireResolveInput {
  switch (r.kind) {
    case 'decision':
      return { choice: r.option };
    case 'review':
      // Las opciones de una revisión son [Aprobar, Pedir cambios] por defecto: se manda el índice.
      return { choice: r.verdict === 'approve' ? 0 : 1, note: r.comment?.trim() ? r.comment.trim() : null };
    case 'access':
      return { value: r.value };
  }
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}
