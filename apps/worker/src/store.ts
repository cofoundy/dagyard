/** Lecturas de Dagyard sobre el Db (DO `Store`) y el puente de escrituras (writes.ts) con el tiempo real. */
import { MESSAGES_IN_SNAPSHOT, type DagEvent, type DagNode, type Edge, type Project, type ProjectSnapshot } from '@dagyard/model';
import type { Db, Row } from './db.js';
import type { Env } from './env.js';
import { ApiFailure, notFound } from './http.js';
import { BLOCKER_COLS, TEAMS_ORDER, toBlocker, toEdge, toEvent, toMessage, toNode, toOrigin, toProject, toTeam } from './rows.js';
import type { Idem, WriteOp, WriteValues } from './writes.js';

/* ------------------------------------------------------------------ lecturas */

export async function getProject(db: Db, pid: string): Promise<Project | null> {
  const r = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(pid).first<Row>();
  return r ? toProject(r) : null;
}

export async function requireProject(db: Db, pid: string): Promise<Project> {
  return (await getProject(db, pid)) ?? notFound(`El proyecto «${pid}»`);
}

export async function getBlockerRow(db: Db, pid: string, bid: string): Promise<Row | null> {
  return db.prepare('SELECT * FROM blockers WHERE project_id = ? AND id = ?').bind(pid, bid).first<Row>();
}

const nodesQ = (db: Db, pid: string) =>
  db.prepare('SELECT * FROM nodes WHERE project_id = ? ORDER BY created_at, rowid').bind(pid);
const edgesQ = (db: Db, pid: string) =>
  db.prepare('SELECT * FROM edges WHERE project_id = ? ORDER BY rowid').bind(pid);

/** Proyecto, nodos y aristas en una lectura consistente. */
export async function loadGraph(db: Db, pid: string): Promise<{ project: Project; nodes: DagNode[]; edges: Edge[] }> {
  const [p, n, e] = await db.batch<Row>([db.prepare('SELECT * FROM projects WHERE id = ?').bind(pid), nodesQ(db, pid), edgesQ(db, pid)]);
  const row = p!.results[0];
  if (!row) return notFound(`El proyecto «${pid}»`);
  return { project: toProject(row), nodes: n!.results.map(toNode), edges: e!.results.map(toEdge) };
}

export async function snapshot(db: Db, pid: string): Promise<ProjectSnapshot> {
  const [p, n, e, b, m, q, t, o] = await db.batch<Row>([
    db.prepare('SELECT * FROM projects WHERE id = ?').bind(pid),
    nodesQ(db, pid),
    edgesQ(db, pid),
    db.prepare(`SELECT ${BLOCKER_COLS} FROM blockers WHERE project_id = ? ORDER BY created_at, rowid`).bind(pid),
    db
      .prepare(
        `SELECT * FROM (SELECT *, rowid AS r FROM messages WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ${MESSAGES_IN_SNAPSHOT})
         ORDER BY created_at, r`,
      )
      .bind(pid),
    db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project_id = ?').bind(pid),
    db.prepare(`SELECT * FROM teams WHERE project_id = ? ${TEAMS_ORDER}`).bind(pid),
    db.prepare('SELECT * FROM origins WHERE project_id = ? ORDER BY rowid').bind(pid),
  ]);
  const row = p!.results[0];
  if (!row) return notFound(`El proyecto «${pid}»`);
  return {
    project: toProject(row),
    nodes: n!.results.map(toNode),
    edges: e!.results.map(toEdge),
    origins: o!.results.map(toOrigin),
    blockers: b!.results.map(toBlocker),
    messages: m!.results.map(toMessage),
    teams: t!.results.map(toTeam),
    seq: Number(q!.results[0]?.seq ?? 0),
  };
}

/**
 * Encarnación del proyecto (su `created_at`; null si no existe), su seq, su piso (#74: por debajo, los eventos
 * se podaron) y, con `since`, hasta `limit` eventos posteriores: una sola lectura, así los eventos son de esa
 * encarnación.
 */
export async function liveState(
  db: Db,
  pid: string,
  since: number | null,
  limit: number,
): Promise<{ incarnation: string | null; seq: number; floor: number; events: DagEvent[] }> {
  const [p, q, e] = await db.batch<Row>([
    db.prepare('SELECT created_at, events_floor FROM projects WHERE id = ?').bind(pid),
    db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project_id = ?').bind(pid),
    db.prepare('SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?').bind(pid, since ?? Number.MAX_SAFE_INTEGER, limit),
  ]);
  const incarnation = (p!.results[0]?.created_at as string | undefined) ?? null;
  const floor = Number(p!.results[0]?.events_floor ?? 0);
  return { incarnation, seq: Number(q!.results[0]?.seq ?? 0), floor, events: e!.results.map(toEvent) };
}

