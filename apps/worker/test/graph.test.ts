import { demoProject, type Blocker, type DagNode, type ProjectSnapshot } from '@dagyard/model';
import { describe, expect, it } from 'vitest';
import { AGENT, OWNER, api, json, seedDemo, uniquePid } from './helpers.js';

const shape = (s: ProjectSnapshot) => ({
  project: { id: s.project.id, name: s.project.name, stages: s.project.stages },
  nodes: s.nodes.map(({ createdAt, updatedAt, ...n }) => n),
  edges: s.edges,
  blockers: s.blockers.map(({ id, createdAt, ...b }) => b),
  messages: s.messages.map(({ id, createdAt, ...m }) => m),
});

describe('PUT de la demo', () => {
  it('snapshot con 20 tareas, 5 etapas y 3 bloqueantes abiertos; repetir da lo mismo', async () => {
    const a = await seedDemo();
    expect(a.nodes).toHaveLength(20);
    expect(a.project.stages).toHaveLength(5);
    expect(a.blockers.filter((b) => b.status === 'open')).toHaveLength(3);
    expect(a.blockers.map((b) => [b.nodeId, b.kind])).toEqual([
      ['comision', 'decision'],
      ['checkout-d', 'review'],
      ['pagos', 'access'],
    ]);
    expect(a.messages).toHaveLength(8);
    expect(a.seq).toBe(1);

    const b = await json<ProjectSnapshot>(await api(`/api/projects/${a.project.id}`, { method: 'PUT', body: demoProject(), headers: OWNER }), 200);
    expect(shape(b)).toEqual(shape(a));
    expect(b.project.createdAt).toBe(a.project.createdAt);
    expect(b.seq).toBe(2);

    const got = await json<ProjectSnapshot>(await api(`/api/projects/${a.project.id}`), 200);
    expect(shape(got)).toEqual(shape(a));
  });

  it('el listado trae conteos y bloqueantes abiertos', async () => {
    const s = await seedDemo();
    const { projects } = await json(await api('/api/projects'), 200);
    const p = projects.find((x: { id: string }) => x.id === s.project.id);
    expect(p.counts).toEqual({ total: 20, pending: 9, working: 3, blocked: 3, done: 5 } satisfies Record<string, number>);
    expect(p.openBlockers).toBe(3);
  });

  it('valida el grafo: dependencia inexistente → 400 invalid; ciclo → 400 invalid; blocked sin bloqueante → 400', async () => {
    const pid = uniquePid();
    const base = { name: 'X', nodes: [{ id: 'a', stage: 'diseno', title: 'A' }] };
    let r = await json(await api(`/api/projects/${pid}`, { method: 'PUT', body: { ...base, nodes: [{ ...base.nodes[0], deps: ['zz'] }] } }), 400);
    expect(r.error.code).toBe('invalid');
    r = await json(
      await api(`/api/projects/${pid}`, {
        method: 'PUT',
        body: { name: 'X', nodes: [{ id: 'a', stage: 'diseno', title: 'A', deps: ['b'] }, { id: 'b', stage: 'diseno', title: 'B', deps: ['a'] }] },
      }),
      400,
    );
    expect(r.error.message).toMatch(/ciclo/);
    r = await json(await api(`/api/projects/${pid}`, { method: 'PUT', body: { name: 'X', nodes: [{ id: 'a', stage: 'diseno', title: 'A', status: 'blocked' }] } }), 400);
    expect(r.error.code).toBe('invalid');
    r = await json(await api(`/api/projects/${pid}`, { method: 'PUT', body: { name: 'X', nodes: [{ id: 'a', stage: 'nope', title: 'A' }] } }), 400);
    expect(r.error.message).toMatch(/etapa/);
  });
});

