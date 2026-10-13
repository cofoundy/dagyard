/**
 * La fábrica en el tiempo (#75): equipos, tiempos por tarea y `team.updated`. Contrato: docs/spec/tiempo.md.
 */
import type { Blocker, DagEvent, DagNode, ProjectSnapshot, Team } from '@dagyard/model';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { parseLedger, teamPatchFromLedger, teamsFromLedger } from '../../../packages/cli/src/ledger.js';
import { MIGRATIONS, migrate } from '../src/schema.js';
import sitesCopy from './fixtures/sites.json';
import { AGENT, OWNER, api, json, uniquePid } from './helpers.js';

const snap = (pid: string) => api(`/api/projects/${pid}`).then((r) => json<ProjectSnapshot>(r, 200));
const seqOf = async (pid: string) => (await snap(pid)).seq;
const eventsSince = (pid: string, since: number) =>
  api(`/api/projects/${pid}/events?since=${since}`).then((r) => json<{ events: DagEvent[] }>(r, 200)).then((b) => b.events);
const putTeam = (pid: string, tid: string, body: unknown, headers: Record<string, string> = AGENT) =>
  api(`/api/projects/${pid}/teams/${tid}`, { method: 'PUT', body, headers });
const patchNode = (pid: string, nid: string, body: unknown, headers: Record<string, string> = AGENT) =>
  api(`/api/projects/${pid}/nodes/${nid}`, { method: 'PATCH', body, headers });
const node = (s: ProjectSnapshot, id: string) => s.nodes.find((n) => n.id === id)!;

/** Un proyecto con tres tareas pendientes («a», «b», «c»). */
async function project(nodes: Array<{ id: string; status?: DagNode['status'] }> = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]): Promise<string> {
  const pid = uniquePid('t');
  await json(
    await api(`/api/projects/${pid}`, {
      method: 'PUT',
      body: { name: 'Tiempo', lang: 'es', nodes: nodes.map((n) => ({ id: n.id, stage: 'construccion', title: n.id.toUpperCase(), ...(n.status && { status: n.status }) })) },
    }),
    200,
  );
  return pid;
}

/* ------------------------------------------------------------------ migración */

