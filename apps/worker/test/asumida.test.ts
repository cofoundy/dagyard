/**
 * #144: una decisión asumida. El sitio sigue con su recomendación mientras el dueño decide: la tarea no se frena y sus
 * dependientes arrancan, pero lo que sale al cliente o a producción (`gate`) espera el sí.
 */
import type { Blocker, DagNode, NextResult, ProjectSnapshot } from '@dagyard/model';
import { describe, expect, it } from 'vitest';
import { AGENT, OWNER, api, json, uniquePid } from './helpers.js';

/** A (en marcha) → B → C (sale a producción). */
async function project(lang: 'es' | 'en' = 'es'): Promise<string> {
  const pid = uniquePid('asumida');
  await json(
    await api(`/api/projects/${pid}`, {
      method: 'PUT',
      headers: AGENT,
      body: {
        name: 'Asumida',
        lang,
        nodes: [
          { id: 'marca', title: 'Marca', status: 'working' },
          { id: 'pantallas', title: 'Pantallas', deps: ['marca'] },
          { id: 'release', title: 'Release', deps: ['pantallas'], gate: 'production' },
        ],
      },
    }),
    200,
  );
  return pid;
}

const assume = (pid: string, body: Record<string, unknown> = {}) =>
  api(`/api/projects/${pid}/nodes/marca/blockers`, {
    method: 'POST',
    headers: AGENT,
    body: { kind: 'decision', question: '¿Sobria o cálida?', options: ['Sobria', 'Cálida'], assumed: 'Sobria', ...body },
  });
const patch = (pid: string, nid: string, body: Record<string, unknown>) =>
  api(`/api/projects/${pid}/nodes/${nid}`, { method: 'PATCH', headers: AGENT, body });
const next = async (pid: string) => (await json<NextResult>(await api(`/api/projects/${pid}/next`, { headers: AGENT }), 200)).node?.id ?? null;
const resolve = (pid: string, bid: string, choice: string) =>
  api(`/api/projects/${pid}/blockers/${bid}/resolve`, { method: 'POST', headers: OWNER, body: { choice } });
const snap = async (pid: string) => json<ProjectSnapshot>(await api(`/api/projects/${pid}`), 200);

describe('decisión asumida (#144)', () => {
  it('no frena la tarea; la cadena sigue y lo que sale a producción espera el sí', async () => {
    const pid = await project();
    const b = await json<Blocker>(await assume(pid), 201);
    expect(b).toMatchObject({ status: 'open', assumed: 'Sobria' });
    let s = await snap(pid);
    expect(s.nodes.find((n) => n.id === 'marca')!.status).toBe('working');
    expect(s.nodes.find((n) => n.id === 'release')!.gate).toBe('production');

    // la tarea se entrega con la pregunta abierta (PL-15: la cadena no queda bloqueada)
    await json<DagNode>(await patch(pid, 'marca', { status: 'done' }), 200);
    expect(await next(pid)).toBe('pantallas');
    await json<DagNode>(await patch(pid, 'pantallas', { status: 'done' }), 200);
    // PL-17: el release no sale sobre una decisión asumida en su cadena
    expect(await next(pid)).toBeNull();

    // el dueño confirma: queda escrito, la tarea no se mueve y el release sale
    const r = await json<Blocker>(await resolve(pid, b.id, 'Sobria'), 200);
    expect(r.resolution).toEqual({ choice: 'Sobria', note: null, hasValue: false });
    s = await snap(pid);
    expect(s.nodes.find((n) => n.id === 'marca')!.status).toBe('done');
    expect(s.messages.map((m) => m.text)).toContain('El dueño confirmó «Sobria», la opción con la que ya seguimos.');
    expect(await next(pid)).toBe('release');
  });

  it('se puede abrir sobre una tarea ya entregada, y elegir otra lo deja escrito (PL-21)', async () => {
    const pid = await project('en');
    await json<DagNode>(await patch(pid, 'marca', { status: 'done' }), 200);
    const b = await json<Blocker>(await assume(pid), 201);
    expect((await snap(pid)).nodes.find((n) => n.id === 'marca')!.status).toBe('done');
    const r = await json<Blocker>(await resolve(pid, b.id, 'Cálida'), 200);
    expect(r.resolution).toMatchObject({ choice: 'Cálida', overrode: true });
    const s = await snap(pid);
    expect(s.nodes.find((n) => n.id === 'marca')!.status).toBe('done');
    expect(s.messages.map((m) => m.text)).toContain(
      'The owner chose «Cálida», not «Sobria», the one we had gone ahead with: what was built on top needs another look.',
    );
  });

  it('una pregunta normal sigue frenando, y una tarea sin gate no espera nada', async () => {
    const pid = await project();
    await json<Blocker>(
      await api(`/api/projects/${pid}/nodes/marca/blockers`, {
        method: 'POST',
        headers: AGENT,
        body: { kind: 'decision', question: '¿Logo?', options: ['A', 'B'] },
      }),
      201,
    );
    expect((await snap(pid)).nodes.find((n) => n.id === 'marca')!.status).toBe('blocked');
    expect((await json(await patch(pid, 'marca', { status: 'done' }), 409)).error.code).toBe('conflict');
  });

  it('valida: una de las opciones, nunca con default ni en un acceso; gate solo client|production', async () => {
    const pid = await project();
    const soon = new Date(Date.now() + 3600_000).toISOString();
    for (const body of [{ assumed: 'Otra' }, { defaultChoice: 'Sobria', dueAt: soon }])
      expect((await json(await assume(pid, body), 400)).error.code).toBe('invalid');
    const access = await api(`/api/projects/${pid}/nodes/marca/blockers`, {
      method: 'POST',
      headers: AGENT,
      body: { kind: 'access', question: '¿La clave?', accessLabel: 'Clave', assumed: 'x' },
    });
    expect((await json(access, 400)).error.code).toBe('invalid');
    expect((await json(await patch(pid, 'pantallas', { gate: 'marketing' }), 400)).error.code).toBe('invalid');
    expect((await json<DagNode>(await patch(pid, 'pantallas', { gate: 'client' }), 200)).gate).toBe('client');
    expect((await json<DagNode>(await patch(pid, 'pantallas', { gate: null }), 200)).gate).toBeNull();
  });
});
