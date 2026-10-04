/**
 * Las escrituras de Dagyard. Cada una corre ENTERA dentro de una transacción del DO `Store`
 * (`transactionSync`): lee el estado actual, valida contra él, escribe y asigna el `seq` de sus
 * eventos sin soltar el hilo. Así no hay chequeo-y-escritura separados por otra RPC: una carrera no
 * puede resolver dos veces, cerrar un ciclo, duplicar un id ni reescribir un estado desde uno viejo.
 * Un `ApiFailure` lanzado aquí revierte la transacción entera (no queda ni la escritura ni sus eventos).
 */
import {
  DEFAULT_LANG,
  REVIEW_OPTIONS,
  TEAM_LIMITS,
  defaultStages,
  LIMITS,
  demoLang,
  demoProject,
  demoPulse,
  demoSignature,
  slugify,
  teamDatesProblem,
  teamNameFromSlug,
  wouldCreateCycle,
  type Blocker,
  type BlockerInput,
  type DagEvent,
  type DagEventType,
  type DagNode,
  type Edge,
  type Lang,
  type Message,
  type MessageInput,
  type NodeInput,
  type NodePatchInput,
  type Project,
  type ProjectGraphInput,
  type PulseState,
  type PulseStep,
  type Role,
  type Stage,
  type StageInput,
  type Team,
  type TeamPatch,
} from '@dagyard/model';
import { randomId } from './crypto.js';
import type { Row } from './db.js';
import { fail, notFound } from './http.js';
import { toBlocker, toEdge, toNode, toProject, toTeam } from './rows.js';

export type EventSpec = { [K in DagEventType]: { type: K; payload: Extract<DagEvent, { type: K }>['payload'] } }[DagEventType];

/** Lo que el Worker le pide al Store. Todo viene ya validado en forma por `@dagyard/model`. */
export type WriteOp =
  | { kind: 'createProject'; pid: string; name: string; lang?: Lang; stages?: StageInput[] }
  /** `exclusive` (`If-None-Match: *`): solo crea; si el proyecto ya existe, `409` sin tocarlo */
  | { kind: 'replaceGraph'; pid: string; graph: ProjectGraphInput; actor: Role; exclusive?: boolean }
  | { kind: 'patchProject'; pid: string; name?: string; lang?: Lang; stages?: StageInput[]; actor: Role }
  | { kind: 'deleteProject'; pid: string }
  | { kind: 'addNode'; pid: string; input: NodeInput; actor: Role }
  | { kind: 'patchNode'; pid: string; nid: string; patch: NodePatchInput; actor: Role }
  | { kind: 'removeNode'; pid: string; nid: string; actor: Role }
  | { kind: 'addEdge'; pid: string; from: string; to: string; actor: Role }
  | { kind: 'removeEdge'; pid: string; from: string; to: string; actor: Role }
  | { kind: 'openBlocker'; pid: string; nid: string; input: BlockerInput; actor: Role }
  | {
      kind: 'resolveBlocker';
      pid: string;
      bid: string;
      /** el kind contra el que el Worker validó (y cifró): si no coincide, se rechaza */
      expectKind: Blocker['kind'];
      choice: string | null;
      note: string | null;
      /** valor del acceso ya cifrado (AES-GCM, AAD = pid/bid) o null */
      sealed: string | null;
    }
  | { kind: 'postMessage'; pid: string; nid: string; input: MessageInput; actor: Role }
  /** upsert parcial de un equipo de la fábrica (#75): sin cambios, ni escribe ni emite */
  | { kind: 'putTeam'; pid: string; tid: string; patch: TeamPatch; actor: Role }
  /** un latido del pulso de la demo (#74): decide y aplica UN paso en la misma transacción. Solo ids demo */
  | { kind: 'demoBeat'; pid: string }
  /**
   * la demo vuelve a empezar: replaceGraph del dueño y poda de eventos hasta `max seq − keep` (keep ≥ 1). Solo ids
   * demo, y solo si sigue sin nada que avanzar (si no, `false` sin escribir)
   */
  | { kind: 'demoReseed'; pid: string; keep: number };

export interface WriteValues {
  createProject: Project;
  replaceGraph: null;
  patchProject: Project;
  deleteProject: null;
  addNode: DagNode;
  patchNode: DagNode;
  removeNode: null;
  addEdge: Edge;
  removeEdge: null;
  openBlocker: Blocker;
  resolveBlocker: Blocker;
  postMessage: Message;
  putTeam: Team;
  demoBeat: PulseStep;
  demoReseed: boolean;
}

export type WriteResult =
  | { ok: true; value: WriteValues[keyof WriteValues]; events: DagEvent[]; incarnation: string | null }
  | { ok: false; error: { code: Parameters<typeof fail>[0]; message: string } };

const RESUME_TEXT = 'Gracias. Sigo desde donde me quedé.';
const RESUME_TEXT_EN = 'Thanks. Picking up where I left off.';
/** Firma de un mensaje sin `from`, en el idioma del proyecto (#77). */
const signature = (n: Pick<DagNode, 'team'>, lang: Lang) =>
  lang === 'en' ? (n.team ? `${n.team} team` : 'Agent') : n.team ? `Equipo de ${n.team}` : 'Agente';
const NOT_DEMO = 'El pulso es solo de la demo';

/** Lo que el pulso necesita del grafo vigente, leído dentro de la transacción. */
function pulseState(tx: Tx, pid: string): PulseState {
  return {
    nodes: tx.all('SELECT * FROM nodes WHERE project_id = ? ORDER BY created_at, rowid', pid).map(toNode),
    edges: tx.edges(pid),
    blockers: tx.all('SELECT node_id, status FROM blockers WHERE project_id = ?', pid).map((r) => ({
      nodeId: r.node_id as string,
      status: r.status as Blocker['status'],
    })),
  };
}
const toStages = (input: StageInput[] | undefined, lang: Lang): Stage[] =>
  (input ?? defaultStages(lang)).map((s) => ({ id: s.id ?? slugify(s.name), name: s.name }));

