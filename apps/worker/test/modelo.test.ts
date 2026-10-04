/**
 * El modelo del DAG (#90, D12) en el Worker: dos aristas, cuatro tipos, cierre con motivo, ningún camino borra un nodo,
 * `next` ignora «nació de», PUT no borra y la migración v8. Contrato: docs/spec/modelo.md.
 */
import type { DagEvent, DagNode, NextResult, Origin, ProjectSnapshot } from '@dagyard/model';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate } from '../src/schema.js';
import { AGENT, OWNER, api, json, uniquePid } from './helpers.js';

const snap = (pid: string) => api(`/api/projects/${pid}`).then((r) => json<ProjectSnapshot>(r, 200));
const next = (pid: string) => api(`/api/projects/${pid}/next`).then((r) => json<NextResult>(r, 200));
const eventsSince = (pid: string, since: number) =>
  api(`/api/projects/${pid}/events?since=${since}`).then((r) => json<{ events: DagEvent[] }>(r, 200)).then((b) => b.events);
const addNode = (pid: string, body: unknown, headers = AGENT) => api(`/api/projects/${pid}/nodes`, { method: 'POST', body, headers });
const close = (pid: string, nid: string, body: unknown, headers = AGENT) => api(`/api/projects/${pid}/nodes/${nid}/close`, { method: 'POST', body, headers });
const patch = (pid: string, nid: string, body: unknown, headers = AGENT) => api(`/api/projects/${pid}/nodes/${nid}`, { method: 'PATCH', body, headers });
const edge = (pid: string, body: unknown, headers = AGENT) => api(`/api/projects/${pid}/edges`, { method: 'POST', body, headers });
const put = (pid: string, body: unknown, headers = AGENT) => api(`/api/projects/${pid}`, { method: 'PUT', body, headers });
const node = (s: ProjectSnapshot, id: string) => s.nodes.find((n) => n.id === id)!;

/** Un proyecto vacío en español (etapas por defecto). */
async function project(): Promise<string> {
  const pid = uniquePid('m');
  await json(await api('/api/projects', { method: 'POST', body: { id: pid, name: 'Modelo', lang: 'es' } }), 201);
  return pid;
}