describe('migración v7 (#75): tabla teams, tiempos por tarea y backfill desde el log', () => {
  it('una base v6 con historia queda con started_at (primer working) y done_at (la última llegada a done)', async () => {
    // un Store aparte: su base se rehace como v6, se llena y se migra; no toca la del resto de los tests
    const stub = env.STORE.get(env.STORE.idFromName(`mig-${crypto.randomUUID()}`));
    const rows = await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      for (const t of ['teams', 'events', 'messages', 'blockers', 'origins', 'edges', 'nodes', 'idempotency', 'sessions', 'projects', '_schema'])
        sql.exec(`DROP TABLE IF EXISTS ${t}`);
      migrate(sql, 6);
      const T = (m: number) => `2026-10-04T10:${String(m).padStart(2, '0')}:00.000Z`;
      for (const pid of ['p', 'q'])
        sql.exec("INSERT INTO projects (id, name, stages, created_at, updated_at) VALUES (?, 'P', '[]', ?, ?)", pid, T(0), T(0));
      const nodes: Array<[string, string, string]> = [
        ['p', 'a', 'done'], // working 01 → done 03 → done otra vez 04 (adoptó un informe): done_at = 03
        ['p', 'b', 'done'], // working 01 → done 02 → working 03 → done 05: done_at = 05
        ['p', 'c', 'working'], // working 01 → done 02 → working 03: done_at null
        ['p', 'd', 'done'], // llegó con un PUT: sin eventos propios, sin tiempos
        ['p', 'e', 'pending'],
        ['p', 'f', 'working'], // pending → blocked 01 → working 02 (el dueño respondió): started_at = 02
        ['q', 'a', 'pending'], // mismo id en otro proyecto: sus eventos no se cruzan
      ];
      for (const [pid, id, status] of nodes)
        sql.exec("INSERT INTO nodes (project_id, id, stage, title, status, created_at, updated_at) VALUES (?, ?, 's', ?, ?, ?, ?)", pid, id, id, status, T(0), T(0));
      const seq: Record<string, number> = {};
      const ev = (pid: string, type: string, m: number, payload: unknown) => {
        seq[pid] = (seq[pid] ?? 0) + 1;
        sql.exec("INSERT INTO events (project_id, seq, type, actor, at, payload) VALUES (?, ?, ?, 'agent', ?, ?)", pid, seq[pid]!, type, T(m), JSON.stringify(payload));
      };
      const n = (pid: string, id: string, status: string, m: number, type = 'node.updated') => ev(pid, type, m, { node: { id, status } });
      ev('q', 'node.updated', 0, { node: { id: 'a', status: 'working' } });
      n('q', 'a', 'done', 0);
      ev('p', 'project.replaced', 0, { project: { id: 'p' } });
      n('p', 'a', 'pending', 0, 'node.added');
      n('p', 'e', 'pending', 0, 'node.added');
      n('p', 'f', 'pending', 0, 'node.added');
      n('p', 'a', 'working', 1);
      n('p', 'b', 'working', 1);
      n('p', 'c', 'working', 1);
      n('p', 'f', 'blocked', 1);
      ev('p', 'message.posted', 1, { message: { id: 'm_1', nodeId: 'a' } });
      n('p', 'a', 'working', 2);
      n('p', 'b', 'done', 2);
      n('p', 'c', 'done', 2);
      n('p', 'f', 'working', 2);
      n('p', 'a', 'done', 3);
      n('p', 'b', 'working', 3);
      n('p', 'c', 'working', 3);
      n('p', 'a', 'done', 4);
      n('p', 'b', 'done', 5);

      migrate(sql);
      migrate(sql); // ya en la última: no vuelve a correr nada
      return {
        nodes: sql.exec('SELECT project_id, id, started_at, done_at, team_id FROM nodes ORDER BY project_id, id').toArray(),
        teams: sql.exec('SELECT COUNT(*) AS n FROM teams').one().n,
        versions: sql.exec('SELECT version FROM _schema ORDER BY version').toArray().map((r) => r.version),
      };
    });
    const T = (m: number) => `2026-10-04T10:0${m}:00.000Z`;
    expect(rows.versions).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(rows.teams).toBe(0);
    expect(rows.nodes).toEqual([
      { project_id: 'p', id: 'a', started_at: T(1), done_at: T(3), team_id: null },
      { project_id: 'p', id: 'b', started_at: T(1), done_at: T(5), team_id: null },
      { project_id: 'p', id: 'c', started_at: T(1), done_at: null, team_id: null },
      { project_id: 'p', id: 'd', started_at: null, done_at: null, team_id: null },
      { project_id: 'p', id: 'e', started_at: null, done_at: null, team_id: null },
      { project_id: 'p', id: 'f', started_at: T(2), done_at: null, team_id: null },
      { project_id: 'q', id: 'a', started_at: T(0), done_at: null, team_id: null },
    ]);
  });
});

/* ------------------------------------------------------------------ PUT /teams/:tid */

