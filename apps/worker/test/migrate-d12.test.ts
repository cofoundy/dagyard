/**
 * `scripts/migrate-d12.mjs` (#90) contra el Worker local: crea el objetivo, los pedidos con su cita y los «nació de»;
 * la segunda corrida no escribe nada; `--dry-run` no escribe.
 */
import { purposeless, type ProjectSnapshot } from '@dagyard/model';
import { describe, expect, it } from 'vitest';
import data from '../scripts/migrate-d12.data.json';
import { migrateD12, type D12Data } from '../scripts/migrate-d12.lib.mjs';
import { api, json, uniquePid } from './helpers.js';

const d12 = data as D12Data;
const special = new Set([...d12.goals, ...d12.requests].map((n) => n.id));
/** Las tareas que el JSON referencia (las que ya están en el proyecto «dagyard»). */
const tasks = [...new Set(d12.origins.flatMap((o) => [o.from, o.to]))].filter((id) => !special.has(id));

/** Un `call` como el del script, con la clave de agente del test; anota las escrituras. */
function caller() {
  const writes: Array<{ path: string; body: unknown }> = [];
  const call = (method: string, path: string, body?: unknown) => {
    if (method !== 'GET') writes.push({ path, body });
    return api(path, { method, ...(body !== undefined && { body }) });
  };
  return { call, writes };
}

/** El proyecto antes de migrar: todas las tareas salvo `without`, sin orígenes. */
async function seed(without: string): Promise<string> {
  const pid = uniquePid('dagyard');
  const nodes = tasks.filter((id) => id !== without).map((id) => ({ id, title: id }));
  await json(await api(`/api/projects/${pid}`, { method: 'PUT', body: { name: 'Dagyard', lang: 'es', nodes } }), 200);
  return pid;
}

describe('migrate-d12 (#90)', () => {
  it('crea objetivo, pedidos y orígenes; todo llega al objetivo; la segunda corrida no escribe nada', async () => {
    const pid = await seed('preview');
    const first = caller();
    const r = await migrateD12(first.call, d12, { project: pid });
    expect(r).toEqual({
      goals: d12.goals.length,
      requests: d12.requests.length,
      origins: d12.origins.length - 1, // el de «preview», que no está
      skipped: 0,
      missing: ['preview'],
      orphans: [],
    });

    const s = await json<ProjectSnapshot>(await api(`/api/projects/${pid}`), 200);
    expect(s.nodes.find((n) => n.id === 'goal-fabrica')).toMatchObject({ kind: 'goal', bornAt: '2026-10-04T05:24:00.000Z' });
    expect(s.nodes.find((n) => n.id === 'req-m11')).toMatchObject({ kind: 'request', quoteBy: 'André', quote: d12.requests.find((x) => x.id === 'req-m11')!.quote });
    expect(s.edges).toEqual([]); // «nació de» nunca es «necesita»
    expect(purposeless(s.nodes, s.origins!)).toEqual([]);
    // cada tarea tiene su «nació de» (el §Verifica del spec)
    const born = new Set(s.origins!.map((o) => o.to));
    expect(s.nodes.filter((n) => n.kind === 'task' && !born.has(n.id))).toEqual([]);

    const again = caller();
    const r2 = await migrateD12(again.call, d12, { project: pid });
    expect(again.writes).toEqual([]);
    expect(r2).toMatchObject({ goals: 0, requests: 0, origins: 0, missing: ['preview'], orphans: [] });
  });

  it('--dry-run cuenta lo mismo y no escribe', async () => {
    const pid = await seed('preview');
    const dry = caller();
    const r = await migrateD12(dry.call, d12, { project: pid, dryRun: true });
    expect(dry.writes).toEqual([]);
    expect(r).toMatchObject({ goals: d12.goals.length, requests: d12.requests.length, origins: d12.origins.length - 1, orphans: [] });
    expect((await json<ProjectSnapshot>(await api(`/api/projects/${pid}`), 200)).origins).toEqual([]);
  });
});