describe('cuatro tipos (#90)', () => {
  it('goal y stream nacen vivos (working); request exige su cita; sin etapa va a la primera; todo nodo trae los campos nuevos', async () => {
    const pid = await project();
    const goal = await json<DagNode>(await addNode(pid, { id: 'g', title: 'Panel vivo', kind: 'goal' }), 201);
    expect(goal).toMatchObject({ kind: 'goal', status: 'working', stage: 'descubrimiento', quote: null, closedAs: null, closedReason: null, replacedBy: null, closedAt: null });
    expect(goal.bornAt).toBe(goal.createdAt);
    expect((await json<DagNode>(await addNode(pid, { id: 's', title: 'Deuda técnica', kind: 'stream' }), 201)).status).toBe('working');

    const r = await json(await addNode(pid, { id: 'r', title: 'Hazlo DAG', kind: 'request' }), 400);
    expect(r.error.message).toMatch(/cita/);
    const req = await json<DagNode>(await addNode(pid, { id: 'r', title: 'Hazlo DAG', kind: 'request', quote: 'no tenía que ser árbol, tenía que ser DAG', quoteBy: 'André' }), 201);
    expect(req).toMatchObject({ kind: 'request', status: 'pending', quote: 'no tenía que ser árbol, tenía que ser DAG', quoteBy: 'André' });
    await json(await addNode(pid, { id: 't', title: 'T', quote: 'cita' }), 400);
    await json(await addNode(pid, { id: 'g2', title: 'G', kind: 'goal', status: 'done' }), 400);
  });

  it('solo una task arranca: next nunca devuelve un goal, un request ni un stream', async () => {
    const pid = await project();
    await json(await addNode(pid, { id: 'g', title: 'G', kind: 'goal', status: 'pending' }), 201);
    await json(await addNode(pid, { id: 'r', title: 'R', kind: 'request', quote: 'q' }), 201);
    await json(await addNode(pid, { id: 's', title: 'S', kind: 'stream', status: 'pending' }), 201);
    expect((await next(pid)).node).toBeNull();
    await json(await addNode(pid, { id: 't', title: 'T' }), 201);
    expect((await next(pid)).node?.id).toBe('t');
  });

  it('bornAt: se puede traer del pasado, nunca del futuro (se recorta a ahora)', async () => {
    const pid = await project();
    const old = await json<DagNode>(await addNode(pid, { id: 'vieja', title: 'V', bornAt: '2026-10-01T09:00:00-05:00' }), 201);
    expect(old.bornAt).toBe('2026-10-01T14:00:00.000Z');
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const n = await json<DagNode>(await addNode(pid, { id: 'pronto', title: 'P', bornAt: soon }), 201);
    expect(n.bornAt).toBe(n.createdAt);
  });

  it('PATCH: kind y cita se validan contra lo guardado; un goal no se cierra con status done', async () => {
    const pid = await project();
    await json(await addNode(pid, { id: 'a', title: 'A' }), 201);
    await json(await addNode(pid, { id: 'b', title: 'B', deps: ['a'] }), 201);
    await json(await patch(pid, 'a', { kind: 'request' }), 400); // sin cita
    expect(await json<DagNode>(await patch(pid, 'a', { kind: 'request', quote: 'hazlo' }), 200)).toMatchObject({ kind: 'request', quote: 'hazlo' });
    // dejar de ser pedido limpia la cita
    expect(await json<DagNode>(await patch(pid, 'a', { kind: 'task' }), 200)).toMatchObject({ kind: 'task', quote: null, quoteBy: null });
    // «b» necesita a «a»: «a» no puede volverse goal
    await json(await patch(pid, 'a', { kind: 'goal' }), 400);
    await json(await addNode(pid, { id: 'g', title: 'G', kind: 'goal' }), 201);
    const r = await json(await patch(pid, 'g', { status: 'done' }), 400);
    expect(r.error.message).toMatch(/no se cierra como «done»/);
    await json(await patch(pid, 'g', { closedAs: 'dropped' }), 400);
  });
});