describe('PUT /api/projects/:pid/teams/:tid (#75)', () => {
  it('crea con lo que trae (fechas normalizadas, nombre desde el slug) y emite team.updated', async () => {
    const pid = await project();
    const seq = await seqOf(pid);
    const team = await json<Team>(await putTeam(pid, 'demo-viva', { nodeIds: ['gh-74', 'gh-74', 'gh-80'], startedAt: '2026-10-04T19:05:12Z' }), 200);
    expect(team).toMatchObject({
      id: 'demo-viva',
      projectId: pid,
      name: 'Demo viva',
      nodeIds: ['gh-74', 'gh-80'],
      requestedAt: null,
      startedAt: '2026-10-04T19:05:12.000Z',
      closedAt: null,
      outcome: null,
    });
    const events = await eventsSince(pid, seq);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'team.updated', actor: 'agent', payload: { team } });
    expect((await snap(pid)).teams).toEqual([team]);
  });

  it('es idempotente: el mismo upsert (aunque la fecha venga escrita de otra forma) no escribe ni emite', async () => {
    const pid = await project();
    const body = { name: 'Núcleo', nodeIds: ['gh-2'], requestedAt: '2026-10-04T05:35:20Z', startedAt: '2026-10-04T05:36:46Z', closedAt: '2026-10-04T06:38:36Z', outcome: 'merged' };
    const first = await json<Team>(await putTeam(pid, 'nucleo', body), 200);
    const seq = await seqOf(pid);
    const again = await json<Team>(await putTeam(pid, 'nucleo', body, OWNER), 200);
    const otherForm = await json<Team>(await putTeam(pid, 'nucleo', { startedAt: '2026-10-04T00:36:46.000-05:00' }), 200);
    const empty = await json<Team>(await putTeam(pid, 'nucleo', {}), 200);
    for (const t of [again, otherForm, empty]) expect(t).toEqual(first);
    expect(await seqOf(pid)).toBe(seq);
  });

  it('upsert parcial: lo que no viene no se toca; null borra; nodeIds reemplaza la lista', async () => {
    const pid = await project();
    await json(await putTeam(pid, 'tiempo', { name: 'Tiempo', nodeIds: ['gh-75'], startedAt: '2026-10-04T19:07:42Z' }), 200);
    const closed = await json<Team>(await putTeam(pid, 'tiempo', { closedAt: '2026-10-04T23:00:00Z', outcome: 'merged' }, OWNER), 200);
    expect(closed).toMatchObject({ name: 'Tiempo', nodeIds: ['gh-75'], startedAt: '2026-10-04T19:07:42.000Z', closedAt: '2026-10-04T23:00:00.000Z', outcome: 'merged' });
    const reopened = await json<Team>(await putTeam(pid, 'tiempo', { closedAt: null, outcome: null, nodeIds: ['gh-75', 'gh-90'] }), 200);
    expect(reopened).toMatchObject({ closedAt: null, outcome: null, nodeIds: ['gh-75', 'gh-90'], startedAt: '2026-10-04T19:07:42.000Z' });
  });

  it('el snapshot los ordena por startedAt, los que no arrancaron al final', async () => {
    const pid = await project();
    await json(await putTeam(pid, 'sin-arrancar', { requestedAt: '2026-10-04T01:00:00Z' }), 200);
    await json(await putTeam(pid, 'tarde', { startedAt: '2026-10-04T09:00:00Z' }), 200);
    await json(await putTeam(pid, 'temprano', { startedAt: '2026-10-04T08:00:00Z' }), 200);
    expect((await snap(pid)).teams!.map((t) => t.id)).toEqual(['temprano', 'tarde', 'sin-arrancar']);
  });

  it('valida: slug, fechas ISO, nodeIds ≤ 50, campos conocidos; un proyecto que no existe es 404', async () => {
    const pid = await project();
    const bad = async (tid: string, body: unknown, status = 400) => json(await putTeam(pid, tid, body), status);
    await bad('Mal_Id', {});
    await bad('x', { startedAt: 'ayer' });
    await bad('x', { startedAt: '2026-10-04' });
    await bad('x', { nodeIds: Array.from({ length: 51 }, (_, i) => `gh-${i}`) });
    await bad('x', { nodeIds: ['No Vale'] });
    await bad('x', { color: 'rojo' });
    await bad('x', { name: '' });
    await bad('x', { outcome: 'x'.repeat(1001) });
    await json(await putTeam(uniquePid('nadie'), 'x', {}), 404);
    expect((await snap(pid)).teams).toEqual([]);
  });

  it('un PUT del grafo no toca los equipos; borrar el proyecto los borra', async () => {
    const pid = await project();
    await json(await putTeam(pid, 'nucleo', { startedAt: '2026-10-04T05:36:46Z' }), 200);
    await json(await api(`/api/projects/${pid}`, { method: 'PUT', body: { name: 'Otro', nodes: [] }, headers: OWNER }), 200);
    expect((await snap(pid)).teams!.map((t) => t.id)).toEqual(['nucleo']);
    expect((await api(`/api/projects/${pid}`, { method: 'DELETE', headers: OWNER })).status).toBe(204);
    await json(await api(`/api/projects/${pid}`, { method: 'PUT', body: { name: 'Recreado', nodes: [] }, headers: OWNER }), 200);
    expect((await snap(pid)).teams).toEqual([]);
  });
});

