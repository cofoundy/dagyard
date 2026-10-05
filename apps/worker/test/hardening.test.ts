/**
 * T-002: hallazgos de la revisión adversarial. Cada caso se vio en rojo contra el código anterior.
 * Las carreras se fuerzan con escrituras en paralelo contra el Worker real (DOs reales).
 */
import { demoProject, findCycle, type Blocker, type DagEvent, type ProjectSnapshot } from '@dagyard/model';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { seal, unseal } from '../src/crypto.js';
import { AGENT, BASE, OWNER, api, json, openLive, seedDemo, uniquePid } from './helpers.js';

const blockerOf = (s: ProjectSnapshot, nodeId: string) => s.blockers.find((b) => b.nodeId === nodeId)!;
const eventsOf = async (pid: string) => (await json<{ events: DagEvent[] }>(await api(`/api/projects/${pid}/events?since=0`), 200)).events;
const snap = async (pid: string) => json<ProjectSnapshot>(await api(`/api/projects/${pid}`), 200);

describe('1 · resolver dos veces a la vez', () => {
  it('uno gana (200) y el otro recibe 409 sin emitir eventos', async () => {
    for (let round = 0; round < 3; round++) {
      const s = await seedDemo();
      const pid = s.project.id;
      const b = blockerOf(s, 'comision');
      const resolve = (choice: number) =>
        api(`/api/projects/${pid}/blockers/${b.id}/resolve`, { method: 'POST', body: { choice }, headers: OWNER });
      const res = await Promise.all([resolve(0), resolve(1), resolve(0)]);
      expect(res.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      const evs = await eventsOf(pid);
      expect(evs.filter((e) => e.type === 'blocker.resolved')).toHaveLength(1);
      expect(evs.filter((e) => e.type === 'message.posted')).toHaveLength(1);
      expect((await snap(pid)).messages.filter((m) => m.text.startsWith('Gracias'))).toHaveLength(1);
    }
  });
});

describe('2 · nada se reescribe desde un estado viejo', () => {
  it('resolver mientras otro PATCH cambia el progreso: no se pierde el progreso', async () => {
    for (let round = 0; round < 3; round++) {
      const s = await seedDemo();
      const pid = s.project.id;
      const b = blockerOf(s, 'pagos');
      await Promise.all([
        api(`/api/projects/${pid}/blockers/${b.id}/resolve`, { method: 'POST', body: { value: 'clave' }, headers: OWNER }),
        api(`/api/projects/${pid}/nodes/pagos`, { method: 'PATCH', body: { progress: 0.77 } }),
      ]);
      const node = (await snap(pid)).nodes.find((n) => n.id === 'pagos')!;
      expect(node).toMatchObject({ status: 'working', progress: 0.77 });
    }
  });

  it('abrir un bloqueante mientras un PATCH marca la tarea lista: nunca queda lista con un bloqueante abierto', async () => {
    for (let round = 0; round < 3; round++) {
      const s = await seedDemo();
      const pid = s.project.id;
      await Promise.all([
        api(`/api/projects/${pid}/nodes/landing`, { method: 'PATCH', body: { status: 'done' } }),
        api(`/api/projects/${pid}/nodes/landing/blockers`, { method: 'POST', body: { kind: 'review', question: '¿Va?' } }),
      ]);
      // gana uno (#90: una pregunta no reabre una tarea cerrada): lista sin pregunta, o bloqueada con ella
      const after = await snap(pid);
      const open = after.blockers.some((x) => x.nodeId === 'landing' && x.status === 'open');
      expect(after.nodes.find((n) => n.id === 'landing')!.status).toBe(open ? 'blocked' : 'done');
    }
  });

  it('un mensaje con informe no pisa el estado de la tarea', async () => {
    for (let round = 0; round < 3; round++) {
      const s = await seedDemo();
      const pid = s.project.id;
      await Promise.all([
        api(`/api/projects/${pid}/nodes/landing/messages`, { method: 'POST', body: { text: 'Informe', reportUrl: 'https://basalt.example/r/9' } }),
        api(`/api/projects/${pid}/nodes/landing`, { method: 'PATCH', body: { status: 'working' } }),
      ]);
      const node = (await snap(pid)).nodes.find((n) => n.id === 'landing')!;
      expect(node).toMatchObject({ status: 'working', reportUrl: 'https://basalt.example/r/9' });
    }
  });
});

describe('3 · ciclos e ids se validan dentro de la transacción', () => {
  it('dos aristas opuestas a la vez: una entra y la otra es 400 cycle', async () => {
    for (let round = 0; round < 3; round++) {
      const s = await seedDemo();
      const pid = s.project.id;
      const res = await Promise.all([
        api(`/api/projects/${pid}/edges`, { method: 'POST', body: { from: 'landing', to: 'velocidad' } }),
        api(`/api/projects/${pid}/edges`, { method: 'POST', body: { from: 'velocidad', to: 'landing' } }),
      ]);
      expect(res.map((r) => r.status).sort()).toEqual([201, 400]);
      const after = await snap(pid);
      expect(findCycle(after.nodes.map((n) => n.id), after.edges)).toBeNull();
    }
  });

  it('la misma tarea creada dos veces a la vez: 201 y 409, nunca 500', async () => {
    const pid = uniquePid();
    await json(await api('/api/projects', { method: 'POST', body: { id: pid, name: 'Carrera', lang: 'es' } }), 201);
    const res = await Promise.all([0, 1, 2].map(() => api(`/api/projects/${pid}/nodes`, { method: 'POST', body: { stage: 'diseno', title: 'Doble' } })));
    expect(res.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it('el mismo proyecto creado dos veces a la vez: 201 y 409', async () => {
    const pid = uniquePid();
    const res = await Promise.all([0, 1].map(() => api('/api/projects', { method: 'POST', body: { id: pid, name: 'Doble' } })));
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('deps repetidas en un PUT se deduplican', async () => {
    const pid = uniquePid();
    const g = demoProject();
    g.nodes.find((n) => n.id === 'landing')!.deps = ['usuario', 'usuario'];
    const s = await json<ProjectSnapshot>(await api(`/api/projects/${pid}`, { method: 'PUT', body: g }), 200);
    expect(s.edges.filter((e) => e.to === 'landing')).toEqual([{ projectId: pid, from: 'usuario', to: 'landing' }]);
  });

  it('deps repetidas al crear una tarea se deduplican', async () => {
    const s = await seedDemo();
    const n = await api(`/api/projects/${s.project.id}/nodes`, { method: 'POST', body: { stage: 'pruebas', title: 'Otra', deps: ['landing', 'landing'] } });
    expect(n.status).toBe(201);
  });
});

describe('4 · el cifrado falla cerrado y amarra el valor a su bloqueante', () => {
  it('sin VAULT_KEY, seal y unseal fallan', async () => {
    await expect(seal('', 'x', 'p/b')).rejects.toThrow();
    const sealed = await seal('k', 'x', 'p/b');
    await expect(unseal('', sealed, 'p/b')).rejects.toThrow();
  });

  it('el cifrado lleva AAD = pid/bid: copiado a otro bloqueante no descifra', async () => {
    const sealed = await seal('k', 'secreto', 'proy/b_1');
    expect(await unseal('k', sealed, 'proy/b_1')).toBe('secreto');
    await expect(unseal('k', sealed, 'proy/b_2')).rejects.toThrow();
    await expect(unseal('k', sealed, 'otro/b_1')).rejects.toThrow();
  });

  it('el Worker sin VAULT_KEY responde 500 al resolver un acceso y no lo resuelve', async () => {
    const s = await seedDemo();
    const pid = s.project.id;
    const b = blockerOf(s, 'pagos');
    const noKey = Object.assign({}, env, { VAULT_KEY: '' });
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`${BASE}/api/projects/${pid}/blockers/${b.id}/resolve`, {
        method: 'POST',
        headers: { ...OWNER, 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'clave' }),
      }),
      noKey,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('internal');
    expect(blockerOf(await snap(pid), 'pagos').status).toBe('open');
  });

  it('el Worker sin VAULT_KEY responde 500 en wait en vez de entregar algo', async () => {
    const s = await seedDemo();
    const pid = s.project.id;
    const b = blockerOf(s, 'pagos');
    await json(await api(`/api/projects/${pid}/blockers/${b.id}/resolve`, { method: 'POST', body: { value: 'clave' }, headers: OWNER }), 200);
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`${BASE}/api/projects/${pid}/blockers/${b.id}/wait?timeout=0`, { headers: AGENT }),
      Object.assign({}, env, { VAULT_KEY: '' }),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(500);
    // con la clave correcta sí llega
    const ok = await json<{ blocker: Blocker; value: string }>(await api(`/api/projects/${pid}/blockers/${b.id}/wait?timeout=0`), 200);
    expect(ok.value).toBe('clave');
  });
});

describe('5 · WebSocket', () => {
  it('since mayor que el seq del proyecto → resync', async () => {
    const s = await seedDemo();
    const live = await openLive(s.project.id, `?since=${s.seq + 40}`);
    await live.waitFor((f) => f.type === 'resync');
    expect(live.frames).toEqual([
      { type: 'hello', projectId: s.project.id, seq: s.seq },
      { type: 'resync', seq: s.seq },
    ]);
    live.ws.close();
  });
});
