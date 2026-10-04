/**
 * Validación sin dependencias. Cada `parse*` recibe `unknown` (el body JSON) y devuelve
 * `{ ok: true, value }` normalizado o `{ ok: false, message }` en español, listo para un 400.
 */
import {
  BLOCKER_KINDS,
  LANGS,
  LIMITS,
  NODE_STATUSES,
  type BlockerInput,
  type BlockerKind,
  type IsoDate,
  type Lang,
  type MessageInput,
  type NodeInput,
  type NodePatch,
  type NodeStatus,
  type ProjectGraphInput,
  type ProjectInput,
  type ResolveInput,
  type StageInput,
} from './types.js';
import { findCycle } from './graph.js';

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * `PATCH /api/projects/:pid/nodes/:nid` (#75): además de `NodePatch`, `teamId` = el sitio de la fábrica que la
 * toma (o null para soltarla). `startedAt`/`doneAt` los pone el servidor; el cliente no los escribe.
 */
export type NodePatchInput = NodePatch & { teamId?: string | null };

/**
 * `PUT /api/projects/:pid/teams/:tid` (#75): upsert parcial. Lo que falta no se toca; `nodeIds` reemplaza la
 * lista entera. Las fechas llegan normalizadas a `toISOString()`, así el mismo instante escrito de otra forma
 * no cuenta como un cambio.
 */
export interface TeamPatch {
  name?: string;
  /** reemplaza la lista entera */
  nodeIds?: string[];
  /**
   * se suman (sin repetir) a la lista vigente DENTRO de la transacción: así dos escritores a la vez no se pisan.
   * `team start --issues` e `import-ledger` usan esto, nunca una lista leída antes.
   */
  addNodeIds?: string[];
  requestedAt?: IsoDate | null;
  startedAt?: IsoDate | null;
  closedAt?: IsoDate | null;
  outcome?: string | null;
}

/** Bloqueante del cuerpo de `PUT /api/projects/:id`; `createdAt` (#75) conserva la hora real de la pregunta al recrear. */
export type GraphBlockerInput = NonNullable<ProjectGraphInput['blockers']>[number] & { createdAt?: IsoDate };

/** Cuántas tareas lista un equipo como máximo, y cuánto puede decir su `outcome` (el ledger trae frases enteras). */
export const TEAM_LIMITS = {
  nodeIds: 50,
  outcome: LIMITS.note,
  perProject: LIMITS.nodesPerProject,
  /** una fecha de equipo anterior a esta es un error de quien escribe (la fábrica es de 2026) */
  earliest: '2020-01-01T00:00:00.000Z',
  /** cuánto al futuro tolera una fecha de equipo (relojes desfasados), en ms */
  future: 24 * 60 * 60 * 1000,
} as const;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):?(\d{2}))$/;

/**
 * `2026-10-04T05:35:20Z` → `2026-10-04T05:35:20.000Z`; null si no es una fecha ISO 8601 con hora y zona, o si no
 * existe en el calendario (V8 corre `2026-02-30` al 2 de marzo sin avisar).
 */
export function normalizeIso(v: unknown): IsoDate | null {
  if (typeof v !== 'string') return null;
  const m = ISO_RE.exec(v.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, se = '0', zh = '0', zm = '0'] = m.slice(1).map((x) => x ?? undefined) as string[];
  const days = new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate();
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > days) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(se) > 59 || Number(zh) > 23 || Number(zm) > 59) return null;
  const ms = Date.parse(v.trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** ¿El equipo cierra antes de arrancar? El mensaje del 400, o null. */
export function teamDatesProblem(t: { startedAt?: IsoDate | null; closedAt?: IsoDate | null }): string | null {
  return t.startedAt && t.closedAt && t.closedAt < t.startedAt ? `closedAt: el equipo no puede cerrar (${t.closedAt}) antes de arrancar (${t.startedAt})` : null;
}

/** «demo-viva» → «Demo viva»: el nombre de un equipo que llegó sin uno. */
export function teamNameFromSlug(slug: string): string {
  const s = slug.replace(/-+/g, ' ').trim();
  return (s.charAt(0).toUpperCase() + s.slice(1)).slice(0, LIMITS.name) || slug;
}

class Invalid extends Error {}
const fail = (message: string): never => {
  throw new Invalid(message);
};
const wrap = <T>(fn: () => T): Parsed<T> => {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, message: e.message };
    throw e;
  }
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isSlug(s: unknown): s is string {
  return typeof s === 'string' && s.length <= LIMITS.slug && SLUG_RE.test(s);
}

/** «Diseño del pago» → `diseno-del-pago`. Nunca devuelve vacío. */
export function slugify(text: string): string {
  const s = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.slug)
    .replace(/-+$/g, '');
  return s || 'x';
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`${what}: se esperaba un objeto`);
  return v as Record<string, unknown>;
}