describe('dos aristas (#90)', () => {
  it('«nació de» va en origins, con su porqué, y nunca aparece en edges; «necesita» sigue igual', async () => {
    const pid = await project();
    await json(await addNode(pid, { id: 'g', title: 'G', kind: 'goal' }), 201);
    await json(await addNode(pid, { id: 'a', title: 'A' }), 201);
    const seq = (await snap(pid)).seq;
    const t = await json<DagNode>(await addNode(pid, { id: 't', title: 'T', deps: ['a'], origins: [{ from: 'g', why: 'para llegar al panel' }, { from: 'a' }] }), 201);
    expect(t.id).toBe('t');
    const s = await snap(pid);
    expect(s.edges.map((e) => [e.from, e.to])).toEqual([['a', 't']]);
    expect(s.origins!.map((o) => [o.from, o.to, o.why])).toEqual([['g', 't', 'para llegar al panel'], ['a', 't', null]]);
    expect((await eventsSince(pid, seq)).map((e) => e.type)).toEqual(['node.added', 'edge.added', 'origin.added', 'origin.added']);

    // por la ruta de aristas, con las dos al mismo vecino
    const o = await json<Origin>(await edge(pid, { from: 'a', to: 'g', kind: 'origin', why: 'x' }), 201);
    expect(o).toMatchObject({ from: 'a', to: 'g', why: 'x' });
    await json(await edge(pid, { from: 'a', to: 'g', kind: 'origin' }), 409);
  });

  it('ciclos prohibidos en cada arista por separado; nada necesita un goal ni un stream', async () => {
    const pid = await project();
    for (const id of ['a', 'b']) await json(await addNode(pid, { id, title: id }), 201);
    await json(await edge(pid, { from: 'a', to: 'b' }), 201);
    // b necesita a y además nació de a: las dos aristas con el mismo vecino
    await json(await edge(pid, { from: 'a', to: 'b', kind: 'origin' }), 201);
    // a nació de b cerraría el ciclo de «nació de»; a necesita b, el de «necesita»: cada uno por su cuenta
    expect((await json(await edge(pid, { from: 'b', to: 'a', kind: 'origin' }), 400)).error.code).toBe('cycle');
    expect((await json(await edge(pid, { from: 'b', to: 'a' }), 400)).error.code).toBe('cycle');
    // c nació de b y b necesita c: no es ciclo, son aristas distintas
    await json(await addNode(pid, { id: 'c', title: 'c', origins: [{ from: 'b' }] }), 201);
    await json(await edge(pid, { from: 'c', to: 'b' }), 201);

    await json(await addNode(pid, { id: 'g', title: 'G', kind: 'goal' }), 201);
    await json(await addNode(pid, { id: 's', title: 'S', kind: 'stream' }), 201);
    expect((await json(await edge(pid, { from: 'g', to: 'a' }), 400)).error.message).toMatch(/nunca se cierra/);
    await json(await edge(pid, { from: 's', to: 'a' }), 400);
    await json(await addNode(pid, { id: 'd', title: 'd', deps: ['g'] }), 400);
    // al revés sí: un goal puede necesitar tareas
    await json(await edge(pid, { from: 'a', to: 'g' }), 201);
  });

  it('quitar un «nació de» es solo del dueño (es el porqué); un «necesita», de los dos', async () => {
    const pid = await project();
    for (const id of ['a', 'b']) await json(await addNode(pid, { id, title: id }), 201);
    await json(await edge(pid, { from: 'a', to: 'b', kind: 'origin' }), 201);
    await json(await edge(pid, { from: 'a', to: 'b' }), 201);
    const seq = (await snap(pid)).seq;
    expect((await api(`/api/projects/${pid}/edges?from=a&to=b&kind=origin`, { method: 'DELETE', headers: AGENT })).status).toBe(403);
    expect((await api(`/api/projects/${pid}/edges?from=a&to=b`, { method: 'DELETE', headers: AGENT })).status).toBe(204);
    expect((await snap(pid)).origins).toHaveLength(1);
    expect((await api(`/api/projects/${pid}/edges?from=a&to=b&kind=origin`, { method: 'DELETE', headers: OWNER })).status).toBe(204);
    expect((await snap(pid)).origins).toEqual([]);
    expect((await eventsSince(pid, seq)).map((e) => e.type)).toEqual(['edge.removed', 'origin.removed']);
  });

  it('`next` ignora origins: nacer de una tarea abierta no bloquea', async () => {
    const pid = await project();
    await json(await addNode(pid, { id: 'a', title: 'A', status: 'working' }), 201);
    await json(await addNode(pid, { id: 'b', title: 'B', origins: [{ from: 'a' }] }), 201);
    expect((await next(pid)).node?.id).toBe('b');
  });
});