/* ------------------------------------------------------------------ tiempos por tarea */

describe('startedAt / doneAt los pone el servidor en las transiciones (#75)', () => {
  it('PATCH: primer working fija startedAt; done fija doneAt; repetir done lo conserva; salir de done lo limpia', async () => {
    const pid = await project();
    expect(node(await snap(pid), 'a')).toMatchObject({ startedAt: null, doneAt: null, teamId: null });
    const started = await json<DagNode>(await patchNode(pid, 'a', { status: 'working' }), 200);
    expect(started.startedAt).toEqual(expect.any(String));
    const moved = await json<DagNode>(await patchNode(pid, 'a', { progress: 0.5 }), 200);
    expect(moved).toMatchObject({ startedAt: started.startedAt, doneAt: null });
    const done = await json<DagNode>(await patchNode(pid, 'a', { status: 'done' }), 200);
    expect(done.startedAt).toBe(started.startedAt);
    expect(done.doneAt! > started.startedAt!).toBe(true);
    const doneAgain = await json<DagNode>(await patchNode(pid, 'a', { status: 'done', reportUrl: 'https://x.dev/r' }), 200);
    expect(doneAgain.doneAt).toBe(done.doneAt);
    const reopened = await json<DagNode>(await patchNode(pid, 'a', { status: 'working' }), 200);
    expect(reopened).toMatchObject({ startedAt: started.startedAt, doneAt: null });
    expect(node(await snap(pid), 'a')).toMatchObject({ startedAt: started.startedAt, doneAt: null });
  });

  it('el cliente no los escribe', async () => {
    const pid = await project();
    for (const k of ['startedAt', 'doneAt']) await json(await patchNode(pid, 'a', { [k]: '2026-10-04T10:00:00Z' }), 400);
  });

  it('por bloqueantes: una lista no se bloquea (#90); reabrirla le quita doneAt; responder la pone en marcha (startedAt si nunca arrancó)', async () => {
    const pid = await project([{ id: 'a' }, { id: 'b', status: 'done' }]);
    const s0 = await snap(pid);
    expect(node(s0, 'b').doneAt).toEqual(expect.any(String));
    const block = (nid: string) =>
      api(`/api/projects/${pid}/nodes/${nid}/blockers`, { method: 'POST', body: { kind: 'decision', question: '¿Seguimos?', options: ['Sí', 'No'] } }).then((r) =>
        json<Blocker>(r, 201),
      );
    // #90: una lista no se bloquea (409); se reabre primero, y ahí pierde doneAt
    await json(await api(`/api/projects/${pid}/nodes/b/blockers`, { method: 'POST', body: { kind: 'decision', question: '¿Seguimos?', options: ['Sí'] } }), 409);
    expect(node(await snap(pid), 'b')).toMatchObject({ status: 'done', doneAt: node(s0, 'b').doneAt });
    await json(await api(`/api/projects/${pid}/nodes/b`, { method: 'PATCH', body: { status: 'working' } }), 200);
    const bb = await block('b');
    expect(node(await snap(pid), 'b')).toMatchObject({ status: 'blocked', doneAt: null });
    const ba = await block('a');
    expect(node(await snap(pid), 'a')).toMatchObject({ status: 'blocked', startedAt: null });
    for (const b of [ba, bb]) await json(await api(`/api/projects/${pid}/blockers/${b.id}/resolve`, { method: 'POST', body: { choice: 0 }, headers: OWNER }), 200);
    const s = await snap(pid);
    expect(node(s, 'a')).toMatchObject({ status: 'working', startedAt: expect.any(String), doneAt: null });
    expect(node(s, 'b')).toMatchObject({ status: 'working', doneAt: null });
  });

  it('una tarea que nace en marcha o lista nace con su hora (POST y PUT)', async () => {
    const pid = await project([{ id: 'w', status: 'working' }, { id: 'd', status: 'done' }, { id: 'p' }]);
    const s = await snap(pid);
    expect(node(s, 'w')).toMatchObject({ startedAt: expect.any(String), doneAt: null });
    expect(node(s, 'd')).toMatchObject({ startedAt: null, doneAt: expect.any(String) });
    expect(node(s, 'p')).toMatchObject({ startedAt: null, doneAt: null });
    const added = await json<DagNode>(await api(`/api/projects/${pid}/nodes`, { method: 'POST', body: { id: 'n', stage: 'construccion', title: 'N', status: 'done' } }), 201);
    expect(added).toMatchObject({ startedAt: null, doneAt: expect.any(String), teamId: null });
  });

  it('un PUT del grafo (agente o dueño) conserva los tiempos y el equipo de las tareas que siguen', async () => {
    const pid = await project();
    await json(await patchNode(pid, 'a', { status: 'working', teamId: 'tiempo' }), 200);
    await json(await patchNode(pid, 'b', { status: 'working' }), 200);
    await json(await patchNode(pid, 'b', { status: 'done' }), 200);
    const before = await snap(pid);
    const graph = { name: 'Tiempo', nodes: [{ id: 'a', stage: 'construccion', title: 'A', status: 'working' }, { id: 'b', stage: 'construccion', title: 'B', status: 'done' }, { id: 'c', stage: 'construccion', title: 'C' }] };
    for (const headers of [AGENT, OWNER]) {
      const after = await json<ProjectSnapshot>(await api(`/api/projects/${pid}`, { method: 'PUT', body: graph, headers }), 200);
      for (const id of ['a', 'b', 'c'])
        expect(node(after, id), `${id} tras el PUT`).toMatchObject({ startedAt: node(before, id).startedAt, doneAt: node(before, id).doneAt, teamId: node(before, id).teamId });
    }
    // vuelve a pendiente: no arrancó; deja de estar lista: sin doneAt
    const back = { ...graph, nodes: graph.nodes.map((n) => ({ ...n, status: 'pending' })) };
    const reset = await json<ProjectSnapshot>(await api(`/api/projects/${pid}`, { method: 'PUT', body: back }), 200);
    expect(node(reset, 'a')).toMatchObject({ startedAt: null, doneAt: null, teamId: 'tiempo' });
    expect(node(reset, 'b')).toMatchObject({ startedAt: null, doneAt: null });
  });
});

