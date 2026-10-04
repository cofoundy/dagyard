/**
 * Shim compatible con el subconjunto de D1 que usa el Worker (`prepare/bind/first/all/run/batch`),
 * sobre un Durable Object `Store` singleton con SQLite. Cada llamada es una RPC; `batch` corre en una
 * transacción (`transactionSync`), así que es atómico como en D1.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.js';
import { ApiFailure } from './http.js';
import { migrate } from './schema.js';
import { runWrite, type Idem, type WriteOp, type WriteResult } from './writes.js';

export type SqlValue = string | number | null;
export type Row = Record<string, unknown>;
export interface Query {
  sql: string;
  params: SqlValue[];
}

export interface Stmt {
  readonly query: Query;
  bind(...params: unknown[]): Stmt;
  first<T = Row>(): Promise<T | null>;
  all<T = Row>(): Promise<{ results: T[] }>;
  run(): Promise<{ results: Row[] }>;
}

export interface Db {
  prepare(sql: string): Stmt;
  batch<T = Row>(stmts: Stmt[]): Promise<Array<{ results: T[] }>>;
}

const toParam = (v: unknown): SqlValue => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new TypeError(`parámetro SQL no soportado: ${typeof v}`);
};

class StoreStmt implements Stmt {
  constructor(
    private readonly db: StoreDb,
    readonly query: Query,
  ) {}
  bind(...params: unknown[]): Stmt {
    return new StoreStmt(this.db, { sql: this.query.sql, params: params.map(toParam) });
  }
  async all<T = Row>(): Promise<{ results: T[] }> {
    const [r] = await this.db.batch<T>([this]);
    return r!;
  }
  async first<T = Row>(): Promise<T | null> {
    return (await this.all<T>()).results[0] ?? null;
  }
  run(): Promise<{ results: Row[] }> {
    return this.all<Row>();
  }
}

class StoreDb implements Db {
  constructor(private readonly ns: DurableObjectNamespace<Store>) {}
  prepare(sql: string): Stmt {
    return new StoreStmt(this, { sql, params: [] });
  }
  async batch<T = Row>(stmts: Stmt[]): Promise<Array<{ results: T[] }>> {
    if (!stmts.length) return [];
    const rows = (await this.ns.get(this.ns.idFromName('db')).batch(stmts.map((s) => s.query))) as T[][];
    return rows.map((results) => ({ results }));
  }
}

const cache = new WeakMap<object, Db>();

/** El Db del entorno (uno por objeto `env`). */
export function db(env: Pick<Env, 'STORE'>): Db {
  let d = cache.get(env);
  if (!d) cache.set(env, (d = new StoreDb(env.STORE)));
  return d;
}

/** Dueño único del SQL de Dagyard. Single-thread: cada batch es una transacción. */
export class Store extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.transactionSync(() => migrate(ctx.storage.sql));
  }

  private lastNow = 0;

  /**
   * La hora de cada escritura, estrictamente creciente: el `created_at` de un proyecto es su encarnación
   * (#67) y borrar y recrear en el mismo milisegundo no puede repetirla. En memoria basta: reiniciar el DO
   * tarda más que un milisegundo.
   */
  private tick(): string {
    this.lastNow = Math.max(Date.now(), this.lastNow + 1);
    return new Date(this.lastNow).toISOString();
  }

  /** Una escritura completa (leer, validar, escribir, eventos y su clave de idempotencia) en una transacción. Ver writes.ts. */
  write(op: WriteOp, idem?: Idem): WriteResult {
    try {
      const now = this.tick();
      const { value, events, incarnation } = this.ctx.storage.transactionSync(() => runWrite(this.ctx.storage.sql, op, idem, now));
      return { ok: true, value, events, incarnation };
    } catch (err) {
      // ApiFailure revierte la transacción y viaja como dato (las clases no cruzan la RPC)
      if (err instanceof ApiFailure) return { ok: false, error: { code: err.code, message: err.message } };
      throw err;
    }
  }

  batch(queries: Query[]): Row[][] {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => queries.map((q) => sql.exec(q.sql, ...q.params).toArray() as Row[]));
  }

  /* -------------------------------------------- sesiones del navegador (#12): solo el SHA-256 del id */

  /** Abre una sesión y, de paso, purga las vencidas. */
  openSession(idHash: string, ownerFp: string, ttlMs: number): void {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec('DELETE FROM sessions WHERE expires_at <= ?', new Date(now).toISOString());
      sql.exec(
        'INSERT INTO sessions (id_hash, owner_fp, created_at, expires_at) VALUES (?, ?, ?, ?)',
        idHash,
        ownerFp,
        new Date(now).toISOString(),
        new Date(now + ttlMs).toISOString(),
      );
    });
  }

  /** ¿Sigue viva? Una sesión vencida o abierta con otro token de dueño se borra al verla. */
  checkSession(idHash: string, ownerFp: string): boolean {
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ owner_fp: string; expires_at: string }>('SELECT owner_fp, expires_at FROM sessions WHERE id_hash = ?', idHash).toArray()[0];
    if (!row) return false;
    if (row.owner_fp === ownerFp && row.expires_at > new Date().toISOString()) return true;
    sql.exec('DELETE FROM sessions WHERE id_hash = ?', idHash);
    return false;
  }

  closeSession(idHash: string): void {
    this.ctx.storage.sql.exec('DELETE FROM sessions WHERE id_hash = ?', idHash);
  }

  /** Cierra todas las sesiones; devuelve cuántas había. */
  closeAllSessions(): number {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const n = Number(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM sessions').one().n);
      sql.exec('DELETE FROM sessions');
      return n;
    });
  }
}