describe('cierre con motivo (#90)', () => {
  it('una task lista exige evidencia; cerrar dos veces → 409; emite node.updated', async () => {
    const pid = await project();
    await json(await addNode(pid, { id: 'a', title: 'A', status: 'working' }), 201);
    expect((await json(await close(pid, 'a', { as: 'done' }), 400)).error.message).toMatch(/evidencia/);
    const seq = (await snap(pid)).seq;
    const a = await json<DagNode>(await close(pid, 'a', { as: 'done', reportUrl: 'https://basalt.example/r/1' }), 200);
    expect(a).toMatchObject({ status: 'done', progress: 1, closedAs: 'done', closedReason: null, reportUrl: 'https://basalt.example/r/1' });
    expect(a.closedAt).toBe(a.doneAt);
    expect((await eventsSince(pid, seq)).map((e) => e.type)).toEqual(['node.updated']);
    expect((await json(await close(pid, 'a', { as: 'dropped', why: 'x' }), 409)).error.code).toBe('conflict');
    // con un porqué también vale como evidencia; un request no la necesita
    await json(await addNode(pid, { id: 'b', title: 'B' }), 201);
    expect((await json<DagNode>(await close(pid, 'b', { as: 'done', why: 'quedó en main' }), 200)).closedReason).toBe('quedó en main');
    await json(await addNode(pid, { id: 'r', title: 'R', kind: 'request', quote: 'q' }), 201);
    await json(await close(pid, 'r', { as: 'done' }), 200);
  });

  it('dropped y learned piden porqué; goal y stream no se cierran como done pero sí con otro motivo', async () => {
    const pid = await project();
    for (const id of ['a', 'b']) await json(await addNode(pid, { id, title: id }), 201);
    await json(await close(pid, 'a', { as: 'dropped' }), 400);
    expect(await json<DagNode>(await close(pid, 'a', { as: 'dropped', why: 'ya no aplica' }), 200)).toMatchObject({ closedAs: 'dropped', closedReason: 'ya no aplica', status: 'done' });
    expect((await json<DagNode>(await close(pid, 'b', { as: 'learned', why: 'el spike dijo que no' }), 200)).closedAs).toBe('learned');
    await json(await addNode(pid, { id: 'g', title: 'G', kind: 'goal' }), 201);
    await json(await close(pid, 'g', { as: 'done', why: 'x' }), 400);
    expect((await json<DagNode>(await close(pid, 'g', { as: 'learned', why: 'cambió el norte' }), 200)).closedAs).toBe('learned');
  });

  it('replaced: by obligatorio y existente, sin ciclos; next sigue replacedBy hasta el último', async () => {
    const pid = await project();
    await json(await addNode(pid, { id: 'a', title: 'A', status: 'working' }), 201);
    await json(await addNode(pid, { id: 'b', title: 'B', deps: ['a'] }), 201);
    await json(await addNode(pid, { id: 'a2', title: 'A2', status: 'working' }), 201);
    await json(await close(pid, 'a', { as: 'replaced', why: 'partida' }), 400);
    await json(await close(pid, 'a', { as: 'replaced', by: 'nadie', why: 'x' }), 400);
    await json(await close(pid, 'a', { as: 'replaced', by: 'a', why: 'x' }), 400);
    expect(await json<DagNode>(await close(pid, 'a', { as: 'replaced', by: 'a2', why: 'partida en dos' }), 200)).toMatchObject({ closedAs: 'replaced', replacedBy: 'a2' });
    // «a» cerrada, pero su reemplazo sigue abierto: «b» espera
    expect((await next(pid)).node).toBeNull();
    // a2 no puede reemplazarse por a (cerraría el ciclo de reemplazos)
    await json(await patch(pid, 'a', { status: 'pending' }), 200); // reabrir a
    await json(await close(pid, 'a', { as: 'replaced', by: 'a2', why: 'otra vez' }), 200);
    expect((await json(await close(pid, 'a2', { as: 'replaced', by: 'a', why: 'x' }), 400)).error.code).toBe('cycle');
    await json(await close(pid, 'a2', { as: 'done', why: 'lista' }), 200);
    expect((await next(pid)).node?.id).toBe('b');
  });

  it('con una pregunta abierta → 409; reabrir con PATCH limpia los cuatro campos de cierre', async () => {
    const pid = await project();
    await json(await addNode(pid, { id: 'a', title: 'A', status: 'working' }), 201);
    await json(await api(`/api/projects/${pid}/nodes/a/blockers`, { method: 'POST', body: { kind: 'decision', question: '¿Sí?', options: ['Sí'] } }), 201);
    expect((await json(await close(pid, 'a', { as: 'dropped', why: 'x' }), 409)).error.message).toMatch(/bloqueante abierto/);

    await json(await addNode(pid, { id: 'b', title: 'B' }), 201);
    await json(await close(pid, 'b', { as: 'learned', why: 'aprendimos' }), 200);
    expect(await json<DagNode>(await patch(pid, 'b', { status: 'working' }), 200)).toMatchObject({ status: 'working', closedAs: null, closedReason: null, replacedBy: null, closedAt: null });
    // PATCH status done cierra como done (sin exigir evidencia: `dagyard done` y el pulso de la demo siguen igual)
    expect(await json<DagNode>(await patch(pid, 'b', { status: 'done' }), 200)).toMatchObject({ closedAs: 'done', progress: 1 });
  });
});