describe('PATCH con teamId (#75): la tarea entra a su equipo', () => {
  it('fija teamId, crea el equipo si no existe y suma la tarea sin repetirla', async () => {
    const pid = await project();
    const seq = await seqOf(pid);
    const a = await json<DagNode>(await patchNode(pid, 'a', { status: 'working', teamId: 'tiempo' }), 200);
    expect(a.teamId).toBe('tiempo');
    const ev = await eventsSince(pid, seq);
    expect(ev.map((e) => e.type)).toEqual(['node.updated', 'team.updated']);
    const born = (ev[1] as Extract<DagEvent, { type: 'team.updated' }>).payload.team;
    expect(born).toMatchObject({ id: 'tiempo', name: 'Tiempo', nodeIds: ['a'], startedAt: a.startedAt, closedAt: null });

    await json(await patchNode(pid, 'b', { status: 'working', teamId: 'tiempo' }), 200);
    const seq2 = await seqOf(pid);
    await json(await patchNode(pid, 'a', { progress: 0.3, teamId: 'tiempo' }), 200);
    expect((await eventsSince(pid, seq2)).map((e) => e.type)).toEqual(['node.updated']);
    const s = await snap(pid);
    expect(s.teams).toEqual([expect.objectContaining({ id: 'tiempo', nodeIds: ['a', 'b'], startedAt: born.startedAt })]);

    // soltarla: la tarea queda sin equipo y sale de su lista (revisión de #75)
    expect(await json<DagNode>(await patchNode(pid, 'a', { teamId: null }), 200)).toMatchObject({ teamId: null });
    expect((await snap(pid)).teams![0]!.nodeIds).toEqual(['b']);
    await json(await patchNode(pid, 'a', { teamId: 'No Vale' }), 400);
  });

  it('un equipo ya registrado conserva su nombre y su arranque', async () => {
    const pid = await project();
    await json(await putTeam(pid, 'tiempo', { name: 'La fábrica en el tiempo', startedAt: '2026-10-04T19:07:42Z', nodeIds: ['gh-75'] }), 200);
    await json(await patchNode(pid, 'a', { status: 'working', teamId: 'tiempo' }), 200);
    expect((await snap(pid)).teams).toEqual([
      expect.objectContaining({ name: 'La fábrica en el tiempo', startedAt: '2026-10-04T19:07:42.000Z', nodeIds: ['gh-75', 'a'] }),
    ]);
  });
});