type V = string | number | null;

/** SQL sincrónico dentro de la transacción. */
class Tx {
  readonly events: DagEvent[] = [];
  constructor(
    private readonly sql: SqlStorage,
    readonly now: string,
  ) {}

  all(q: string, ...p: V[]): Row[] {
    return this.sql.exec(q, ...p).toArray() as Row[];
  }
  one(q: string, ...p: V[]): Row | null {
    return this.all(q, ...p)[0] ?? null;
  }

  project(pid: string): Project {
    const r = this.one('SELECT * FROM projects WHERE id = ?', pid);
    return r ? toProject(r) : notFound(`El proyecto «${pid}»`);
  }
  node(pid: string, nid: string): DagNode {
    const r = this.one('SELECT * FROM nodes WHERE project_id = ? AND id = ?', pid, nid);
    return r ? toNode(r) : notFound(`La tarea «${nid}»`);
  }
  nodeIds(pid: string): Set<string> {
    return new Set(this.all('SELECT id FROM nodes WHERE project_id = ?', pid).map((r) => r.id as string));
  }
  edges(pid: string): Edge[] {
    return this.all('SELECT * FROM edges WHERE project_id = ? ORDER BY rowid', pid).map(toEdge);
  }
  openBlockers(pid: string, nid: string): number {
    return Number(this.one("SELECT COUNT(*) AS n FROM blockers WHERE project_id = ? AND node_id = ? AND status = 'open'", pid, nid)!.n);
  }
  /** Bloqueantes de la tarea, abiertos y ya respondidos: lo que un agente no puede hacer desaparecer. */
  heldBlockers(pid: string, nid: string): { open: number; resolved: number } {
    const r = this.one(
      "SELECT COUNT(*) FILTER (WHERE status = 'open') AS open, COUNT(*) FILTER (WHERE status = 'resolved') AS resolved FROM blockers WHERE project_id = ? AND node_id = ?",
      pid, nid,
    )!;
    return { open: Number(r.open), resolved: Number(r.resolved) };
  }

