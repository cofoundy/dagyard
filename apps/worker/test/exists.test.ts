import { LIMITS, type ProjectSnapshot } from '@dagyard/model';
import { describe, expect, it } from 'vitest';
import { AGENT, api, json, seedDemo, uniquePid } from './helpers.js';

// #110: el 409 de un duplicado lleva `reason: 'exists'`; los demás 409 no. El `code` sigue siendo `conflict`.
const snap = async (pid: string) => json<ProjectSnapshot>(await api(`/api/projects/${pid}`), 200);
const edge = (pid: string, body: unknown) => api(`/api/projects/${pid}/edges`, { method: 'POST', body });

describe('409 con reason «exists» (#110)', () => {
  it('tarea, dependencia y «nació de» repetidos: conflict + exists, y no escriben nada', async () => {
    const s = await seedDemo();
    const pid = s.project.id;
    // la tarea de origen ya existe en la demo
    await json(await edge(pid, { from: 'pagos', to: 'landing', kind: 'origin', why: 'x' }), 201);
    const before = await snap(pid);

    const dupNode = await json(await api(`/api/projects/${pid}/nodes`, { method: 'POST', body: { id: 'pagos', title: 'Otra' } }), 409);
    expect(dupNode.error).toMatchObject({ code: 'conflict', reason: 'exists' });
    expect(dupNode.error.message).toMatch(/ya existe/i);
    // usuario → landing ya está en la demo
    expect((await json(await edge(pid, { from: 'usuario', to: 'landing' }), 409)).error).toMatchObject({ code: 'conflict', reason: 'exists' });
    expect((await json(await edge(pid, { from: 'pagos', to: 'landing', kind: 'origin' }), 409)).error).toMatchObject({ code: 'conflict', reason: 'exists' });

    const after = await snap(pid);
    expect(after.seq).toBe(before.seq);
    expect(after.nodes).toHaveLength(before.nodes.length);
  });

  it('proyecto repetido: POST /api/projects y PUT con If-None-Match: * → conflict + exists', async () => {
    const pid = uniquePid();
    await json(await api('/api/projects', { method: 'POST', body: { id: pid, name: 'Uno' } }), 201);
    expect((await json(await api('/api/projects', { method: 'POST', body: { id: pid, name: 'Dos' } }), 409)).error).toMatchObject({ code: 'conflict', reason: 'exists' });
    const put = await api(`/api/projects/${pid}`, { method: 'PUT', body: { name: 'Tres', nodes: [] }, headers: { ...AGENT, 'if-none-match': '*' } });
    expect((await json(put, 409)).error).toMatchObject({ code: 'conflict', reason: 'exists' });
    expect((await snap(pid)).project.name).toBe('Uno');
  });

  it('los 409 que no son duplicados no llevan reason', async () => {
    const s = await seedDemo();
    // pagos tiene un bloqueante abierto: cambiar su estado o cerrarla es otro 409
    const patch = await json(await api(`/api/projects/${s.project.id}/nodes/pagos`, { method: 'PATCH', body: { status: 'done' } }), 409);
    expect(patch.error.code).toBe('conflict');
    expect(patch.error).not.toHaveProperty('reason');
    const close = await json(await api(`/api/projects/${s.project.id}/nodes/pagos/close`, { method: 'POST', body: { as: 'done' } }), 409);
    expect(close.error).not.toHaveProperty('reason');
  });

  it('con el proyecto en su tope de tareas, re-agregar una que ya está sigue siendo «exists»; una nueva, 400', async () => {
    const pid = uniquePid();
    const nodes = Array.from({ length: LIMITS.nodesPerProject }, (_, i) => ({ id: `t-${i}`, title: `T ${i}` }));
    await json(await api(`/api/projects/${pid}`, { method: 'PUT', body: { name: 'Lleno', nodes } }), 200);
    const dup = await json(await api(`/api/projects/${pid}/nodes`, { method: 'POST', body: { id: 't-0', title: 'T 0' } }), 409);
    expect(dup.error).toMatchObject({ code: 'conflict', reason: 'exists' });
    expect((await json(await api(`/api/projects/${pid}/nodes`, { method: 'POST', body: { id: 'nueva', title: 'Nueva' } }), 400)).error.code).toBe('invalid');
  });
});