/* ------------------------------------------------------------------ bloqueantes al recrear */

describe('project.replaced conserva el createdAt de los bloqueantes del cuerpo (#75)', () => {
  it('el dueño recrea con la hora real de la pregunta; una del futuro queda en ahora; una inválida es 400', async () => {
    const pid = uniquePid('t');
    const body = (createdAt: string) => ({
      name: 'Recreado',
      lang: 'es',
      nodes: [{ id: 'a', stage: 'construccion', title: 'A' }],
      blockers: [{ nodeId: 'a', kind: 'decision', question: '¿A o B?', options: ['A', 'B'], createdAt }],
    });
    const s = await json<ProjectSnapshot>(await api(`/api/projects/${pid}`, { method: 'PUT', body: body('2026-10-04T10:00:00Z'), headers: OWNER }), 200);
    expect(s.blockers[0]!.createdAt).toBe('2026-10-04T10:00:00.000Z');
    const future = await json<ProjectSnapshot>(await api(`/api/projects/${pid}`, { method: 'PUT', body: body('2999-01-01T00:00:00Z'), headers: OWNER }), 200);
    expect(future.blockers[0]!.createdAt < '2999').toBe(true);
    await json(await api(`/api/projects/${pid}`, { method: 'PUT', body: body('hace un rato'), headers: OWNER }), 400);
  });
});

/* ------------------------------------------------------------------ import-ledger */

describe('import-ledger sobre una copia de dagyard-design/design/tiempo/data/sites.json (#75)', () => {
  /** Lo que hace `dagyard import-ledger`: lee el snapshot, calcula el parche de cada equipo y manda solo los que cambian. */
  async function importLedger(pid: string): Promise<number> {
    const { rows } = parseLedger(JSON.stringify(sitesCopy));
    const { teams } = teamsFromLedger(rows, null);
    const current = new Map(((await snap(pid)).teams ?? []).map((t) => [t.id, t]));
    let sent = 0;
    for (const l of teams) {
      const patch = teamPatchFromLedger(l, current.get(l.id));
      if (!patch) continue;
      await json(await putTeam(pid, l.id, patch), 200);
      sent++;
    }
    return sent;
  }

  it('la primera vez crea los 24 equipos en orden de llegada; la segunda no emite ningún evento', async () => {
    const pid = await project();
    const seq0 = await seqOf(pid);
    expect(await importLedger(pid)).toBe(24);
    const seq1 = await seqOf(pid);
    expect(seq1 - seq0).toBe(24);

    expect(await importLedger(pid)).toBe(0);
    // aunque se reenvíe todo, el servidor no ve cambios: 0 eventos
    const { teams } = teamsFromLedger(parseLedger(JSON.stringify(sitesCopy)).rows, null);
    for (const l of teams) {
      const { id, ...all } = l;
      await json(await putTeam(pid, id, all), 200);
    }
    expect(await seqOf(pid)).toBe(seq1);

    const s = await snap(pid);
    expect(s.teams).toHaveLength(24);
    expect(s.teams!.map((t) => t.id).slice(0, 4)).toEqual(['nucleo', 'cielo', 'cli', 'entrega']);
    expect(s.teams!.map((t) => t.id).slice(-3)).toEqual(['i18n', 'demo', 'tiempo']);
    expect(s.teams!.find((t) => t.id === 'nucleo')).toMatchObject({
      name: 'Nucleo',
      nodeIds: ['gh-2'],
      requestedAt: '2026-10-04T05:35:20.000Z',
      startedAt: '2026-10-04T05:36:46.000Z',
      closedAt: '2026-10-04T06:38:36.000Z',
      outcome: 'merged',
    });
    expect(s.teams!.find((t) => t.id === 'endurecer')!.nodeIds).toEqual(['gh-12', 'gh-13', 'gh-14']);
    expect(s.teams!.filter((t) => t.closedAt !== null)).toHaveLength(21);
    expect(s.teams!.find((t) => t.id === 'tiempo')).toMatchObject({ closedAt: null, outcome: null });
  });
});

