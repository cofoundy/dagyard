/**
 * #131: una decisión con plazo y default. Al vencer sin respuesta, la alarma del Store la resuelve con el default,
 * lo marca (`byDefault`) y deja un mensaje escrito; la tarea vuelve a trabajar y `wait` devuelve la opción.
 */
import type { Blocker, BlockerWaitResult, ProjectSnapshot } from '@dagyard/model';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { AGENT, OWNER, api, json, uniquePid } from './helpers.js';

const store = () => env.STORE.get(env.STORE.idFromName('db'));

async function project(lang: 'es' | 'en' = 'es'): Promise<string> {
  const pid = uniquePid('plazo');
  await json(
    await api(`/api/projects/${pid}`, {
      method: 'PUT',
      headers: AGENT,
      body: { name: 'Plazos', lang, nodes: [{ id: 'base', title: 'Base de pruebas', status: 'working' }] },
    }),
    200,
  );
  return pid;
}

const block = (pid: string, body: Record<string, unknown>) =>
  api(`/api/projects/${pid}/nodes/base/blockers`, { method: 'POST', headers: AGENT, body: { kind: 'decision', question: '¿Postgres local o en la nube?', options: ['Local', 'Nube'], ...body } });

/** Lleva el plazo de un bloqueante al pasado sin esperar: el reloj del test no se puede adelantar. */
async function expire(bid: string): Promise<void> {
  await runInDurableObject(store(), (_i, state) => {
    state.storage.sql.exec(`UPDATE blockers SET due_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), bid);
  });
}

describe('decisión con plazo (#131)', () => {
  it('al vencer aplica el default, lo deja escrito y destraba la tarea', async () => {
    const pid = await project();
    const due = new Date(Date.now() + 3600_000).toISOString();
    const b = await json<Blocker>(await block(pid, { defaultChoice: 'Local', dueAt: due }), 201);
    expect(b).toMatchObject({ status: 'open', defaultChoice: 'Local', dueAt: due });

    // la alarma quedó armada a la hora del plazo
    const alarm = await runInDurableObject(store(), (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();

    // antes del plazo, la alarma no toca nada
    await expire('b_otro');
    expect((await json<Blocker>(await api(`/api/projects/${pid}/blockers/${b.id}`), 200)).status).toBe('open');

    await expire(b.id);
    expect(await runDurableObjectAlarm(store())).toBe(true);

    const got = await json<BlockerWaitResult>(await api(`/api/projects/${pid}/blockers/${b.id}/wait?timeout=0`, { headers: AGENT }), 200);
    expect(got.blocker).toMatchObject({ status: 'resolved', resolvedBy: 'owner', resolution: { choice: 'Local', byDefault: true, hasValue: false } });

    const snap = await json<ProjectSnapshot>(await api(`/api/projects/${pid}`), 200);
    expect(snap.nodes.find((n) => n.id === 'base')!.status).toBe('working');
    expect(snap.messages.map((m) => m.text)).toContain('Nadie respondió antes del plazo: sigo con «Local», la opción por defecto.');
  });

  it('si el dueño responde antes, el default no corre', async () => {
    const pid = await project('en');
    const b = await json<Blocker>(await block(pid, { defaultChoice: 'Local', dueAt: new Date(Date.now() + 3600_000).toISOString() }), 201);
    const r = await json<Blocker>(await api(`/api/projects/${pid}/blockers/${b.id}/resolve`, { method: 'POST', headers: OWNER, body: { choice: 'Nube' } }), 200);
    expect(r.resolution).toEqual({ choice: 'Nube', note: null, hasValue: false });
    await expire(b.id);
    await runDurableObjectAlarm(store());
    const after = await json<Blocker>(await api(`/api/projects/${pid}/blockers/${b.id}`), 200);
    expect(after.resolution).toEqual({ choice: 'Nube', note: null, hasValue: false });
    const snap = await json<ProjectSnapshot>(await api(`/api/projects/${pid}`), 200);
    expect(snap.messages.some((m) => m.text.startsWith('No answer before the deadline'))).toBe(false);
  });

  it('valida: juntos, futuro, ≤30 días, una de las opciones y nunca en un acceso', async () => {
    const pid = await project();
    const soon = new Date(Date.now() + 3600_000).toISOString();
    const cases: Array<Record<string, unknown>> = [
      { defaultChoice: 'Local' },
      { dueAt: soon },
      { defaultChoice: 'Otra', dueAt: soon },
      { defaultChoice: 'Local', dueAt: new Date(Date.now() - 60_000).toISOString() },
      { defaultChoice: 'Local', dueAt: new Date(Date.now() + 31 * 24 * 3600_000).toISOString() },
      { kind: 'access', options: undefined, accessLabel: 'Token', defaultChoice: 'x', dueAt: soon },
    ];
    for (const c of cases) expect((await json(await block(pid, c), 400)).error.code).toBe('invalid');
    // una revisión sin opciones recibe las del idioma y el default se valida contra ellas
    const review = await api(`/api/projects/${pid}/nodes/base/blockers`, {
      method: 'POST',
      headers: AGENT,
      body: { kind: 'review', question: '¿Lo revisas?', defaultChoice: 'Aprobar', dueAt: soon },
    });
    expect((await json<Blocker>(review, 201)).defaultChoice).toBe('Aprobar');
  });

  it('un bloqueante sin plazo sigue igual (sin campos de default)', async () => {
    const pid = await project();
    const b = await json<Blocker>(await block(pid, {}), 201);
    expect(b).toMatchObject({ defaultChoice: null, dueAt: null });
  });
});
