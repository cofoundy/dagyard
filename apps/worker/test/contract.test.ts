import { demoProject, type BlockerWaitResult, type DagNode, type NextResult, type ProjectGraphInput, type ProjectSnapshot } from '@dagyard/model';
import { describe, expect, it } from 'vitest';
import { buildImport } from '../../../packages/cli/src/tasks/import.js';
import { AGENT, OWNER, api, json, seedDemo, uniquePid } from './helpers.js';

const open = (s: ProjectSnapshot) => s.blockers.filter((b) => b.status === 'open');
const snap = (pid: string) => api(`/api/projects/${pid}`).then((r) => json<ProjectSnapshot>(r, 200));
const put = (pid: string, body: unknown, headers: Record<string, string> = AGENT) => api(`/api/projects/${pid}`, { method: 'PUT', body, headers });
const resolve = (pid: string, bid: string, body: unknown) =>
  api(`/api/projects/${pid}/blockers/${bid}/resolve`, { method: 'POST', body, headers: OWNER }).then((r) => json(r, 200));

/** Un proyecto chico: «a» y «b» (depende de «a»), con un acceso pendiente sobre «b». */
const small = (): ProjectGraphInput => ({
  name: 'Con acceso',
  lang: 'es', // etapas por defecto en español (#77)
  nodes: [
    { id: 'a', stage: 'diseno', title: 'A', status: 'done' },
    { id: 'b', stage: 'construccion', title: 'B', status: 'blocked', deps: ['a'] },
  ],
  blockers: [{ nodeId: 'b', kind: 'access', question: 'Necesito la clave de la pasarela', accessLabel: 'Clave' }],
});