function str(v: unknown, field: string, max: number, opts: { optional?: boolean } = {}): string | undefined {
  if (v === undefined && opts.optional) return undefined;
  if (typeof v !== 'string') return fail(`${field}: se esperaba texto`);
  const t = v.trim();
  if (!t) return fail(`${field}: no puede estar vacío`);
  if ([...t].length > max) return fail(`${field}: máximo ${max} caracteres`);
  return t;
}

function nullableStr(v: unknown, field: string, max: number): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return str(v, field, max);
}

function url(v: unknown, field: string): string | null | undefined {
  const s = nullableStr(v, field, LIMITS.url);
  if (s && !/^https?:\/\//i.test(s)) fail(`${field}: debe empezar con http:// o https://`);
  return s;
}

function slug(v: unknown, field: string, optional = false): string | undefined {
  if (v === undefined && optional) return undefined;
  if (!isSlug(v)) return fail(`${field}: usa minúsculas, números y guiones (máx. ${LIMITS.slug})`);
  return v;
}

function status(v: unknown): NodeStatus | undefined {
  if (v === undefined) return undefined;
  if (!NODE_STATUSES.includes(v as NodeStatus)) fail(`status: uno de ${NODE_STATUSES.join(', ')}`);
  return v as NodeStatus;
}

function progress(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) fail('progress: un número entre 0 y 1');
  return v as number;
}

function stringList(v: unknown, field: string, max: number, maxLen: number): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return fail(`${field}: se esperaba una lista`);
  if (v.length > max) return fail(`${field}: máximo ${max}`);
  return v.map((x, i) => str(x, `${field}[${i}]`, maxLen)!);
}

function isoDate(v: unknown, field: string): IsoDate | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return normalizeIso(v) ?? fail(`${field}: una fecha ISO 8601 con hora y zona, p. ej. 2026-10-04T05:35:20Z`);
}

function lang(v: unknown): Lang | undefined {
  if (v === undefined) return undefined;
  if (!LANGS.includes(v as Lang)) fail(`lang: uno de ${LANGS.join(', ')}`);
  return v as Lang;
}

function stages(v: unknown): StageInput[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0) return fail('stages: se esperaba una lista con al menos una etapa');
  if (v.length > 12) return fail('stages: máximo 12');
  const out = v.map((x, i): StageInput => {
    if (typeof x === 'string') return { name: str(x, `stages[${i}]`, LIMITS.name)! };
    const o = obj(x, `stages[${i}]`);
    const s: StageInput = { name: str(o.name, `stages[${i}].name`, LIMITS.name)! };
    const id = slug(o.id, `stages[${i}].id`, true);
    if (id) s.id = id;
    return s;
  });
  const ids = out.map((s) => s.id ?? slugify(s.name));
  if (new Set(ids).size !== ids.length) fail('stages: hay etapas repetidas');
  return out;
}

/* ------------------------------------------------------------------ parsers */

export function parseProjectInput(body: unknown): Parsed<ProjectInput> {
  return wrap(() => {
    const o = obj(body, 'body');
    const p: ProjectInput = { name: str(o.name, 'name', LIMITS.name)! };
    const id = slug(o.id, 'id', true);
    if (id) p.id = id;
    const l = lang(o.lang);
    if (l) p.lang = l;
    const st = stages(o.stages);
    if (st) p.stages = st;
    return p;
  });
}

function nodeInput(o: Record<string, unknown>, at: string): NodeInput {
  const n: NodeInput = {
    stage: slug(o.stage, `${at}stage`)!,
    title: str(o.title, `${at}title`, LIMITS.title)!,
  };
  const id = slug(o.id, `${at}id`, true);
  if (id) n.id = id;
  const s = status(o.status);
  if (s) n.status = s;
  const p = progress(o.progress);
  if (p !== undefined) n.progress = p;
  const team = nullableStr(o.team, `${at}team`, LIMITS.name);
  if (team !== undefined) n.team = team;
  const goal = nullableStr(o.goal, `${at}goal`, LIMITS.goal);
  if (goal !== undefined) n.goal = goal;
  const r = url(o.reportUrl, `${at}reportUrl`);
  if (r !== undefined) n.reportUrl = r;
  const l = url(o.link, `${at}link`);
  if (l !== undefined) n.link = l;
  if (o.deps !== undefined) {
    if (!Array.isArray(o.deps)) fail(`${at}deps: se esperaba una lista`);
    n.deps = (o.deps as unknown[]).map((d, i) => slug(d, `${at}deps[${i}]`)!);
  }
  return n;
}

export function parseNodeInput(body: unknown): Parsed<NodeInput> {
  return wrap(() => nodeInput(obj(body, 'body'), ''));
}