/** Hasta `limit` eventos posteriores a `since`; `resync` si `since` está bajo el piso (devolverlos dejaría un hueco). */
export async function eventsSince(db: Db, pid: string, since: number, limit: number): Promise<{ events: DagEvent[]; resync: boolean }> {
  const { floor, events } = await liveState(db, pid, since, limit);
  return since < floor ? { events: [], resync: true } : { events, resync: false };
}

/* ------------------------------------------------------------------ escrituras */

/** Error de la plataforma al hablar con un Durable Object (p. ej. un deploy lo reinició): ver la guía de Cloudflare. */
type DoError = { retryable?: boolean; overloaded?: boolean };
const doError = (err: unknown): DoError => (typeof err === 'object' && err !== null ? (err as DoError) : {});

/** El error de la plataforma como respuesta: sobrecarga, o el Durable Object no estuvo disponible. `null` = es otra cosa. */
export function unavailableFailure(err: unknown): ApiFailure | null {
  const e = doError(err);
  if (e.overloaded) return new ApiFailure('overloaded', OVERLOADED);
  return e.retryable ? new ApiFailure('unavailable', UNAVAILABLE) : null;
}

const UNAVAILABLE = 'El servidor se está actualizando. Inténtalo de nuevo en unos segundos.';
const OVERLOADED = 'El servidor está sobrecargado. Espera un poco antes de reintentar.';
const UNSURE = 'El servidor se reinició a mitad de la escritura y no sé si quedó: revisa antes de repetirla.';

/** Esperas base entre reintentos del RPC al Store (≈1 s en total: lo que tarda en volver tras un deploy). */
export const STORE_RETRY_MS = [50, 250, 750];
/** ×0,5 a ×1,5: los Workers que reintentan a la vez no le caen juntos al Store recién levantado. */
export const jitter = (ms: number) => Math.round(ms * (0.5 + Math.random()));

/**
 * Corre una escritura en el Store (una transacción: ver writes.ts) y reparte sus eventos al
 * Durable Object del proyecto. Un error de dominio llega como dato y se relanza como ApiFailure.
 * Si el Store se reinicia (un deploy), reintenta solo con `idem` (`Idempotency-Key`), que el Store
 * registra en la misma transacción. Si no puede reintentar, `503 uncertain`; agotados los intentos,
 * `503 unavailable`; sobrecargado, `503 overloaded`.
 */
export async function write<K extends WriteOp['kind']>(
  env: Env,
  op: Extract<WriteOp, { kind: K }>,
  idem?: Idem,
  retryMs: readonly number[] = STORE_RETRY_MS,
): Promise<WriteValues[K]> {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      // un stub nuevo por intento: tras una excepción el anterior puede quedar roto
      res = await env.STORE.get(env.STORE.idFromName('db')).write(op, idem);
    } catch (err) {
      const failure = unavailableFailure(err);
      if (!failure || failure.code === 'overloaded') throw failure ?? err;
      // sin clave no se sabe si el intento commiteó: reaplicarlo podría duplicarlo o pisar una escritura posterior
      if (!idem) throw new ApiFailure('uncertain', UNSURE);
      if (attempt >= retryMs.length) throw failure;
      await new Promise((r) => setTimeout(r, jitter(retryMs[attempt]!)));
      continue;
    }
    if (!res.ok) throw new ApiFailure(res.error.code, res.error.message, res.error.reason);
    await publish(env, op.pid, res.events as DagEvent[], res.incarnation);
    return res.value as WriteValues[K];
  }
}

/** Reparte a los sockets. Si falla, la escritura ya quedó: los clientes se recuperan con `?since=`. */
export async function publish(env: Env, pid: string, events: DagEvent[], incarnation: string | null): Promise<void> {
  if (!events.length || incarnation === null) return;
  try {
    await env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(pid)).broadcast(pid, events, incarnation);
  } catch (err) {
    console.error(JSON.stringify({ msg: 'broadcast falló', pid, seqs: events.map((e) => e.seq), err: String(err) }));
  }
}