  insertNode(n: DagNode): void {
    this.all(
      `INSERT INTO nodes (project_id, id, stage, title, status, progress, team, goal, report_url, link, started_at, done_at, team_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      n.projectId, n.id, n.stage, n.title, n.status, n.progress, n.team, n.goal, n.reportUrl, n.link,
      n.startedAt ?? null, n.doneAt ?? null, n.teamId ?? null, n.createdAt, n.updatedAt,
    );
  }
  insertEdge(e: Edge): void {
    this.all('INSERT INTO edges (project_id, from_id, to_id) VALUES (?, ?, ?)', e.projectId, e.from, e.to);
  }
  insertBlocker(b: Blocker): void {
    this.all(
      `INSERT INTO blockers (id, project_id, node_id, kind, question, options, access_label, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      b.id, b.projectId, b.nodeId, b.kind, b.question, JSON.stringify(b.options), b.accessLabel, b.createdAt,
    );
  }
  /** Reinserta un bloqueante tal cual estaba: id, respuesta y valor cifrado incluidos. */
  restoreBlocker(r: Row): void {
    const cols = ['id', 'project_id', 'node_id', 'kind', 'question', 'options', 'access_label', 'status', 'resolution', 'resolved_by', 'resolved_at', 'access_value', 'created_at'];
    this.all(`INSERT INTO blockers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => r[c] as V));
  }
  /** Reinserta un mensaje tal cual estaba: id, firma y fecha incluidos. */
  restoreMessage(r: Row): void {
    const cols = ['id', 'project_id', 'node_id', 'from_name', 'text', 'report_url', 'created_at'];
    this.all(`INSERT INTO messages (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => r[c] as V));
  }
  insertMessage(m: Message): void {
    this.all(
      'INSERT INTO messages (id, project_id, node_id, from_name, text, report_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      m.id, m.projectId, m.nodeId, m.from, m.text, m.reportUrl, m.createdAt,
    );
  }
  /**
   * Actualiza solo las columnas pedidas y devuelve el nodo tal como quedó. Si cambia `status`, aplica los tiempos
   * del servidor (#75), por cualquier camino que llegue (PATCH, bloqueante, respuesta, pulso de la demo):
   * `started_at` = la primera vez en `working`; `done_at` = al llegar a `done` (si ya lo estaba, se queda) y null
   * al dejarlo. En el SET de SQLite, `status` y `done_at` del lado derecho son los valores de antes.
   */
  updateNode(pid: string, nid: string, cols: Partial<Record<'stage' | 'title' | 'status' | 'progress' | 'team' | 'goal' | 'report_url' | 'link' | 'team_id', V>>, where = ''): DagNode | null {
    const keys = Object.keys(cols) as Array<keyof typeof cols>;
    const sets = [...keys.map((k) => `${k} = ?`), 'updated_at = ?'];
    const params: V[] = [...keys.map((k) => cols[k] as V), this.now];
    if (cols.status !== undefined) {
      sets.push(
        "started_at = CASE WHEN ? = 'working' AND started_at IS NULL THEN ? ELSE started_at END",
        "done_at = CASE WHEN ? <> 'done' THEN NULL WHEN status = 'done' AND done_at IS NOT NULL THEN done_at ELSE ? END",
      );
      params.push(cols.status, this.now, cols.status, this.now);
    }
    const r = this.one(`UPDATE nodes SET ${sets.join(', ')} WHERE project_id = ? AND id = ? ${where} RETURNING *`, ...params, pid, nid);
    return r ? toNode(r) : null;
  }

  team(pid: string, tid: string): Team | null {
    const r = this.one('SELECT * FROM teams WHERE project_id = ? AND id = ?', pid, tid);
    return r ? toTeam(r) : null;
  }
  /** Inserta o reescribe un equipo entero. */
  saveTeam(t: Team): void {
    this.all(
      `INSERT INTO teams (project_id, id, name, node_ids, requested_at, started_at, closed_at, outcome, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, id) DO UPDATE SET name = excluded.name, node_ids = excluded.node_ids,
         requested_at = excluded.requested_at, started_at = excluded.started_at, closed_at = excluded.closed_at,
         outcome = excluded.outcome, updated_at = excluded.updated_at`,
      t.projectId, t.id, t.name, JSON.stringify(t.nodeIds), t.requestedAt, t.startedAt, t.closedAt, t.outcome, t.updatedAt,
    );
  }
  /** ¿Cabe un equipo nuevo en el proyecto? */
  teamRoom(pid: string): boolean {
    return Number(this.one('SELECT COUNT(*) AS n FROM teams WHERE project_id = ?', pid)!.n) < TEAM_LIMITS.perProject;
  }
  clearGraph(pid: string): void {
    for (const t of ['messages', 'blockers', 'edges', 'nodes']) this.all(`DELETE FROM ${t} WHERE project_id = ?`, pid);
  }

  emit(pid: string, actor: Role, ...specs: EventSpec[]): void {
    this.append(pid, actor, specs, true);
  }

  /** Como `emit`; con `touch` en false no sube `projects.updated_at` (el latido de la demo no la sube en la lista). */
  append(pid: string, actor: Role, specs: EventSpec[], touch: boolean): void {
    let seq = Number(this.one('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project_id = ?', pid)!.seq);
    for (const e of specs) {
      seq++;
      this.all('INSERT INTO events (project_id, seq, type, actor, at, payload) VALUES (?, ?, ?, ?, ?, ?)', pid, seq, e.type, actor, this.now, JSON.stringify(e.payload));
      this.events.push({ seq, projectId: pid, actor, at: this.now, ...e } as DagEvent);
    }
    if (touch) this.all('UPDATE projects SET updated_at = ? WHERE id = ?', this.now, pid);
  }
}

/** Nodo nuevo con las reglas del servidor: `done` → progress 1. */
function newNode(pid: string, input: NodeInput, stages: Stage[], now: string, at = ''): DagNode {
  if (!stages.some((s) => s.id === input.stage)) fail('invalid', `${at}stage: «${input.stage}» no es una etapa del proyecto`);
  const status = input.status ?? 'pending';
  return {
    id: input.id ?? slugify(input.title),
    projectId: pid,
    stage: input.stage,
    title: input.title,
    status,
    progress: status === 'done' ? 1 : (input.progress ?? 0),
    team: input.team ?? null,
    goal: input.goal ?? null,
    reportUrl: input.reportUrl ?? null,
    link: input.link ?? null,
    // #75: una tarea que nace en marcha o lista nace con su hora; el cliente no la escribe
    startedAt: status === 'working' ? now : null,
    doneAt: status === 'done' ? now : null,
    teamId: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Una revisión sin opciones recibe las del idioma del proyecto (#77). */
const withDefaultOptions = <B extends BlockerInput>(b: B, lang: Lang): B =>
  b.kind === 'review' && !b.options?.length ? { ...b, options: [...REVIEW_OPTIONS[lang]] } : b;

/** `createdAt` (#75): la hora real de la pregunta que trae el cuerpo de un PUT; nunca en el futuro. */
function newBlocker(pid: string, nodeId: string, input: BlockerInput & { createdAt?: string }, now: string): Blocker {
  return {
    id: randomId('b_'),
    projectId: pid,
    nodeId,
    kind: input.kind,
    question: input.question,
    options: input.options ?? [],
    accessLabel: input.accessLabel ?? null,
    status: 'open',
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: input.createdAt !== undefined && input.createdAt < now ? input.createdAt : now,
  };
}

const BLOCKED_BY_HAND = 'status: «blocked» lo pone un bloqueante, no se pone a mano';
const pending = (n: number) => (n === 1 ? 'una pregunta abierta' : `${n} preguntas abiertas`);
/** «una pregunta abierta para el dueño y 2 respuestas del dueño»; y el pronombre que la retoma. */
function held({ open, resolved }: { open: number; resolved: number }): { what: string; them: string } {
  const answers = resolved === 1 ? 'una respuesta' : `${resolved} respuestas`;
  const parts = [open ? `${pending(open)} para el dueño` : '', resolved ? `${answers} del dueño` : ''].filter(Boolean);
  return { what: parts.join(' y '), them: open + resolved === 1 ? 'la' : 'las' };
}
/** Clave de un bloqueante para no duplicarlo al re-importar: misma tarea, tipo, pregunta, opciones y etiqueta. */
const blockerKey = (nodeId: unknown, kind: unknown, question: unknown, options: string, accessLabel: unknown) =>
  JSON.stringify([nodeId, kind, question, options, accessLabel ?? null]);
/** Clave de un mensaje para no duplicarlo al re-importar: misma tarea, texto e informe (la firma se compara aparte). */
const messageKey = (nodeId: unknown, text: unknown, reportUrl: unknown) => JSON.stringify([nodeId, text, reportUrl ?? null]);

const ops: { [K in WriteOp['kind']]: (tx: Tx, op: Extract<WriteOp, { kind: K }>) => WriteValues[K] } = {
  createProject(tx, { pid, name, lang = DEFAULT_LANG, stages }) {
    if (tx.one('SELECT 1 FROM projects WHERE id = ?', pid)) fail('conflict', `Ya existe un proyecto «${pid}»`);
    const project: Project = { id: pid, name, lang, stages: toStages(stages, lang), createdAt: tx.now, updatedAt: tx.now };
    tx.all(
      'INSERT INTO projects (id, name, lang, stages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      pid, name, lang, JSON.stringify(project.stages), tx.now, tx.now,
    );
    return project;
  },

  replaceGraph(tx, { pid, graph: g, actor, exclusive }) {
    const prevRow = tx.one('SELECT * FROM projects WHERE id = ?', pid);
    if (prevRow && exclusive) fail('conflict', `Ya existe un proyecto «${pid}»; no lo piso`);
    const prev = prevRow ? toProject(prevRow) : null;
    // sin `lang`, uno existente conserva el suyo tal cual está guardado (NULL incluido) y uno nuevo nace en inglés
    const langCol = g.lang ?? (prevRow ? ((prevRow.lang as Lang | null) ?? null) : DEFAULT_LANG);
    const lang = langCol ?? prev!.lang;
    const stages = g.stages ? toStages(g.stages, lang) : (prev?.stages ?? toStages(undefined, lang));
    const graphBlockers = (g.blockers ?? []).map((b) => withDefaultOptions(b, lang));
    // el PUT de un agente sobre un proyecto existente conserva lo que no le toca reescribir; el dueño recrea todo
    const keep = prev !== null && actor !== 'owner';
    const nodes = g.nodes.map((n, i) => newNode(pid, n, stages, tx.now, `nodes[${i}].`));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // una tarea que sigue conserva su antigüedad (`next` desempata por `createdAt`) y su `link` si el body no
    // trae la clave: un import no la manda y no debe borrar lo que puso `sync`; `null` explícito sí lo borra
    if (keep) {
      const sent = new Map(g.nodes.map((n, i) => [nodes[i]!.id, 'link' in n]));
      for (const r of tx.all('SELECT id, created_at, link FROM nodes WHERE project_id = ?', pid)) {
        const node = byId.get(r.id as string);
        if (!node) continue;
        node.createdAt = r.created_at as string;
        if (!sent.get(node.id)) node.link = (r.link as string | null) ?? null;
      }
    }
    // resolver es solo del dueño: el PUT de un agente conserva cada bloqueante (abierto o respondido) con su
    // id, su respuesta y su valor, así un `wait` en curso los sigue encontrando. Quitar su tarea → 409.
    const kept = keep ? tx.all('SELECT * FROM blockers WHERE project_id = ? ORDER BY rowid', pid) : [];
    // los mensajes de las tareas que siguen se conservan con su id y su fecha; los de una tarea quitada se van
    const keptMessages = keep
      ? tx.all('SELECT * FROM messages WHERE project_id = ? ORDER BY rowid', pid).filter((m) => byId.has(m.node_id as string))
      : [];
    const orphan = kept.find((b) => !byId.has(b.node_id as string));
    if (orphan) {
      const nid = orphan.node_id as string;
      const h = held(tx.heldBlockers(pid, nid));
      fail('conflict', `La tarea «${tx.node(pid, nid).title}» tiene ${h.what}; quitarla del proyecto ${h.them} haría desaparecer. Déjala en el grafo o pídele al dueño que reemplace el proyecto él`);
    }
    // re-importar el mismo archivo no duplica una pregunta que sigue abierta; una igual a otra ya respondida
    // entra como nueva: re-preguntar nunca se descarta en silencio
    const keptOpen = kept.filter((b) => b.status === 'open');
    const openKeys = new Set(keptOpen.map((b) => blockerKey(b.node_id, b.kind, b.question, b.options as string, b.access_label)));
    const fresh = graphBlockers.filter(
      (b) => !openKeys.has(blockerKey(b.nodeId, b.kind, b.question, JSON.stringify(b.options ?? []), b.accessLabel)),
    );
    const answeredKeys = new Set(
      kept.filter((b) => b.status === 'resolved').map((b) => blockerKey(b.node_id, b.kind, b.question, b.options as string, b.access_label)),
    );
    const blockedBy = new Set([...graphBlockers.map((b) => b.nodeId), ...keptOpen.map((b) => b.node_id as string)]);
    nodes.forEach((node, i) => {
      if (node.status === 'blocked' && !blockedBy.has(node.id))
        fail('invalid', `nodes[${i}].status: «blocked» lo pone un bloqueante; agrégalo en blockers`);
      // como en PATCH: una tarea con una pregunta abierta no se cierra (quedaría bloqueada al 100 %)
      if (node.status === 'done' && blockedBy.has(node.id)) {
        const mine = fresh.filter((b) => b.nodeId === node.id);
        const n = keptOpen.filter((b) => b.node_id === node.id).length + mine.length;
        // todo lo que la bloquearía es re-preguntar lo ya respondido: no hay nada que esperar del dueño
        const reasked = mine.every((b) => answeredKeys.has(blockerKey(b.nodeId, b.kind, b.question, JSON.stringify(b.options ?? []), b.accessLabel)));
        if (reasked && mine.length === n)
          fail('conflict', `nodes[${i}].status: el dueño ya respondió ${n === 1 ? 'la pregunta' : 'las preguntas'} de la tarea «${node.title}» que el archivo vuelve a hacer; ${n === 1 ? 'quítala' : 'quítalas'} de blockers o no cierres la tarea`);
        fail('conflict', `nodes[${i}].status: la tarea «${node.title}» tiene ${pending(n)} para el dueño; no puede quedar «done» hasta que ${n === 1 ? 'la responda' : 'las responda'}`);
      }
      // una tarea con un bloqueante abierto está bloqueada, la declare así o no
      if (blockedBy.has(node.id)) node.status = 'blocked';
    });
    // #75: los tiempos son historia, no parte del archivo: una tarea que sigue (con el dueño o con un agente) conserva
    // cuándo arrancó, cuándo quedó lista si sigue lista, y su equipo. Una que vuelve a `pending` no arrancó.
    const prevTimes = new Map(tx.all('SELECT id, status, started_at, done_at, team_id FROM nodes WHERE project_id = ?', pid).map((r) => [r.id as string, r]));
    for (const node of nodes) {
      const p = prevTimes.get(node.id);
      if (!p) continue;
      node.startedAt = node.status === 'pending' ? null : ((p.started_at as string | null) ?? node.startedAt ?? null);
      node.doneAt = node.status !== 'done' ? null : p.status === 'done' && p.done_at ? (p.done_at as string) : tx.now;
      node.teamId = (p.team_id as string | null) ?? null;
    }
    const edges: Edge[] = g.nodes.flatMap((n, i) => [...new Set(n.deps ?? [])].map((d) => ({ projectId: pid, from: d, to: nodes[i]!.id })));
    const project: Project = { id: pid, name: g.name, lang, stages, createdAt: prev?.createdAt ?? tx.now, updatedAt: tx.now };
    tx.all(
      `INSERT INTO projects (id, name, lang, stages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, lang = excluded.lang, stages = excluded.stages, updated_at = excluded.updated_at`,
      pid, project.name, langCol, JSON.stringify(stages), project.createdAt, tx.now,
    );
    tx.clearGraph(pid);
    for (const n of nodes) tx.insertNode(n);
    for (const e of edges) tx.insertEdge(e);
    for (const b of kept) tx.restoreBlocker(b);
    for (const b of fresh) tx.insertBlocker(newBlocker(pid, b.nodeId, b, tx.now));
    // uno del body igual a uno conservado no se duplica: re-importar el mismo archivo es idempotente. Sin `from`,
    // la firma sale del equipo actual, que puede haber cambiado: se compara solo tarea, texto e informe. Los que
    // traen `from` reclaman primero, así uno sin firma no le quita su par a uno firmado.
    const unclaimed = new Map<string, Row[]>();
    for (const m of keptMessages) {
      const k = messageKey(m.node_id, m.text, m.report_url);
      unclaimed.set(k, [...(unclaimed.get(k) ?? []), m]);
    }
    for (const m of keptMessages) tx.restoreMessage(m);
    const body = g.messages ?? [];
    const claimed = new Set<number>();
    for (const signed of [true, false])
      body.forEach((m, i) => {
        if ((m.from != null) !== signed) return;
        const rows = unclaimed.get(messageKey(m.nodeId, m.text, m.reportUrl)) ?? [];
        const j = signed ? rows.findIndex((r) => r.from_name === m.from) : rows.length ? 0 : -1;
        if (j < 0) return;
        rows.splice(j, 1);
        claimed.add(i);
      });
    body.forEach((m, i) => {
      if (claimed.has(i)) return;
      const from = m.from ?? signature(byId.get(m.nodeId)!, lang);
      tx.insertMessage({ id: randomId('m_'), projectId: pid, nodeId: m.nodeId, from, text: m.text, reportUrl: m.reportUrl ?? null, createdAt: tx.now });
    });
    tx.emit(pid, actor, { type: 'project.replaced', payload: { project } });
    return null;
  },

  patchProject(tx, { pid, name, lang, stages: stageInput, actor }) {
    const prev = tx.project(pid);
    const stages = stageInput ? toStages(stageInput, lang ?? prev.lang) : prev.stages;
    if (stageInput) {
      const ids = new Set(stages.map((s) => s.id));
      const orphan = tx.all('SELECT title, stage FROM nodes WHERE project_id = ?', pid).find((n) => !ids.has(n.stage as string));
      if (orphan) fail('invalid', `stages: la tarea «${orphan.title}» usa la etapa «${orphan.stage}»; muévela antes de quitarla`);
    }
    const project: Project = { ...prev, name: name ?? prev.name, lang: lang ?? prev.lang, stages, updatedAt: tx.now };
    tx.all('UPDATE projects SET name = ?, stages = ? WHERE id = ?', project.name, JSON.stringify(stages), pid);
    if (lang) tx.all('UPDATE projects SET lang = ? WHERE id = ?', lang, pid);
    tx.emit(pid, actor, { type: 'project.updated', payload: { project } });
    return project;
  },

  deleteProject(tx, { pid }) {
    tx.project(pid);
    tx.clearGraph(pid);
    // los equipos no son parte del grafo (un PUT no los toca), pero se van con el proyecto (#75)
    tx.all('DELETE FROM teams WHERE project_id = ?', pid);
    tx.all('DELETE FROM events WHERE project_id = ?', pid);
    // una clave del proyecto borrado no reproduce sus eventos en uno recreado con el mismo id (#71)
    tx.all('DELETE FROM idempotency WHERE project_id = ?', pid);
    tx.all('DELETE FROM projects WHERE id = ?', pid);
    return null;
  },

  addNode(tx, { pid, input, actor }) {
    const project = tx.project(pid);
    if (input.status === 'blocked') fail('invalid', BLOCKED_BY_HAND);
    const ids = tx.nodeIds(pid);
    if (ids.size >= LIMITS.nodesPerProject) fail('invalid', `nodes: máximo ${LIMITS.nodesPerProject} por proyecto`);
    const node = newNode(pid, input, project.stages, tx.now);
    if (ids.has(node.id)) fail('conflict', `Ya existe una tarea «${node.id}»`);
    const deps = [...new Set(input.deps ?? [])];
    for (const d of deps) if (!ids.has(d)) fail('invalid', `deps: «${d}» no existe`);
    const edges: Edge[] = deps.map((d) => ({ projectId: pid, from: d, to: node.id }));
    tx.insertNode(node);
    for (const e of edges) tx.insertEdge(e);
    tx.emit(pid, actor, { type: 'node.added', payload: { node } }, ...edges.map((edge) => ({ type: 'edge.added' as const, payload: { edge } })));
    return node;
  },

  patchNode(tx, { pid, nid, patch, actor }) {
    const project = tx.project(pid);
    const prev = tx.node(pid, nid); // leído dentro de la transacción: es el estado vigente
    if (patch.status === 'blocked') fail('invalid', BLOCKED_BY_HAND);
    if (patch.status !== undefined && tx.openBlockers(pid, nid) > 0)
      fail('conflict', 'La tarea tiene un bloqueante abierto: resuélvelo antes de cambiar su estado');
    if (patch.stage !== undefined && !project.stages.some((s) => s.id === patch.stage))
      fail('invalid', `stage: «${patch.stage}» no es una etapa del proyecto`);
    const cols: Parameters<Tx['updateNode']>[2] = {};
    if (patch.stage !== undefined) cols.stage = patch.stage;
    if (patch.title !== undefined) cols.title = patch.title;
    if (patch.status !== undefined) cols.status = patch.status;
    if (patch.progress !== undefined) cols.progress = patch.progress;
    if (patch.team !== undefined) cols.team = patch.team;
    if (patch.goal !== undefined) cols.goal = patch.goal;
    if (patch.reportUrl !== undefined) cols.report_url = patch.reportUrl;
    if (patch.link !== undefined) cols.link = patch.link;
    if (patch.teamId !== undefined) cols.team_id = patch.teamId;
    const status = patch.status ?? prev.status;
    if (status === 'done') cols.progress = 1;
    else if (patch.status === 'working' && prev.status === 'pending') cols.progress = patch.progress ?? 0;
    const node = tx.updateNode(pid, nid, cols)!;
    // cambiar de equipo (o soltarla) la saca del viejo; entra a la lista del nuevo, que nace con ella si no existe (#75)
    const left = patch.teamId !== undefined && prev.teamId && prev.teamId !== patch.teamId ? leaveTeam(tx, pid, prev.teamId, nid) : null;
    const joined = patch.teamId ? joinTeam(tx, pid, patch.teamId, nid) : null;
    const teams = [left, joined].filter((t): t is Team => t !== null);
    tx.emit(pid, actor, { type: 'node.updated', payload: { node } }, ...teams.map((team) => ({ type: 'team.updated' as const, payload: { team } })));
    return node;
  },

  removeNode(tx, { pid, nid, actor }) {
    const node = tx.node(pid, nid);
    // resolver es solo del dueño: un agente no hace desaparecer ni sus preguntas abiertas ni sus respuestas
    const h = actor !== 'owner' ? tx.heldBlockers(pid, nid) : { open: 0, resolved: 0 };
    if (h.open + h.resolved > 0) {
      const { what, them } = held(h);
      fail('conflict', `La tarea «${node.title}» tiene ${what}; borrarla ${them} haría desaparecer. Pídele al dueño que la borre él`);
    }
    for (const [t, col] of [['messages', 'node_id'], ['blockers', 'node_id'], ['edges', 'from_id'], ['edges', 'to_id'], ['nodes', 'id']] as const)
      tx.all(`DELETE FROM ${t} WHERE project_id = ? AND ${col} = ?`, pid, node.id);
    tx.emit(pid, actor, { type: 'node.removed', payload: { nodeId: node.id } });
    return null;
  },

  addEdge(tx, { pid, from, to, actor }) {
    tx.project(pid);
    const ids = tx.nodeIds(pid);
    for (const id of [from, to]) if (!ids.has(id)) notFound(`La tarea «${id}»`);
    const edges = tx.edges(pid);
    if (edges.some((e) => e.from === from && e.to === to)) fail('conflict', 'Esa dependencia ya existe');
    if (wouldCreateCycle(edges, from, to)) fail('cycle', `«${from}» ya depende de «${to}»: esa dependencia cerraría un ciclo`);
    const edge: Edge = { projectId: pid, from, to };
    tx.insertEdge(edge);
    tx.emit(pid, actor, { type: 'edge.added', payload: { edge } });
    return edge;
  },

  removeEdge(tx, { pid, from, to, actor }) {
    tx.project(pid);
    const gone = tx.one('DELETE FROM edges WHERE project_id = ? AND from_id = ? AND to_id = ? RETURNING from_id', pid, from, to);
    if (!gone) notFound('Esa dependencia');
    const edge: Edge = { projectId: pid, from, to };
    tx.emit(pid, actor, { type: 'edge.removed', payload: { edge } });
    return null;
  },

  openBlocker(tx, { pid, nid, input, actor }) {
    const { lang } = tx.project(pid);
    tx.node(pid, nid);
    const blocker = newBlocker(pid, nid, withDefaultOptions(input, lang), tx.now);
    tx.insertBlocker(blocker);
    // solo la columna de estado: el resto del nodo queda como esté
    const node = tx.updateNode(pid, nid, { status: 'blocked' })!;
    tx.emit(pid, actor, { type: 'blocker.opened', payload: { blocker } }, { type: 'node.updated', payload: { node } });
    return blocker;
  },

  resolveBlocker(tx, { pid, bid, expectKind, choice, note, sealed }) {
    const row = tx.one('SELECT * FROM blockers WHERE project_id = ? AND id = ?', pid, bid);
    if (!row) return notFound(`El bloqueante «${bid}»`);
    const prev = toBlocker(row);
    if (prev.kind !== expectKind) fail('conflict', 'El bloqueante cambió mientras lo resolvías; vuelve a intentarlo');
    const resolution = { choice, note, hasValue: sealed !== null };
    // la condición `status = 'open'` va en el UPDATE: si no tocó ninguna fila, ya estaba resuelto
    const updated = tx.one(
      `UPDATE blockers SET status = 'resolved', resolution = ?, resolved_by = 'owner', resolved_at = ?, access_value = ?
       WHERE project_id = ? AND id = ? AND status = 'open' RETURNING id`,
      JSON.stringify(resolution), tx.now, sealed, pid, bid,
    );
    if (!updated) fail('conflict', 'Ese bloqueante ya está resuelto');
    const blocker: Blocker = { ...prev, status: 'resolved', resolution, resolvedBy: 'owner', resolvedAt: tx.now };
    const unblocked = tx.openBlockers(pid, prev.nodeId) === 0;
    const node = tx.updateNode(pid, prev.nodeId, unblocked ? { status: 'working' } : {})!;
    // el mensaje del sistema solo cuando la tarea de verdad se destraba
    // contesta en el idioma del proyecto (#77); la demo inglesa firma como sus equipos (#74)
    const { lang } = tx.project(pid);
    const en = lang === 'en';
    const message: Message | null = unblocked
      ? {
          id: randomId('m_'),
          projectId: pid,
          nodeId: node.id,
          from: en && demoLang(pid) === 'en' ? demoSignature('en', node.team) : signature(node, lang),
          text: en ? RESUME_TEXT_EN : RESUME_TEXT,
          reportUrl: null,
          createdAt: tx.now,
        }
      : null;
    if (message) tx.insertMessage(message);
    tx.emit(
      pid,
      'owner',
      { type: 'blocker.resolved', payload: { blocker } },
      { type: 'node.updated', payload: { node } },
      ...(message ? [{ type: 'message.posted' as const, payload: { message } }] : []),
    );
    return blocker;
  },

  postMessage(tx, { pid, nid, input, actor }) {
    const { lang } = tx.project(pid);
    const node = tx.node(pid, nid);
    const message: Message = {
      id: randomId('m_'),
      projectId: pid,
      nodeId: nid,
      from: input.from ?? signature(node, lang),
      text: input.text,
      reportUrl: input.reportUrl ?? null,
      createdAt: tx.now,
    };
    tx.insertMessage(message);
    // adopta el informe solo si el nodo no tiene uno, sin tocar ninguna otra columna
    const adopted = message.reportUrl ? tx.updateNode(pid, nid, { report_url: message.reportUrl }, 'AND report_url IS NULL') : null;
    tx.emit(pid, actor, { type: 'message.posted', payload: { message } }, ...(adopted ? [{ type: 'node.updated' as const, payload: { node: adopted } }] : []));
    return message;
  },

  putTeam(tx, { pid, tid, patch, actor }) {
    tx.project(pid);
    const prev = tx.team(pid, tid);
    if (!prev && !tx.teamRoom(pid)) fail('invalid', `teams: máximo ${TEAM_LIMITS.perProject} por proyecto`);
    const pick = <K extends 'requestedAt' | 'startedAt' | 'closedAt' | 'outcome'>(k: K): Team[K] => (patch[k] !== undefined ? (patch[k] as Team[K]) : (prev?.[k] ?? null));
    const team: Team = {
      id: tid,
      projectId: pid,
      name: patch.name ?? prev?.name ?? teamNameFromSlug(tid),
      nodeIds: [...(patch.nodeIds ?? prev?.nodeIds ?? [])],
      requestedAt: pick('requestedAt'),
      startedAt: pick('startedAt'),
      closedAt: pick('closedAt'),
      outcome: pick('outcome'),
      updatedAt: tx.now,
    };
    // addNodeIds se suma sobre la lista vigente, leída en esta misma transacción: dos escritores no se pisan
    for (const id of patch.addNodeIds ?? []) if (!team.nodeIds.includes(id)) team.nodeIds.push(id);
    if (team.nodeIds.length > TEAM_LIMITS.nodeIds)
      fail('conflict', `El equipo «${tid}» llegaría a ${team.nodeIds.length} tareas; el máximo es ${TEAM_LIMITS.nodeIds}`);
    const problem = teamDatesProblem(team);
    if (problem) fail('invalid', problem);
    // idempotente: repetir el mismo upsert (p. ej. `import-ledger` otra vez) no escribe ni emite
    if (prev && sameTeam(prev, team)) return prev;
    tx.saveTeam(team);
    tx.emit(pid, actor, { type: 'team.updated', payload: { team } });
    return team;
  },

  demoBeat(tx, { pid }) {
    const lang = demoLang(pid) ?? fail('forbidden', NOT_DEMO);
    tx.project(pid);
    // se decide sobre el estado vigente: un visitante que acaba de resolver no compite con el latido
    const step = demoPulse(pulseState(tx, pid), lang);
    if (step.kind === 'idle') return step;
    const cols: Parameters<Tx['updateNode']>[2] =
      step.kind === 'start'
        ? { status: 'working', progress: 0, team: step.team }
        : step.kind === 'complete'
          ? { status: 'done', progress: 1 }
          : { progress: step.progress };
    // la condición del estado va en el UPDATE: el pulso nunca pisa una tarea que esperaba al PM
    const node = tx.updateNode(pid, step.nodeId, cols, `AND status = '${step.kind === 'start' ? 'pending' : 'working'}'`);
    if (!node) return { kind: 'idle' };
    const said = step.kind === 'start' ? null : step.message;
    const message: Message | null = said
      ? { id: randomId('m_'), projectId: pid, nodeId: node.id, from: said.from, text: said.text, reportUrl: null, createdAt: tx.now }
      : null;
    if (message) tx.insertMessage(message);
    // latir no es actualizar el proyecto: la demo no sube en la lista solo porque late
    tx.append(pid, 'agent', [{ type: 'node.updated', payload: { node } }, ...(message ? [{ type: 'message.posted' as const, payload: { message } }] : [])], false);
    return step;
  },

  demoReseed(tx, { pid, keep }) {
    const lang = demoLang(pid) ?? fail('forbidden', NOT_DEMO);
    tx.project(pid);
    // se vuelve a mirar aquí dentro: entre los latidos ociosos del room y esta escritura, el PM pudo resolver algo
    if (demoPulse(pulseState(tx, pid), lang).kind !== 'idle') return false;
    const open = tx.all("SELECT * FROM blockers WHERE project_id = ? AND status = 'open' ORDER BY rowid", pid);
    // el dueño reemplaza el grafo sobre el mismo id: misma encarnación, así nadie que mira recibe 4004
    ops.replaceGraph(tx, { kind: 'replaceGraph', pid, graph: demoProject(lang), actor: 'owner' });
    // un bloqueante que seguía abierto conserva su fila y su id (el PM puede tener su ficha abierta y resolverla
    // justo después); solo los ya resueltos vuelven como preguntas nuevas
    const key = (b: Row) => blockerKey(b.node_id, b.kind, b.question, b.options as string, b.access_label);
    const fresh = tx.all('SELECT * FROM blockers WHERE project_id = ? ORDER BY rowid', pid);
    for (const old of open) {
      const i = fresh.findIndex((b) => key(b) === key(old));
      if (i < 0) continue;
      tx.all('DELETE FROM blockers WHERE project_id = ? AND id = ?', pid, fresh.splice(i, 1)[0]!.id as string);
      tx.restoreBlocker(old);
    }
    // keep ≥ 1: siempre queda al menos el último evento, si no el seq volvería a empezar
    const max = Number(tx.one('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project_id = ?', pid)!.seq);
    const floor = max - Math.max(1, Math.floor(keep));
    if (floor > 0) {
      tx.all('DELETE FROM events WHERE project_id = ? AND seq <= ?', pid, floor);
      tx.all('UPDATE projects SET events_floor = MAX(events_floor, ?) WHERE id = ?', floor, pid);
    }
    return true;
  },
};

/** ¿Mismo equipo, salvo `updatedAt`? */
function sameTeam(a: Team, b: Team): boolean {
  return (
    a.name === b.name &&
    JSON.stringify(a.nodeIds) === JSON.stringify(b.nodeIds) &&
    a.requestedAt === b.requestedAt &&
    a.startedAt === b.startedAt &&
    a.closedAt === b.closedAt &&
    a.outcome === b.outcome
  );
}

/**
 * Suma la tarea a su equipo y devuelve el equipo si cambió (null si ya estaba). Un equipo que no existe nace aquí,
 * arrancado ahora: el sitio empezó a trabajar sin pasar por `dagyard team start`. Si no cabe, `409` (revierte todo
 * el PATCH): nunca se descarta en silencio.
 */
function joinTeam(tx: Tx, pid: string, tid: string, nid: string): Team | null {
  const prev = tx.team(pid, tid);
  if (prev?.nodeIds.includes(nid)) return null;
  if (prev && prev.nodeIds.length >= TEAM_LIMITS.nodeIds)
    fail('conflict', `El equipo «${tid}» ya lleva ${TEAM_LIMITS.nodeIds} tareas, el máximo; la tarea no cambió`);
  if (!prev && !tx.teamRoom(pid)) fail('conflict', `El proyecto ya tiene ${TEAM_LIMITS.perProject} equipos, el máximo; la tarea no cambió`);
  const team: Team = prev
    ? { ...prev, nodeIds: [...prev.nodeIds, nid], updatedAt: tx.now }
    : { id: tid, projectId: pid, name: teamNameFromSlug(tid), nodeIds: [nid], requestedAt: null, startedAt: tx.now, closedAt: null, outcome: null, updatedAt: tx.now };
  tx.saveTeam(team);
  return team;
}

/** Saca la tarea de un equipo; devuelve el equipo si cambió (null si no existe o no la tenía). */
function leaveTeam(tx: Tx, pid: string, tid: string, nid: string): Team | null {
  const prev = tx.team(pid, tid);
  if (!prev?.nodeIds.includes(nid)) return null;
  const team: Team = { ...prev, nodeIds: prev.nodeIds.filter((id) => id !== nid), updatedAt: tx.now };
  tx.saveTeam(team);
  return team;
}

/**
 * Clave de idempotencia (header `Idempotency-Key`) y huella del pedido que la trae (HMAC del método, la
 * ruta y el cuerpo crudo: no depende de cómo una versión del Worker lo parsee).
 */
export interface Idem {
  key: string;
  fp: string;
}

/** Cuánto se recuerda una clave: de sobra para los reintentos de una misma invocación. */
export const IDEM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Corre una escritura completa sobre el SQL del Store. Lanza `ApiFailure` para revertir. Con `idem`, la
 * clave se registra en la misma transacción que la escritura: si ya estaba (el reintento de una escritura
 * que sí quedó), devuelve el valor y los eventos guardados sin volver a escribir.
 */
export function runWrite(
  sql: SqlStorage,
  op: WriteOp,
  idem?: Idem,
  now = new Date().toISOString(),
): { value: WriteValues[keyof WriteValues]; events: DagEvent[]; incarnation: string | null } {
  const tx = new Tx(sql, now);
  // la encarnación del proyecto tras la escritura: su `created_at` (null si ya no existe). El room la usa para
  // no confundir un proyecto borrado y recreado con el mismo id (#67).
  const incarnation = () => (tx.one('SELECT created_at FROM projects WHERE id = ?', op.pid)?.created_at as string | undefined) ?? null;
  if (idem) {
    const prev = tx.one('SELECT fp, value, events FROM idempotency WHERE project_id = ? AND key = ?', op.pid, idem.key);
    if (prev) {
      if (prev.fp !== idem.fp) fail('conflict', 'Esa Idempotency-Key ya se usó con otra escritura; usa una clave nueva por escritura');
      return { value: JSON.parse(prev.value as string), events: JSON.parse(prev.events as string), incarnation: incarnation() };
    }
  }
  const value = (ops[op.kind] as (tx: Tx, op: WriteOp) => WriteValues[keyof WriteValues])(tx, op);
  if (idem) {
    tx.all('DELETE FROM idempotency WHERE created_at < ?', new Date(Date.parse(tx.now) - IDEM_TTL_MS).toISOString());
    tx.all(
      'INSERT INTO idempotency (project_id, key, fp, value, events, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      op.pid, idem.key, idem.fp, JSON.stringify(value), JSON.stringify(tx.events), tx.now,
    );
  }
  return { value, events: tx.events, incarnation: incarnation() };
}