export function parseNodePatch(body: unknown): Parsed<NodePatchInput> {
  return wrap(() => {
    const o = obj(body, 'body');
    const allowed = ['stage', 'title', 'status', 'progress', 'team', 'goal', 'reportUrl', 'link', 'teamId'];
    const extra = Object.keys(o).filter((k) => !allowed.includes(k));
    if (extra.length) fail(`campos no editables: ${extra.join(', ')}`);
    const p: NodePatchInput = {};
    if (o.teamId !== undefined) p.teamId = o.teamId === null ? null : slug(o.teamId, 'teamId');
    if (o.stage !== undefined) p.stage = slug(o.stage, 'stage');
    if (o.title !== undefined) p.title = str(o.title, 'title', LIMITS.title);
    const s = status(o.status);
    if (s) p.status = s;
    const pr = progress(o.progress);
    if (pr !== undefined) p.progress = pr;
    const team = nullableStr(o.team, 'team', LIMITS.name);
    if (team !== undefined) p.team = team;
    const goal = nullableStr(o.goal, 'goal', LIMITS.goal);
    if (goal !== undefined) p.goal = goal;
    const r = url(o.reportUrl, 'reportUrl');
    if (r !== undefined) p.reportUrl = r;
    const l = url(o.link, 'link');
    if (l !== undefined) p.link = l;
    if (Object.keys(p).length === 0) fail('nada que actualizar');
    return p;
  });
}

function blockerInput(o: Record<string, unknown>, at: string): BlockerInput {
  if (!BLOCKER_KINDS.includes(o.kind as BlockerKind)) fail(`${at}kind: uno de ${BLOCKER_KINDS.join(', ')}`);
  const kind = o.kind as BlockerKind;
  const b: BlockerInput = { kind, question: str(o.question, `${at}question`, LIMITS.question)! };
  const options = stringList(o.options, `${at}options`, LIMITS.options, LIMITS.option);
  if (kind === 'access') {
    if (options && options.length) fail(`${at}options: un acceso no lleva opciones`);
    b.options = [];
    b.accessLabel = str(o.accessLabel, `${at}accessLabel`, LIMITS.name)!;
  } else {
    // una revisión sin opciones explícitas recibe las del idioma del proyecto: las pone el servidor (#77)
    if (options && options.length) b.options = options;
    else if (kind !== 'review') fail(`${at}options: una decisión necesita al menos una opción`);
    b.accessLabel = null;
  }
  return b;
}

export function parseBlockerInput(body: unknown): Parsed<BlockerInput> {
  return wrap(() => blockerInput(obj(body, 'body'), ''));
}

/**
 * Valida una resolución contra el bloqueante que resuelve. Devuelve la opción ya
 * normalizada a su texto (`choice`) o el valor del acceso.
 */
export function parseResolveInput(
  body: unknown,
  blocker: { kind: BlockerKind; options: string[] },
): Parsed<{ choice: string | null; value: string | null; note: string | null }> {
  return wrap(() => {
    const o = obj(body, 'body') as ResolveInput & Record<string, unknown>;
    const note = nullableStr(o.note, 'note', LIMITS.note) ?? null;
    if (blocker.kind === 'access') {
      if (typeof o.value !== 'string' || !o.value.trim()) fail('value: pega el valor del acceso');
      if ((o.value as string).length > LIMITS.accessValue) fail(`value: máximo ${LIMITS.accessValue} caracteres`);
      return { choice: null, value: o.value as string, note };
    }
    let choice: string | undefined;
    if (typeof o.choice === 'number' && Number.isInteger(o.choice)) choice = blocker.options[o.choice];
    else if (typeof o.choice === 'string') choice = blocker.options.find((x) => x === (o.choice as string).trim());
    if (choice === undefined) fail(`choice: el índice o el texto de una opción (${blocker.options.join(' | ')})`);
    return { choice: choice!, value: null, note };
  });
}

function messageInput(o: Record<string, unknown>, at: string): MessageInput {
  const m: MessageInput = { text: str(o.text, `${at}text`, LIMITS.message)! };
  const from = str(o.from, `${at}from`, LIMITS.name, { optional: true });
  if (from) m.from = from;
  const r = url(o.reportUrl, `${at}reportUrl`);
  if (r !== undefined) m.reportUrl = r;
  return m;
}

export function parseMessageInput(body: unknown): Parsed<MessageInput> {
  return wrap(() => messageInput(obj(body, 'body'), ''));
}

