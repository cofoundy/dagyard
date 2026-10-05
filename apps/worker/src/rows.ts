/** Filas de SQLite → tipos del contrato. */
import { DEFAULT_KIND, LANGS, LEGACY_LANG, demoLang, type Blocker, type BlockerResolution, type DagEvent, type DagEventType, type DagNode, type Edge, type Lang, type Message, type Origin, type Project, type Role, type Team } from '@dagyard/model';
import type { Row } from './db.js';

const s = (v: unknown) => v as string;
const ns = (v: unknown) => (v ?? null) as string | null;

export const toProject = (r: Row): Project => ({
  id: s(r.id),
  name: s(r.name),
  // NULL (guardado antes de #77) → el de la demo si es una (la inglesa antes de re-sembrarla), si no español
  lang: LANGS.includes(r.lang as Lang) ? (r.lang as Lang) : (demoLang(s(r.id)) ?? LEGACY_LANG),
  stages: JSON.parse(s(r.stages)),
  createdAt: s(r.created_at),
  updatedAt: s(r.updated_at),
});

export const toNode = (r: Row): DagNode => ({
  id: s(r.id),
  projectId: s(r.project_id),
  stage: s(r.stage),
  title: s(r.title),
  status: r.status as DagNode['status'],
  progress: Number(r.progress),
  team: ns(r.team),
  goal: ns(r.goal),
  reportUrl: ns(r.report_url),
  link: ns(r.link),
  // #75: siempre presentes (null si no se sabe); los pone el servidor en las transiciones de estado
  startedAt: ns(r.started_at),
  doneAt: ns(r.done_at),
  teamId: ns(r.team_id),
  // #90: siempre presentes
  kind: (r.kind as DagNode['kind']) ?? DEFAULT_KIND,
  bornAt: ns(r.born_at) ?? s(r.created_at),
  quote: ns(r.quote),
  quoteBy: ns(r.quote_by),
  closedAs: ns(r.closed_as) as DagNode['closedAs'],
  closedReason: ns(r.closed_reason),
  replacedBy: ns(r.replaced_by),
  closedAt: ns(r.closed_at),
  createdAt: s(r.created_at),
  updatedAt: s(r.updated_at),
});

export const toTeam = (r: Row): Team => ({
  id: s(r.id),
  projectId: s(r.project_id),
  name: s(r.name),
  nodeIds: JSON.parse(s(r.node_ids)) as string[],
  requestedAt: ns(r.requested_at),
  startedAt: ns(r.started_at),
  closedAt: ns(r.closed_at),
  outcome: ns(r.outcome),
  updatedAt: s(r.updated_at),
});

/** Orden de `ProjectSnapshot.teams`: por `startedAt`, los que no arrancaron al final (como `sortTeams` del modelo). */
export const TEAMS_ORDER = 'ORDER BY started_at IS NULL, started_at, rowid';

export const toEdge = (r: Row): Edge => ({ projectId: s(r.project_id), from: s(r.from_id), to: s(r.to_id) });

export const toOrigin = (r: Row): Origin => ({ projectId: s(r.project_id), from: s(r.from_id), to: s(r.to_id), why: ns(r.why), createdAt: s(r.created_at) });

/** Nunca lee `access_value`: el valor no sale por aquí. */
export const toBlocker = (r: Row): Blocker => ({
  id: s(r.id),
  projectId: s(r.project_id),
  nodeId: s(r.node_id),
  kind: r.kind as Blocker['kind'],
  question: s(r.question),
  options: JSON.parse(s(r.options)),
  accessLabel: ns(r.access_label),
  status: r.status as Blocker['status'],
  resolution: r.resolution ? (JSON.parse(s(r.resolution)) as BlockerResolution) : null,
  resolvedBy: ns(r.resolved_by) as Role | null,
  resolvedAt: ns(r.resolved_at),
  createdAt: s(r.created_at),
});

export const toMessage = (r: Row): Message => ({
  id: s(r.id),
  projectId: s(r.project_id),
  nodeId: s(r.node_id),
  from: s(r.from_name),
  text: s(r.text),
  reportUrl: ns(r.report_url),
  createdAt: s(r.created_at),
});

export const BLOCKER_COLS = 'id, project_id, node_id, kind, question, options, access_label, status, resolution, resolved_by, resolved_at, created_at';

export const toEvent = (r: Row): DagEvent =>
  ({
    seq: Number(r.seq),
    projectId: s(r.project_id),
    type: r.type as DagEventType,
    actor: r.actor as Role,
    at: s(r.at),
    payload: JSON.parse(s(r.payload)),
  }) as DagEvent;