describe('ningún camino borra un nodo (#90)', () => {
  it('DELETE descarta (dueño): cierra como dropped con ?why=; el agente → 403; nunca emite node.removed', async () => {
    const pid = await project();
    await json(await addNode(pid, { id: 'a', title: 'A' }), 201);
    await json(await api(`/api/projects/${pid}/nodes/a`, { method: 'DELETE', headers: AGENT }), 403);
    const seq = (await snap(pid)).seq;
    const a = await json<DagNode>(await api(`/api/projects/${pid}/nodes/a?why=duplicada`, { method: 'DELETE', headers: OWNER }), 200);
    expect(a).toMatchObject({ status: 'done', closedAs: 'dropped', closedReason: 'duplicada' });
    expect((await snap(pid)).nodes.map((n) => n.id)).toEqual(['a']);
    expect((await eventsSince(pid, seq)).map((e) => e.type)).toEqual(['node.updated']);
  });

  it('PUT en un proyecto existente: el nodo que no viene queda cerrado como dropped, con aristas, orígenes y mensajes; los orígenes se suman', async () => {
    const pid = uniquePid('m');
    const g1 = {
      name: 'Import',
      lang: 'en',
      nodes: [
        { id: 'g', title: 'G', kind: 'goal' },
        { id: 'a', title: 'A', origins: [{ from: 'g', why: 'el porqué' }] },
        { id: 'b', title: 'B', deps: ['a'], origins: [{ from: 'g' }] },
        { id: 'c', title: 'C', status: 'done' },
      ],
      messages: [{ nodeId: 'b', text: 'avanzo' }],
    };
    const first = await json<ProjectSnapshot>(await put(pid, g1), 200);
    expect(first.origins).toHaveLength(2);
    // el agente la toma y deja un origen más por la API granular
    await json(await edge(pid, { from: 'a', to: 'b', kind: 'origin', why: 'salió de A' }), 201);

    // el segundo import no trae «b» ni «c», y no dice el kind de «g»
    const g2 = { name: 'Import', nodes: [{ id: 'g', title: 'G' }, { id: 'a', title: 'A' }, { id: 'd', title: 'D', origins: [{ from: 'a' }] }] };
    for (const headers of [AGENT, OWNER]) {
      const s = await json<ProjectSnapshot>(await put(pid, g2, headers), 200);
      expect(s.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c', 'd', 'g']);
      expect(node(s, 'g')).toMatchObject({ kind: 'goal', status: 'working' });
      expect(node(s, 'b')).toMatchObject({ status: 'done', closedAs: 'dropped', closedReason: 'not in the import' });
      // «c» ya estaba cerrada: conserva su cierre
      expect(node(s, 'c')).toMatchObject({ closedAs: 'done' });
      expect(s.edges.map((e) => [e.from, e.to])).toEqual([['a', 'b']]);
      expect(s.origins!.map((o) => [o.from, o.to]).sort()).toEqual([['a', 'b'], ['a', 'd'], ['g', 'a'], ['g', 'b']]);
      expect(s.origins!.find((o) => o.from === 'g' && o.to === 'a')?.why).toBe('el porqué');
      expect(s.messages.map((m) => m.text)).toEqual(['avanzo']);
    }
  });

  it('PUT: un request guardado conserva su cita si el cuerpo no la trae; si pasa a task, la pierde', async () => {
    const pid = uniquePid('m');
    await json(await put(pid, { name: 'P', nodes: [{ id: 'r', title: 'R', kind: 'request', quote: 'hazlo DAG', quoteBy: 'André' }] }), 200);
    let s = await json<ProjectSnapshot>(await put(pid, { name: 'P', nodes: [{ id: 'r', title: 'R' }] }), 200);
    expect(node(s, 'r')).toMatchObject({ kind: 'request', quote: 'hazlo DAG', quoteBy: 'André' });
    s = await json<ProjectSnapshot>(await put(pid, { name: 'P', nodes: [{ id: 'r', title: 'R', kind: 'task' }] }), 200);
    expect(node(s, 'r')).toMatchObject({ kind: 'task', quote: null, quoteBy: null });
  });

  it('PUT que cambia etapas y deja huérfano a un nodo que no viene → 400; un «necesita» desde un goal guardado → 400', async () => {
    const pid = uniquePid('m');
    await json(await put(pid, { name: 'P', lang: 'es', nodes: [{ id: 'g', title: 'G', kind: 'goal' }, { id: 'a', title: 'A', stage: 'pruebas' }] }), 200);
    const r = await json(await put(pid, { name: 'P', stages: ['Construcción'], nodes: [{ id: 'g', title: 'G' }] }), 400);
    expect(r.error.message).toMatch(/«A»/);
    // «g» es goal guardado aunque el cuerpo no lo diga
    await json(await put(pid, { name: 'P', nodes: [{ id: 'g', title: 'G' }, { id: 'a', title: 'A', stage: 'pruebas', deps: ['g'] }] }), 400);
  });
});

describe('migración v8 (#90): kind, born_at, cierre y origins', () => {
  it('una base v7 queda con task, born_at = created_at, los done cerrados como done y la tabla origins', async () => {
    const stub = env.STORE.get(env.STORE.idFromName(`mig-${crypto.randomUUID()}`));
    const out = await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      for (const t of ['teams', 'events', 'messages', 'blockers', 'origins', 'edges', 'nodes', 'idempotency', 'sessions', 'projects', '_schema'])
        sql.exec(`DROP TABLE IF EXISTS ${t}`);
      migrate(sql, 7);
      const T = (m: number) => `2026-10-04T10:0${m}:00.000Z`;
      sql.exec("INSERT INTO projects (id, name, stages, created_at, updated_at) VALUES ('p', 'P', '[]', ?, ?)", T(0), T(0));
      const ins = (id: string, status: string, created: number, updated: number, doneAt: string | null) =>
        sql.exec("INSERT INTO nodes (project_id, id, stage, title, status, done_at, created_at, updated_at) VALUES ('p', ?, 's', ?, ?, ?, ?, ?)", id, id, status, doneAt, T(created), T(updated));
      ins('lista', 'done', 1, 5, T(4));
      ins('vieja', 'done', 1, 6, null); // done sin done_at (antes de #75): cierra en updated_at
      ins('abierta', 'working', 2, 3, null);
      sql.exec("INSERT INTO edges (project_id, from_id, to_id) VALUES ('p', 'lista', 'abierta')");
      migrate(sql);
      migrate(sql);
      return {
        versions: sql.exec('SELECT version FROM _schema ORDER BY version').toArray().map((r) => r.version),
        nodes: sql.exec('SELECT id, kind, born_at, quote, closed_as, closed_reason, replaced_by, closed_at FROM nodes ORDER BY id').toArray(),
        edges: sql.exec('SELECT from_id, to_id FROM edges').toArray(),
        origins: sql.exec('SELECT COUNT(*) AS n FROM origins').one().n,
      };
    });
    const T = (m: number) => `2026-10-04T10:0${m}:00.000Z`;
    expect(out.versions).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(out.nodes).toEqual([
      { id: 'abierta', kind: 'task', born_at: T(2), quote: null, closed_as: null, closed_reason: null, replaced_by: null, closed_at: null },
      { id: 'lista', kind: 'task', born_at: T(1), quote: null, closed_as: 'done', closed_reason: null, replaced_by: null, closed_at: T(4) },
      { id: 'vieja', kind: 'task', born_at: T(1), quote: null, closed_as: 'done', closed_reason: null, replaced_by: null, closed_at: T(6) },
    ]);
    expect(out.edges).toEqual([{ from_id: 'lista', to_id: 'abierta' }]);
    expect(out.origins).toBe(0);
  });
});