describe('next y aristas', () => {
  it('next de la demo → landing con su goalLine', async () => {
    const s = await seedDemo();
    const r = await json(await api(`/api/projects/${s.project.id}/next`), 200);
    expect(r.node.id).toBe('landing');
    expect(r.goalLine).toBe('/goal Arma la página de lanzamiento con la lista de espera');
  });

  it('arista que cierra un ciclo → 400 cycle; repetida → 409; inexistente → 404', async () => {
    const s = await seedDemo();
    const pid = s.project.id;
    // usuario → landing ya existe, así que landing → usuario cierra el ciclo
    expect((await json(await api(`/api/projects/${pid}/edges`, { method: 'POST', body: { from: 'landing', to: 'usuario' } }), 400)).error.code).toBe('cycle');
    // ciclo largo: entrevistas → … → anuncio
    expect((await json(await api(`/api/projects/${pid}/edges`, { method: 'POST', body: { from: 'anuncio', to: 'entrevistas' } }), 400)).error.code).toBe('cycle');
    expect((await json(await api(`/api/projects/${pid}/edges`, { method: 'POST', body: { from: 'pagos', to: 'pagos' } }), 400)).error.code).toBe('cycle');
    expect((await json(await api(`/api/projects/${pid}/edges`, { method: 'POST', body: { from: 'usuario', to: 'landing' } }), 409)).error.code).toBe('conflict');
    await json(await api(`/api/projects/${pid}/edges`, { method: 'POST', body: { from: 'zz', to: 'landing' } }), 404);

    const e = await json(await api(`/api/projects/${pid}/edges`, { method: 'POST', body: { from: 'velocidad', to: 'landing' } }), 201);
    expect(e).toEqual({ projectId: pid, from: 'velocidad', to: 'landing' });
    // ahora landing depende de algo no listo: next ya no es landing
    expect((await json(await api(`/api/projects/${pid}/next`), 200)).node).toBeNull();
    expect((await api(`/api/projects/${pid}/edges?from=velocidad&to=landing`, { method: 'DELETE' })).status).toBe(204);
    expect((await json(await api(`/api/projects/${pid}/next`), 200)).node.id).toBe('landing');
    await json(await api(`/api/projects/${pid}/edges?from=velocidad&to=landing`, { method: 'DELETE' }), 404);
  });
});