// #13 + #18 (opción b): resolver es solo del dueño, así que un agente no puede hacer desaparecer ni una
// pregunta abierta ni una respuesta ya dada. El PUT del agente las conserva con su id.
describe('un agente no borra bloqueantes', () => {
  it('PUT del agente sobre la demo sembrada → 200 y conserva los 3 abiertos con sus ids, sin duplicarlos', async () => {
    const s = await seedDemo();
    const pid = s.project.id;
    const before = open(s).map((b) => b.id);
    expect(before).toHaveLength(3);

    const again = await json<ProjectSnapshot>(await put(pid, demoProject()), 200);
    expect(again.blockers.map((b) => b.id)).toEqual(before);
    for (const b of again.blockers) expect(again.nodes.find((n) => n.id === b.nodeId)?.status).toBe('blocked');

    // quitar los bloqueantes del body tampoco los borra: la tarea sigue esperando al dueño
    const sin = { ...demoProject(), blockers: [] };
    sin.nodes = sin.nodes.map((n) => (n.status === 'blocked' ? { ...n, status: 'working' as const } : n));
    const after = await json<ProjectSnapshot>(await put(pid, sin), 200);
    expect(open(after).map((b) => b.id)).toEqual(before);
    for (const b of after.blockers) expect(after.nodes.find((n) => n.id === b.nodeId)?.status).toBe('blocked');

    // el dueño sigue reemplazando todo (la semilla)
    const owner = await json<ProjectSnapshot>(await put(pid, demoProject(), OWNER), 200);
    expect(open(owner)).toHaveLength(3);
  });

  it('acceso resuelto → PUT del agente (import --replace) → el wait entrega el valor', async () => {
    const pid = uniquePid();
    const s = await json<ProjectSnapshot>(await put(pid, small()), 200);
    const bid = s.blockers[0]!.id;
    await resolve(pid, bid, { value: 'sk_live_123', note: 'la de pruebas' });

    const again = await json<ProjectSnapshot>(await put(pid, small()), 200);
    // la respuesta del dueño sigue con su id; la misma pregunta en el archivo se vuelve a hacer, nueva y abierta
    expect(again.blockers.find((b) => b.id === bid)).toMatchObject({ status: 'resolved', resolvedBy: 'owner', resolution: { note: 'la de pruebas', hasValue: true } });
    expect(open(again)).toHaveLength(1);
    expect(again.nodes.find((n) => n.id === 'b')?.status).toBe('blocked');

    const w = await json<BlockerWaitResult>(await api(`/api/projects/${pid}/blockers/${bid}/wait?timeout=0`), 200);
    expect(w.blocker.status).toBe('resolved');
    expect(w.value).toBe('sk_live_123');
  });

  it('re-preguntar nunca se descarta: la misma revisión que ya se respondió entra como una nueva abierta', async () => {
    const s = await seedDemo();
    const pid = s.project.id;
    const review = s.blockers.find((b) => b.nodeId === 'checkout-d')!;
    await resolve(pid, review.id, { choice: 0 });

    const again = await json<ProjectSnapshot>(await put(pid, demoProject()), 200);
    const mine = again.blockers.filter((b) => b.nodeId === 'checkout-d');
    expect(mine.map((b) => b.status)).toEqual(['resolved', 'open']);
    expect(mine[0]!.id).toBe(review.id);
    expect(again.nodes.find((n) => n.id === 'checkout-d')?.status).toBe('blocked');
    // las abiertas idénticas no se duplican
    expect(open(again)).toHaveLength(3);
  });

  it('una pregunta abierta con otras opciones no es la misma: entra como nueva', async () => {
    const s = await seedDemo();
    const pid = s.project.id;
    const g = demoProject();
    g.blockers = g.blockers!.map((b) => (b.nodeId === 'comision' ? { ...b, options: [...b.options!, 'A los dos'] } : b));
    const again = await json<ProjectSnapshot>(await put(pid, g), 200);
    expect(open(again).filter((b) => b.nodeId === 'comision')).toHaveLength(2);
    expect(open(again)).toHaveLength(4);
  });

  it('PUT sin un nodo con bloqueante (#90): el nodo sigue con su pregunta; abierta, espera; respondida, se descarta', async () => {
    const pid = uniquePid();
    const s = await json<ProjectSnapshot>(await put(pid, small()), 200);
    const bid = s.blockers[0]!.id;
    const onlyA = { name: 'Con acceso', nodes: [{ id: 'a', stage: 'diseno', title: 'A', status: 'done' as const }] };
    const b = (x: ProjectSnapshot) => x.nodes.find((n) => n.id === 'b')!;

    // abierta: «b» sigue esperando al dueño, con su pregunta
    let after = await json<ProjectSnapshot>(await put(pid, onlyA), 200);
    expect(after.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(b(after)).toMatchObject({ status: 'blocked', closedAs: null });
    expect(after.blockers.map((x) => [x.id, x.status])).toEqual([[bid, 'open']]);
    expect(after.edges).toEqual([{ projectId: pid, from: 'a', to: 'b' }]);

    // respondida: el siguiente PUT sin «b» la descarta, y la respuesta sigue
    await resolve(pid, bid, { value: 'sk_live_123' });
    after = await json<ProjectSnapshot>(await put(pid, onlyA), 200);
    expect(b(after)).toMatchObject({ status: 'done', closedAs: 'dropped', closedReason: 'no está en el import' });
    const w = await json<BlockerWaitResult>(await api(`/api/projects/${pid}/blockers/${bid}/wait?timeout=0`), 200);
    expect(w.value).toBe('sk_live_123');

    // el dueño tampoco la borra: un proyecto que no es demo nunca pierde un nodo
    const owner = await json<ProjectSnapshot>(await put(pid, onlyA, OWNER), 200);
    expect(owner.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(owner.blockers.map((x) => x.id)).toEqual([bid]);
  });

  it('DELETE (descartar, #90): agente → 403; dueño con una pregunta abierta → 409; respondida → la cierra como dropped', async () => {
    const s = await seedDemo();
    const pid = s.project.id;
    let r = await json(await api(`/api/projects/${pid}/nodes/landing`, { method: 'DELETE', headers: AGENT }), 403);
    expect(r.error.code).toBe('forbidden');
    r = await json(await api(`/api/projects/${pid}/nodes/comision`, { method: 'DELETE', headers: OWNER }), 409);
    expect(r.error.message).toMatch(/bloqueante abierto/);
    expect(open(await snap(pid)).some((b) => b.nodeId === 'comision')).toBe(true);

    const b = s.blockers.find((x) => x.nodeId === 'comision')!;
    await resolve(pid, b.id, { choice: 0 });
    const dropped = await json<DagNode>(await api(`/api/projects/${pid}/nodes/comision?why=${encodeURIComponent('ya no aplica')}`, { method: 'DELETE', headers: OWNER }), 200);
    expect(dropped).toMatchObject({ id: 'comision', status: 'done', closedAs: 'dropped', closedReason: 'ya no aplica' });
    const after = await snap(pid);
    expect(after.blockers.find((x) => x.id === b.id)?.status).toBe('resolved');
    expect(after.nodes).toHaveLength(s.nodes.length);
    // ya cerrada: descartarla otra vez → 409
    await json(await api(`/api/projects/${pid}/nodes/comision`, { method: 'DELETE', headers: OWNER }), 409);
  });

  it('PUT del agente sobre un proyecto sin bloqueantes → 200 (lo usa la QA de tiempo real)', async () => {
    const pid = uniquePid();
    const g = { name: 'Sin preguntas', lang: 'es' as const, nodes: [{ id: 'a', stage: 'diseno', title: 'A' }] };
    await json(await put(pid, g), 200);
    const again = await json<ProjectSnapshot>(
      await put(pid, { ...g, nodes: [...g.nodes, { id: 'b', stage: 'diseno', title: 'B', deps: ['a'] }] }),
      200,
    );
    expect(again.nodes.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('PUT del agente con bloqueantes, si el proyecto es nuevo → 200', async () => {
    const s = await seedDemo(uniquePid());
    expect(open(s)).toHaveLength(3);
  });
});

// #19: creación exclusiva, chequeada dentro de la transacción del Store
describe('PUT con If-None-Match: *', () => {
  it('sobre un proyecto existente → 409 y no lo toca', async () => {
    const pid = uniquePid();
    const s = await json<ProjectSnapshot>(await put(pid, small()), 200);
    const r = await json(await put(pid, { name: 'Otro', nodes: [] }, { ...AGENT, 'if-none-match': '*' }), 409);
    expect(r.error.code).toBe('conflict');
    expect(r.error.message).toMatch(/ya existe/i);
    const after = await snap(pid);
    expect(after.seq).toBe(s.seq);
    expect(after.project.name).toBe('Con acceso');
    expect(after.nodes).toHaveLength(2);
  });

  it('sobre un proyecto nuevo → 200 y lo crea', async () => {
    const pid = uniquePid();
    const s = await json<ProjectSnapshot>(await put(pid, small(), { ...AGENT, 'if-none-match': '*' }), 200);
    expect(s.project.id).toBe(pid);
    expect(s.nodes).toHaveLength(2);
  });
});

// #32: el PUT de un agente no borra la conversación ni reinicia la antigüedad de las tareas que siguen
describe('el PUT de un agente conserva mensajes y antigüedad', () => {
  const next = (pid: string) => api(`/api/projects/${pid}/next`).then((r) => json<NextResult>(r, 200));

  it('resolver un bloqueante → PUT de agente idéntico → el mensaje del sistema sigue y next no cambia', async () => {
    const pid = uniquePid();
    const g: ProjectGraphInput = { name: 'Orden', lang: 'es', nodes: [{ id: 'z', stage: 'diseno', title: 'Z' }, ...small().nodes], blockers: small().blockers };
    await json(await put(pid, g), 200);
    // «a2» llega después: es más nueva que «z», así que next elige «z» aunque «a2» gane por id
    await new Promise((r) => setTimeout(r, 5));
    await json(await api(`/api/projects/${pid}/nodes`, { method: 'POST', body: { id: 'a2', stage: 'diseno', title: 'A2' } }), 201);
    const s = await snap(pid);
    await resolve(pid, s.blockers[0]!.id, { value: 'sk_live_123' });
    const before = await snap(pid);
    const system = before.messages.find((m) => m.text === 'Gracias. Sigo desde donde me quedé.')!;
    expect(system).toBeDefined();
    expect((await next(pid)).node?.id).toBe('z');

    // el mismo grafo, ya sin la pregunta respondida: «b» sigue trabajando
    const nodes = [...g.nodes, { id: 'a2', stage: 'diseno', title: 'A2' }].map((n) => (n.id === 'b' ? { ...n, status: 'working' as const } : n));
    const g2: ProjectGraphInput = { ...g, nodes, blockers: [] };
    const after = await json<ProjectSnapshot>(await put(pid, g2), 200);
    expect(after.messages).toContainEqual(system);
    for (const n of before.nodes) expect(after.nodes.find((x) => x.id === n.id)?.createdAt).toBe(n.createdAt);
    expect((await next(pid)).node?.id).toBe('z');
  });

  it('re-importar el mismo archivo no duplica sus mensajes y los conserva con su id', async () => {
    const s = await seedDemo();
    const pid = s.project.id;
    expect(s.messages).toHaveLength(8);
    const again = await json<ProjectSnapshot>(await put(pid, demoProject()), 200);
    expect(again.messages).toEqual(s.messages);

    // un mensaje nuevo del archivo sí entra; los de una tarea que el archivo ya no trae se quedan con ella (#90)
    const g = demoProject();
    g.messages = [...g.messages!, { nodeId: 'registro', text: 'Ya mandé el correo de bienvenida.' }];
    g.nodes = g.nodes.filter((n) => n.id !== 'entrevistas').map((n) => ({ ...n, deps: n.deps?.filter((d) => d !== 'entrevistas') }));
    g.messages = g.messages.filter((m) => m.nodeId !== 'entrevistas');
    const after = await json<ProjectSnapshot>(await put(pid, g), 200);
    expect(after.messages.map((m) => m.id)).toEqual(expect.arrayContaining(s.messages.map((m) => m.id)));
    expect(after.messages.filter((m) => m.text === 'Ya mandé el correo de bienvenida.')).toHaveLength(1);
    expect(after.messages).toHaveLength(9);
  });

  it('un mensaje sin from no se duplica al re-importar aunque la tarea cambie de equipo', async () => {
    const pid = uniquePid();
    const g = (team: string): ProjectGraphInput => ({
      name: 'Equipo',
      lang: 'es',
      nodes: [{ id: 't', stage: 'diseno', title: 'T', team }],
      messages: [{ nodeId: 't', text: 'Avance del día' }],
    });
    const s = await json<ProjectSnapshot>(await put(pid, g('Diseño')), 200);
    expect(s.messages).toHaveLength(1);
    const after = await json<ProjectSnapshot>(await put(pid, g('Construcción')), 200);
    expect(after.messages).toEqual(s.messages);
  });

  it('el PUT del dueño sigue recreando todo', async () => {
    const s = await seedDemo();
    const owner = await json<ProjectSnapshot>(await put(s.project.id, demoProject(), OWNER), 200);
    expect(owner.messages).toHaveLength(8);
    expect(owner.messages.some((m) => s.messages.some((x) => x.id === m.id))).toBe(false);
  });
});

// #33: una tarea con una pregunta abierta no se cierra, igual que en PATCH
describe('un PUT no deja una tarea blocked al 100 %', () => {
  it('agente: «done» en una tarea con un bloqueante abierto conservado → 409 sin tocar nada', async () => {
    const pid = uniquePid();
    const s = await json<ProjectSnapshot>(await put(pid, small()), 200);
    const g = small();
    g.nodes = g.nodes.map((n) => (n.id === 'b' ? { ...n, status: 'done' as const } : n));
    g.blockers = [];
    const r = await json(await put(pid, g), 409);
    expect(r.error.code).toBe('conflict');
    expect(r.error.message).toMatch(/«B».*pregunta abierta/);
    const after = await snap(pid);
    expect(after.seq).toBe(s.seq);
    expect(after.nodes.find((n) => n.id === 'b')).toMatchObject({ status: 'blocked', progress: 0 });
  });

  it('cualquier actor: «done» con un bloqueante del mismo body → 409', async () => {
    const g = small();
    g.nodes = g.nodes.map((n) => (n.id === 'b' ? { ...n, status: 'done' as const } : n));
    for (const headers of [AGENT, OWNER]) {
      const pid = uniquePid();
      const r = await json(await put(pid, g, headers), 409);
      expect(r.error.code).toBe('conflict');
      expect((await api(`/api/projects/${pid}`)).status).toBe(404);
    }
  });
  it('agente: «done» repitiendo una pregunta ya respondida → 409 que no pide responderla otra vez', async () => {
    const pid = uniquePid();
    const s = await json<ProjectSnapshot>(await put(pid, small()), 200);
    await resolve(pid, s.blockers[0]!.id, { value: 'sk_live_123' });
    const resolved = await snap(pid);
    const g = small();
    g.nodes = g.nodes.map((n) => (n.id === 'b' ? { ...n, status: 'done' as const } : n));
    const r = await json(await put(pid, g), 409);
    expect(r.error.code).toBe('conflict');
    expect(r.error.message).toMatch(/ya respondió.*«B»/);
    expect(r.error.message).toMatch(/quítala de blockers o no cierres la tarea/);
    expect(r.error.message).not.toMatch(/hasta que la responda/);
    expect((await snap(pid)).seq).toBe(resolved.seq);
  });
});

// #35: lo que arma `dagyard import` lo acepta el servidor; una escalación queda Pendiente, sin bloqueantes
describe('PUT de un grafo de dagyard import', () => {
  const files = [
    { file: 'a.md', text: '---\nid: T-1\nstatus: ready\n---\n# Base' },
    { file: 'b.md', text: '---\nid: T-2\nstatus: blocked  # ESCALATION REQUIRED\ndeps: [T-1]\n---\n# Escalada' },
  ];

  it('una tarea con escalación → 200 y Pendiente; re-importar como agente → 200 sin bloqueantes', async () => {
    const pid = uniquePid();
    const s = await json<ProjectSnapshot>(await put(pid, buildImport(files, { dirName: 'escalada' }).graph), 200);
    expect(s.nodes.find((n) => n.id === 't-2')?.status).toBe('pending');
    expect(s.blockers).toEqual([]);

    const again = await json<ProjectSnapshot>(await put(pid, buildImport(files, { dirName: 'escalada' }).graph), 200);
    expect(again.nodes.find((n) => n.id === 't-2')?.status).toBe('pending');
    expect(again.blockers).toEqual([]);
  });
});