/* ------------------------------------------------------------------ revisión adversarial */

describe('revisión adversarial (#75)', () => {
  it('addNodeIds se suma dentro de la transacción: dos escritores a la vez no se pisan', async () => {
    const pid = await project();
    await json(await putTeam(pid, 'tiempo', { nodeIds: ['gh-75'] }), 200);
    const ids = Array.from({ length: 8 }, (_, i) => `gh-${100 + i}`);
    await Promise.all(ids.map((id) => putTeam(pid, 'tiempo', { addNodeIds: [id, 'gh-75'] }).then((r) => json(r, 200))));
    const t = (await snap(pid)).teams![0]!;
    expect(t.nodeIds[0]).toBe('gh-75');
    expect([...t.nodeIds].sort()).toEqual(['gh-75', ...ids].sort());
    const seq = await seqOf(pid);
    await json(await putTeam(pid, 'tiempo', { addNodeIds: ['gh-75', 'gh-100'] }), 200);
    expect(await seqOf(pid)).toBe(seq);
    // pasar el tope: 409, sin tocar nada
    await json(await putTeam(pid, 'tiempo', { addNodeIds: Array.from({ length: 45 }, (_, i) => `gh-${200 + i}`) }), 409);
    expect((await snap(pid)).teams![0]!.nodeIds).toHaveLength(9);
  });

  it('fechas: imposibles, antes de 2020, más de un día en el futuro o un cierre antes del arranque → 400', async () => {
    const pid = await project();
    await json(await putTeam(pid, 'x', { startedAt: '2026-10-04T10:00:00Z' }), 200);
    const late = new Date(Date.now() + 25 * 3600e3).toISOString();
    for (const body of [{ requestedAt: '2026-02-30T10:00:00Z' }, { startedAt: '2019-06-01T00:00:00Z' }, { closedAt: late }, { closedAt: '2026-10-04T09:00:00Z' }])
      await json(await putTeam(pid, 'x', body), 400);
    // con un arranque nuevo en el mismo cuerpo, el cierre se compara contra ese
    await json(await putTeam(pid, 'x', { startedAt: '2026-10-04T08:00:00Z', closedAt: '2026-10-04T09:00:00Z' }), 200);
    await json(await putTeam(pid, 'x', { startedAt: '2026-10-04T09:30:00Z' }), 400);
  });

  it('cambiar teamId (o ponerlo en null) saca la tarea del equipo viejo', async () => {
    const pid = await project();
    await json(await patchNode(pid, 'a', { status: 'working', teamId: 'uno' }), 200);
    await json(await patchNode(pid, 'b', { status: 'working', teamId: 'uno' }), 200);
    const seq = await seqOf(pid);
    await json(await patchNode(pid, 'a', { teamId: 'dos' }), 200);
    const ev = await eventsSince(pid, seq);
    expect(ev.map((e) => e.type)).toEqual(['node.updated', 'team.updated', 'team.updated']);
    let teams = (await snap(pid)).teams!;
    expect(teams.find((t) => t.id === 'uno')!.nodeIds).toEqual(['b']);
    expect(teams.find((t) => t.id === 'dos')!.nodeIds).toEqual(['a']);
    await json(await patchNode(pid, 'a', { teamId: null }), 200);
    teams = (await snap(pid)).teams!;
    expect(teams.find((t) => t.id === 'dos')!.nodeIds).toEqual([]);
    expect(node(await snap(pid), 'a').teamId).toBeNull();
  });

  it('entrar a un equipo con el tope lleno responde 409 y no toca la tarea', async () => {
    const pid = await project();
    await json(await putTeam(pid, 'lleno', { nodeIds: Array.from({ length: 50 }, (_, i) => `gh-${i}`) }), 200);
    const seq = await seqOf(pid);
    await json(await patchNode(pid, 'a', { status: 'working', teamId: 'lleno' }), 409);
    expect(await seqOf(pid)).toBe(seq);
    expect(node(await snap(pid), 'a')).toMatchObject({ status: 'pending', teamId: null });
  });
});