describe('nodos y mensajes', () => {
  it('reglas de estado al escribir un nodo', async () => {
    const pid = uniquePid();
    await json(await api('/api/projects', { method: 'POST', body: { id: pid, name: 'Prueba', lang: 'es' } }), 201);
    await json(await api('/api/projects', { method: 'POST', body: { id: pid, name: 'Prueba' } }), 409);

    const a = await json<DagNode>(await api(`/api/projects/${pid}/nodes`, { method: 'POST', body: { stage: 'diseno', title: 'Diseño del pago' } }), 201);
    expect(a).toMatchObject({ id: 'diseno-del-pago', status: 'pending', progress: 0, team: null });
    await json(await api(`/api/projects/${pid}/nodes`, { method: 'POST', body: { stage: 'diseno', title: 'Diseño del pago' } }), 409);
    await json(await api(`/api/projects/${pid}/nodes`, { method: 'POST', body: { stage: 'diseno', title: 'X', deps: ['zz'] } }), 400);
    await json(await api(`/api/projects/${pid}/nodes`, { method: 'POST', body: { stage: 'nope', title: 'X' } }), 400);

    const b = await json<DagNode>(
      await api(`/api/projects/${pid}/nodes`, { method: 'POST', body: { id: 'pagos', stage: 'construccion', title: 'Pagos', team: 'Construcción', deps: [a.id] } }),
      201,
    );
    expect(b.status).toBe('pending');

    const start = await json<DagNode>(await api(`/api/projects/${pid}/nodes/pagos`, { method: 'PATCH', body: { status: 'working' } }), 200);
    expect(start).toMatchObject({ status: 'working', progress: 0 });
    expect((await json<DagNode>(await api(`/api/projects/${pid}/nodes/pagos`, { method: 'PATCH', body: { progress: 0.4 } }), 200)).progress).toBe(0.4);
    await json(await api(`/api/projects/${pid}/nodes/pagos`, { method: 'PATCH', body: { status: 'blocked' } }), 400);
    await json(await api(`/api/projects/${pid}/nodes/pagos`, { method: 'PATCH', body: { deps: [] } }), 400);

    await json(await api(`/api/projects/${pid}/nodes/pagos/blockers`, { method: 'POST', body: { kind: 'decision', question: '¿Cuál?', options: ['A', 'B'] } }), 201);
    expect((await json(await api(`/api/projects/${pid}/nodes/pagos/blockers`, { method: 'POST', body: { kind: 'decision', question: '¿?', options: [] } }), 400)).error.code).toBe('invalid');
    // con un bloqueante abierto el estado no se toca a mano, pero el progreso sí
    expect((await json(await api(`/api/projects/${pid}/nodes/pagos`, { method: 'PATCH', body: { status: 'done' } }), 409)).error.code).toBe('conflict');
    await json(await api(`/api/projects/${pid}/nodes/pagos`, { method: 'PATCH', body: { progress: 0.5 } }), 200);

    const done = await json<DagNode>(await api(`/api/projects/${pid}/nodes/${a.id}`, { method: 'PATCH', body: { status: 'done' } }), 200);
    expect(done).toMatchObject({ status: 'done', progress: 1 });
  });

  it('mensajes: firma por defecto, ≤280 y el nodo adopta el reportUrl', async () => {
    const s = await seedDemo();
    const pid = s.project.id;
    const m = await json(await api(`/api/projects/${pid}/nodes/pagos/messages`, { method: 'POST', body: { text: 'Ya conecté la pasarela.' } }), 201);
    expect(m).toMatchObject({ from: 'Equipo de Construcción', text: 'Ya conecté la pasarela.', reportUrl: null });
    expect(m.id).toMatch(/^m_/);
    const anon = await json(await api(`/api/projects/${pid}/nodes/landing/messages`, { method: 'POST', body: { text: 'Hola' } }), 201);
    expect(anon.from).toBe('Agente');
    await json(await api(`/api/projects/${pid}/nodes/pagos/messages`, { method: 'POST', body: { text: 'x'.repeat(281) } }), 400);
    await json(await api(`/api/projects/${pid}/nodes/nope/messages`, { method: 'POST', body: { text: 'x' } }), 404);

    await json(await api(`/api/projects/${pid}/nodes/landing/messages`, { method: 'POST', body: { text: 'Informe', reportUrl: 'https://basalt.example/r/1' } }), 201);
    const snap = await json<ProjectSnapshot>(await api(`/api/projects/${pid}`), 200);
    expect(snap.nodes.find((n) => n.id === 'landing')!.reportUrl).toBe('https://basalt.example/r/1');
    expect(snap.messages.at(-1)!.text).toBe('Informe');

    const { events } = await json(await api(`/api/projects/${pid}/events?since=1`), 200);
    expect(events.map((e: { type: string }) => e.type)).toEqual(['message.posted', 'message.posted', 'message.posted', 'node.updated']);
    expect(events.map((e: { seq: number }) => e.seq)).toEqual([2, 3, 4, 5]);
  });

  it('link: el detalle técnico se crea, se edita, se borra y el PUT lo toma del body', async () => {
    const s = await seedDemo();
    const pid = s.project.id;
    expect(s.nodes.every((n) => n.link === null)).toBe(true);
    const issue = 'https://github.com/cofoundy/dagyard/issues/45';
    const added = await json<DagNode>(
      await api(`/api/projects/${pid}/nodes`, { method: 'POST', body: { stage: 'construccion', title: 'Sincronizar issues', link: issue } }),
      201,
    );
    expect(added).toMatchObject({ id: 'sincronizar-issues', link: issue, reportUrl: null });
    const pr = 'https://github.com/cofoundy/dagyard/pull/46';
    const patched = await json<DagNode>(await api(`/api/projects/${pid}/nodes/${added.id}`, { method: 'PATCH', body: { link: pr } }), 200);
    expect(patched.link).toBe(pr);
    const { events } = await json(await api(`/api/projects/${pid}/events?since=${s.seq}`), 200);
    expect(events.at(-1)).toMatchObject({ type: 'node.updated', payload: { node: { id: added.id, link: pr } } });
    expect((await json(await api(`/api/projects/${pid}/nodes/${added.id}`, { method: 'PATCH', body: { link: 'ftp://x' } }), 400)).error.code).toBe('invalid');
    const cleared = await json<DagNode>(await api(`/api/projects/${pid}/nodes/${added.id}`, { method: 'PATCH', body: { link: null } }), 200);
    expect(cleared.link).toBeNull();

    // el PUT reemplaza el grafo: el link viene del body como los demás campos
    const graph = demoProject();
    graph.nodes[0]!.link = issue;
    const snap = await json<ProjectSnapshot>(await api(`/api/projects/${pid}`, { method: 'PUT', body: graph }), 200);
    expect(snap.nodes.find((n) => n.id === graph.nodes[0]!.id)!.link).toBe(issue);
    expect(snap.nodes.filter((n) => n.link !== null)).toHaveLength(1);
  });

  it('link: el PUT de un agente lo conserva si el body no trae la clave; null lo borra; el dueño reemplaza todo', async () => {
    const s = await seedDemo();
    const pid = s.project.id;
    const nid = s.nodes[0]!.id;
    const issue = 'https://github.com/cofoundy/dagyard/issues/45';
    await json(await api(`/api/projects/${pid}/nodes/${nid}`, { method: 'PATCH', body: { link: issue } }), 200);
    const linkOf = (snap: ProjectSnapshot) => snap.nodes.find((n) => n.id === nid)!.link;
    // la demo declara `link: null`; un archivo importado ni siquiera trae la clave
    const bare = () => {
      const g = demoProject();
      for (const n of g.nodes) delete n.link;
      return g;
    };

    // re-importar sin la clave (lo que hace `dagyard import --replace`) no borra lo que puso `sync`
    let snap = await json<ProjectSnapshot>(await api(`/api/projects/${pid}`, { method: 'PUT', body: bare() }), 200);
    expect(linkOf(snap)).toBe(issue);

    const explicit = demoProject();
    explicit.nodes[0]!.link = null;
    snap = await json<ProjectSnapshot>(await api(`/api/projects/${pid}`, { method: 'PUT', body: explicit }), 200);
    expect(linkOf(snap)).toBeNull();

    await json(await api(`/api/projects/${pid}/nodes/${nid}`, { method: 'PATCH', body: { link: issue } }), 200);
    snap = await json<ProjectSnapshot>(await api(`/api/projects/${pid}`, { method: 'PUT', body: bare(), headers: OWNER }), 200);
    expect(linkOf(snap)).toBeNull();
  });

  it('descartar un nodo (#90) lo cierra como dropped y conserva sus aristas y mensajes: la fila nunca se borra', async () => {
    const s = await seedDemo();
    const pid = s.project.id;
    const edges = s.edges.filter((e) => e.from === 'landing' || e.to === 'landing');
    expect((await api(`/api/projects/${pid}/nodes/landing`, { method: 'DELETE', headers: OWNER })).status).toBe(200);
    const snap = await json<ProjectSnapshot>(await api(`/api/projects/${pid}`), 200);
    expect(snap.nodes).toHaveLength(20);
    expect(snap.nodes.find((n) => n.id === 'landing')).toMatchObject({ status: 'done', closedAs: 'dropped', closedReason: null });
    expect(snap.edges.filter((e) => e.from === 'landing' || e.to === 'landing')).toEqual(edges);
    expect(snap.messages.filter((m) => m.nodeId === 'landing')).toEqual(s.messages.filter((m) => m.nodeId === 'landing'));
    await json(await api(`/api/projects/${pid}/nodes/nadie`, { method: 'DELETE', headers: OWNER }), 404);
  });

  it('borrar un proyecto es solo del owner', async () => {
    const s = await seedDemo();
    const pid = s.project.id;
    expect((await json(await api(`/api/projects/${pid}`, { method: 'DELETE', headers: AGENT }), 403)).error.code).toBe('forbidden');
    expect((await api(`/api/projects/${pid}`, { method: 'DELETE', headers: OWNER })).status).toBe(204);
    await json(await api(`/api/projects/${pid}`), 404);
  });

  it('PATCH del proyecto: nombre y etapas, sin dejar tareas huérfanas', async () => {
    const s = await seedDemo();
    const pid = s.project.id;
    const p = await json(await api(`/api/projects/${pid}`, { method: 'PATCH', body: { name: 'Reservas v2' } }), 200);
    expect(p.name).toBe('Reservas v2');
    await json(await api(`/api/projects/${pid}`, { method: 'PATCH', body: { stages: ['Solo una'] } }), 400);
    await json(await api(`/api/projects/${pid}`, { method: 'PATCH', body: { id: 'otro' } }), 400);
  });
});
