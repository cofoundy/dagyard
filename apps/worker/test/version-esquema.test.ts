/**
 * #134: tras un deploy, el Store puede seguir con el código anterior. Si el Worker espera un esquema más nuevo, el
 * Store responde «actualizándose» (503 reintentable) en vez de `no such column` o de descartar campos.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, STORE_STALE } from '../src/schema.js';
import { uniquePid } from './helpers.js';

const store = () => env.STORE.get(env.STORE.idFromName('db'));

describe('versión de esquema entre Worker y Store (#134)', () => {
  it('un Store más viejo que el Worker no escribe y lo dice como «unavailable»', async () => {
    const pid = uniquePid('ver');
    const res = await store().write({ kind: 'createProject', pid, name: 'x' }, undefined, SCHEMA_VERSION + 1);
    expect(res).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    const rows = await store().batch([{ sql: 'SELECT 1 FROM projects WHERE id = ?', params: [pid] }], SCHEMA_VERSION);
    expect(rows[0]).toEqual([]);
  });

  it('un Store más viejo no lee: devuelve la marca que el Worker traduce a 503', async () => {
    expect(await store().batch([{ sql: 'SELECT 1', params: [] }], SCHEMA_VERSION + 1)).toBe(STORE_STALE);
  });

  it('misma versión o un Worker más viejo: pasa', async () => {
    const pid = uniquePid('ver');
    expect(await store().write({ kind: 'createProject', pid, name: 'x' }, undefined, SCHEMA_VERSION)).toMatchObject({ ok: true });
    expect((await store().batch([{ sql: 'SELECT 1 AS n', params: [] }], SCHEMA_VERSION - 1))[0]).toEqual([{ n: 1 }]);
  });
});