/** `PUT /api/projects/:id`: valida el grafo completo, incluidas referencias y ciclos. */
export function parseProjectGraphInput(body: unknown): Parsed<ProjectGraphInput> {
  return wrap(() => {
    const o = obj(body, 'body');
    const g: ProjectGraphInput = { name: str(o.name, 'name', LIMITS.name)!, nodes: [] };
    const l = lang(o.lang);
    if (l) g.lang = l;
    const st = stages(o.stages);
    if (st) g.stages = st;
    if (!Array.isArray(o.nodes)) fail('nodes: se esperaba una lista');
    const raw = o.nodes as unknown[];
    if (raw.length > LIMITS.nodesPerProject) fail(`nodes: máximo ${LIMITS.nodesPerProject}`);
    g.nodes = raw.map((x, i) => nodeInput(obj(x, `nodes[${i}]`), `nodes[${i}].`));
    if (o.blockers !== undefined) {
      if (!Array.isArray(o.blockers)) fail('blockers: se esperaba una lista');
      g.blockers = (o.blockers as unknown[]).map((x, i): GraphBlockerInput => {
        const bo = obj(x, `blockers[${i}]`);
        const b: GraphBlockerInput = { ...blockerInput(bo, `blockers[${i}].`), nodeId: slug(bo.nodeId, `blockers[${i}].nodeId`)! };
        if (bo.createdAt !== undefined) b.createdAt = isoDate(bo.createdAt, `blockers[${i}].createdAt`)!;
        return b;
      });
    }
    if (o.messages !== undefined) {
      if (!Array.isArray(o.messages)) fail('messages: se esperaba una lista');
      g.messages = (o.messages as unknown[]).map((x, i) => {
        const mo = obj(x, `messages[${i}]`);
        return { ...messageInput(mo, `messages[${i}].`), nodeId: slug(mo.nodeId, `messages[${i}].nodeId`)! };
      });
    }
    const problem = checkGraph(g);
    if (problem) fail(problem);
    return g;
  });
}

/** `PUT /api/projects/:pid/teams/:tid` (#75): valida el upsert parcial de un equipo. `{}` vale (crea uno vacío). */
export function parseTeamPatch(body: unknown): Parsed<TeamPatch> {
  return wrap(() => {
    const o = obj(body, 'body');
    const allowed = ['name', 'nodeIds', 'addNodeIds', 'requestedAt', 'startedAt', 'closedAt', 'outcome'];
    const extra = Object.keys(o).filter((k) => !allowed.includes(k));
    if (extra.length) fail(`campos no editables: ${extra.join(', ')}`);
    const p: TeamPatch = {};
    const name = str(o.name, 'name', LIMITS.name, { optional: true });
    if (name !== undefined) p.name = name;
    for (const k of ['nodeIds', 'addNodeIds'] as const) {
      if (o[k] === undefined) continue;
      if (!Array.isArray(o[k])) fail(`${k}: se esperaba una lista`);
      const ids = [...new Set((o[k] as unknown[]).map((x, i) => slug(x, `${k}[${i}]`)!))];
      if (ids.length > TEAM_LIMITS.nodeIds) fail(`${k}: máximo ${TEAM_LIMITS.nodeIds}`);
      p[k] = ids;
    }
    const latest = new Date(Date.now() + TEAM_LIMITS.future).toISOString();
    for (const k of ['requestedAt', 'startedAt', 'closedAt'] as const) {
      const d = isoDate(o[k], k);
      if (d && (d < TEAM_LIMITS.earliest || d > latest)) fail(`${k}: fuera de rango (desde 2020 hasta mañana): ${d}`);
      if (d !== undefined) p[k] = d;
    }
    const problem = teamDatesProblem(p);
    if (problem) fail(problem);
    const outcome = nullableStr(o.outcome, 'outcome', TEAM_LIMITS.outcome);
    if (outcome !== undefined) p.outcome = outcome;
    return p;
  });
}

/** Resuelve ids y etapas de un ProjectGraphInput y devuelve el primer problema, o null. */
export function checkGraph(g: ProjectGraphInput): string | null {
  const stageIds = new Set((g.stages ?? []).map((s) => s.id ?? slugify(s.name)));
  const ids = g.nodes.map((n) => n.id ?? slugify(n.title));
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return `nodes: id repetido «${id}»`;
    seen.add(id);
  }
  for (const [i, n] of g.nodes.entries()) {
    if (g.stages && !stageIds.has(n.stage)) return `nodes[${i}].stage: «${n.stage}» no es una etapa del proyecto`;
    for (const d of n.deps ?? []) if (!seen.has(d)) return `nodes[${i}].deps: «${d}» no existe`;
  }
  for (const [i, b] of (g.blockers ?? []).entries()) if (!seen.has(b.nodeId)) return `blockers[${i}].nodeId: «${b.nodeId}» no existe`;
  for (const [i, m] of (g.messages ?? []).entries()) if (!seen.has(m.nodeId)) return `messages[${i}].nodeId: «${m.nodeId}» no existe`;
  const edges = g.nodes.flatMap((n, i) => (n.deps ?? []).map((d) => ({ from: d, to: ids[i]! })));
  const cyc = findCycle(ids, edges);
  if (cyc) return `ciclo en las dependencias: ${cyc.join(' → ')}`;
  return null;
}

