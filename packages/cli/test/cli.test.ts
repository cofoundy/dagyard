import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, goalLine, progressArg, run, skyLink, type Io } from '../src/cli.js';
import { nextStartable, REVIEW_OPTIONS, type Blocker, type DagNode, type Edge, type Stage } from '@dagyard/model';

const KEY = 'clave-secreta-123';

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  /** el header `If-None-Match` (creación exclusiva), si vino */
  ifNoneMatch: string | undefined;
  body: unknown;
}

/** Server mock con la forma de la API: guarda lo que recibe y resuelve bloqueantes. */
let server: Server;
let baseUrl = '';
let seen: Seen[] = [];
let blockers = new Map<string, Blocker>();
let accessValues = new Map<string, string>();
let stages: Stage[] = [];
let nodes: DagNode[] = [];
let edges: Edge[] = [];
/** Proyectos que el mock da por existentes; `lockedProjects` responden 409 al PUT (bloqueantes abiertos). */
let projects = new Set<string>();
let lockedProjects = new Set<string>();
/** idioma guardado de cada proyecto del mock; sin entrada = guardado antes del campo (#77) */
let projectLangs = new Map<string, string>();

/** Un nodo del mock con defaults; `next` lo elige con `nextStartable` del modelo, como el Worker. */
function mockNode(id: string, stage: string, status: DagNode['status'], goal: string | null = null): DagNode {
  const at = '2026-10-04T00:00:00.000Z';
  return { id, projectId: 'demo', stage, title: id, status, progress: 0, team: null, goal, reportUrl: null, link: null, createdAt: at, updatedAt: at };
}

function reply(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const body = await readBody(req);
  seen.push({ method: req.method ?? '', path: url.pathname, auth: req.headers.authorization, ifNoneMatch: req.headers['if-none-match'], body });
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    return reply(res, 401, { error: { code: 'unauthorized', message: `token inválido: ${req.headers.authorization}` } });
  }
  const parts = url.pathname.split('/').filter(Boolean); // api projects :p ...
  const [, , projectId, kind, nodeId, sub] = parts;
  if (req.method === 'PUT' && parts.length === 3) {
    // creación exclusiva, como el Worker: con `If-None-Match: *` un proyecto existente → 409 sin tocarlo
    if (req.headers['if-none-match'] === '*' && projects.has(projectId!)) {
      return reply(res, 409, { error: { code: 'conflict', message: `Ya existe un proyecto «${projectId}»; no lo piso` } });
    }
    if (lockedProjects.has(projectId!)) {
      return reply(res, 409, { error: { code: 'conflict', message: 'El proyecto tiene una pregunta abierta para el dueño' } });
    }
    projects.add(projectId!);
    const lang = (body as { lang?: string }).lang;
    if (lang) projectLangs.set(projectId!, lang);
    return reply(res, 200, { ok: true });
  }
  if (req.method === 'GET' && parts.length === 3) {
    if (!projects.has(projectId!)) return reply(res, 404, { error: { code: 'not_found', message: `El proyecto «${projectId}» no existe` } });
    const lang = projectLangs.get(projectId!);
    return reply(res, 200, { project: { id: projectId, ...(lang ? { lang } : {}) }, nodes: [], edges: [], blockers: [...blockers.values()], messages: [], seq: 0 });
  }
  if (req.method === 'GET' && kind === 'next') {
    return reply(res, 200, nextStartable(stages, nodes, edges));
  }
  if (req.method === 'POST' && kind === 'nodes' && !nodeId) return reply(res, 201, { ...(body as object), projectId });
  if (req.method === 'PATCH' && kind === 'nodes' && nodeId) {
    if ((body as { status?: string }).status === 'blocked') {
      return reply(res, 400, { error: { code: 'invalid', message: 'blocked no se pone a mano' } });
    }
    return reply(res, 200, { id: nodeId });
  }
  if (req.method === 'POST' && kind === 'edges') return reply(res, 201, { projectId, ...(body as object) });
  if (req.method === 'POST' && kind === 'nodes' && sub === 'close') return reply(res, 200, { id: nodeId, status: 'done', closedAs: (body as { as: string }).as });
  if (req.method === 'POST' && sub === 'messages') {
    const text = (body as { text: string }).text;
    if (text.length > 280) return reply(res, 400, { error: { code: 'invalid', message: 'largo' } });
    return reply(res, 201, { id: 'm_1' });
  }
  if (req.method === 'POST' && sub === 'blockers') {
    const input = body as Pick<Blocker, 'kind' | 'question' | 'options' | 'accessLabel'>;
    const id = `b_${blockers.size + 1}`;
    const b: Blocker = {
      id,
      projectId: projectId!,
      nodeId: nodeId!,
      kind: input.kind,
      question: input.question,
      // como el Worker (#77): una revisión sin opciones recibe las del idioma del proyecto
      options: input.options ?? (input.kind === 'review' ? [...REVIEW_OPTIONS[projectLangs.get(projectId!) === 'en' ? 'en' : 'es']] : []),
      accessLabel: input.accessLabel ?? null,
      status: 'open',
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: new Date().toISOString(),
    };
    blockers.set(id, b);
    return reply(res, 201, b);
  }
  if (req.method === 'GET' && kind === 'blockers' && sub === 'wait') {
    // contrato: 200 apenas se resuelve, o al vencer con el bloqueante todavía open
    const b = blockers.get(nodeId!); // aquí el 5.º segmento es el id del bloqueante
    if (!b) return reply(res, 404, { error: { code: 'not_found', message: 'bloqueante' } });
    const deadline = Date.now() + Math.min(Number(url.searchParams.get('timeout')) * 1000, 300);
    while (Date.now() < deadline && b.status !== 'resolved') await new Promise((r) => setTimeout(r, 20));
    return reply(res, 200, { blocker: b, value: b.status === 'resolved' ? (accessValues.get(b.id) ?? null) : null });
  }
  reply(res, 404, { error: { code: 'not_found', message: url.pathname } });
}

/** Lo que hace el humano desde la UI (fuera del CLI). */
function resolveByApi(id: string, choice: string | null, opts: { note?: string; value?: string } = {}) {
  const b = blockers.get(id)!;
  b.status = 'resolved';
  b.resolution = { choice, note: opts.note ?? null, hasValue: opts.value !== undefined };
  b.resolvedBy = 'owner';
  b.resolvedAt = new Date().toISOString();
  if (opts.value !== undefined) accessValues.set(id, opts.value);
}

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  seen = [];
  blockers = new Map();
  accessValues = new Map();
  stages = [{ id: 'diseno', name: 'Diseño' }, { id: 'construccion', name: 'Construcción' }];
  nodes = [];
  edges = [];
  projects = new Set(['demo']);
  lockedProjects = new Set();
  projectLangs = new Map();
});

/** `cwd` por defecto: una carpeta temporal vacía, así ningún `.dagyard.json` del repo se cuela en los tests. */
async function cli(
  argv: string[],
  env: Record<string, string> = {},
  cwd = mkdtempSync(join(tmpdir(), 'dagyard-cwd-')),
  extra: Partial<Pick<Io, 'fetch' | 'open' | 'platform'>> = {},
) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    ...extra,
    cwd,
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: {
      LANG: 'es_PE.UTF-8',
      DAGYARD_URL: baseUrl,
      DAGYARD_KEY: KEY,
      DAGYARD_PROJECT: 'demo',
      DAGYARD_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dagyard-cfg-')),
      ...env,
    },
    sleep: async () => {},
  });
  return { code, stdout, stderr };
}

const last = () => seen[seen.length - 1]!;

describe('ayuda', () => {
  it.each([
    ['node', 'add'],
    ['node', 'update'],
    ['node', 'start'],
    ['node', 'progress'],
    ['node', 'done'],
    ['node', 'close'],
    ['goal', 'add'],
    ['request', 'add'],
    ['edge', 'add'],
    ['block'],
    ['wait'],
    ['msg'],
    ['next'],
    ['open'],
    ['import'],
    ['sync'],
  ])('%s %s --help', async (...cmd) => {
    const r = await cli([...cmd.filter(Boolean), '--help']);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toMatch(/^Uso: dagyard /);
    expect(seen).toHaveLength(0);
  });

  it('sin argumentos lista todos los comandos', async () => {
    const r = await cli([]);
    expect(r.code).toBe(0);
    for (const c of ['node add', 'edge add', 'block', 'wait', 'msg', 'next', 'open', 'import', 'sync']) expect(r.stdout).toContain(c);
  });

  it('comando u opción desconocidos → exit 64', async () => {
    expect((await cli(['vuela'])).code).toBe(EXIT.usage);
    expect((await cli(['msg', 'a', 'hola', '--color', 'rojo'])).code).toBe(EXIT.usage);
  });
});

describe('mutar el DAG', () => {
  it('node add manda el NodeInput con ids en slug', async () => {
    const r = await cli(['node', 'add', 'T-402', '--title', 'Pagos con tarjeta', '--stage', 'Construcción', '--dep', 'T-401,T-400', '--goal', 'Cobra con tarjeta']);
    expect(r.code).toBe(0);
    expect(last()).toMatchObject({
      method: 'POST',
      path: '/api/projects/demo/nodes',
      auth: `Bearer ${KEY}`,
      body: { id: 't-402', title: 'Pagos con tarjeta', stage: 'construccion', deps: ['t-401', 't-400'], goal: 'Cobra con tarjeta' },
    });
    expect(r.stdout).toBe('t-402\n');
  });

  it('start, progress y done (y sus atajos) hacen PATCH', async () => {
    await cli(['node', 'start', 'pagos', '--team', 'Construcción']);
    expect(last()).toMatchObject({ method: 'PATCH', path: '/api/projects/demo/nodes/pagos', body: { status: 'working', team: 'Construcción' } });
    await cli(['progress', 'pagos', '40%']);
    expect(last().body).toEqual({ progress: 0.4 });
    await cli(['done', 'pagos', '--report', 'https://basalt.example/r']);
    expect(last().body).toEqual({ status: 'done', reportUrl: 'https://basalt.example/r' });
    await cli(['node', 'update', 'pagos', '--title', 'Cobros']);
    expect(last().body).toEqual({ title: 'Cobros' });
  });

  it('--status blocked se rechaza: lo pone dagyard block', async () => {
    const r = await cli(['node', 'update', 'pagos', '--status', 'blocked']);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain('dagyard block');
    expect(seen).toHaveLength(0);
  });

  it('edge add', async () => {
    const r = await cli(['edge', 'add', 'diseno', 'pagos', '-p', 'Otro Proyecto']);
    expect(r.code).toBe(0);
    expect(last()).toMatchObject({ method: 'POST', path: '/api/projects/otro-proyecto/edges', body: { from: 'diseno', to: 'pagos' } });
  });
});

describe('el modelo del DAG (#90)', () => {
  it('node add: --kind, --quote, --author y --from con su --why; sin --stage no la manda; imprime solo el id', async () => {
    const r = await cli(['node', 'add', 'Pedido-11', '--title', 'Que sea un DAG', '--kind', 'request', '--quote', 'no tenía que ser árbol', '--author', 'André', '--from', 'G-1', '--why', 'para el panel', '--from', 'otra']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('pedido-11\n');
    expect(last()).toMatchObject({ method: 'POST', path: '/api/projects/demo/nodes' });
    expect(last().body).toEqual({
      id: 'pedido-11',
      title: 'Que sea un DAG',
      kind: 'request',
      quote: 'no tenía que ser árbol',
      quoteBy: 'André',
      origins: [{ from: 'g-1', why: 'para el panel' }, { from: 'otra' }],
      deps: [],
    });
  });

  it('goal add y request add son atajos de node add --kind', async () => {
    expect((await cli(['goal', 'add', 'panel', '--title', 'Panel vivo'])).stdout).toBe('panel\n');
    expect(last().body).toMatchObject({ id: 'panel', title: 'Panel vivo', kind: 'goal' });
    const r = await cli(['request', 'add', 'p7', '--title', 'Hazlo DAG', '--quote', 'hazlo DAG', '--author', 'André', '--from', 'panel']);
    expect(r.code).toBe(0);
    expect(last().body).toMatchObject({ id: 'p7', kind: 'request', quote: 'hazlo DAG', quoteBy: 'André', origins: [{ from: 'panel' }] });
  });

  it('errores de uso sin llamar al servidor: request sin cita, cita fuera de un request, --why sin --from, --kind raro', async () => {
    for (const argv of [
      ['request', 'add', 'p', '--title', 'P'],
      ['node', 'add', 'p', '--title', 'P', '--quote', 'q'],
      ['goal', 'add', 'g', '--title', 'G', '--quote', 'q'],
      ['goal', 'add', 'g', '--title', 'G', '--kind', 'task'],
      ['node', 'add', 'p', '--title', 'P', '--why', 'sin origen', '--from', 'a'],
      ['node', 'add', 'p', '--title', 'P', '--from', 'a', '--why', 'uno', '--why', 'dos'],
      ['node', 'add', 'p', '--title', 'P', '--kind', 'epica'],
    ]) {
      const r = await cli(argv);
      expect(r.code, argv.join(' ')).toBe(EXIT.usage);
    }
    expect(seen).toHaveLength(0);
    const es = await cli(['request', 'add', 'p', '--title', 'P']);
    expect(es.stderr).toContain('necesita --quote');
    const en = await cli(['request', 'add', 'p', '--title', 'P'], { LANG: 'en_US.UTF-8' });
    expect(en.stderr).toContain('needs --quote');
  });

  it('node close: manda {as, why, by, reportUrl} a …/close e imprime solo el id', async () => {
    let r = await cli(['node', 'close', 'T-1', '--as', 'replaced', '--by', 'T-2', '--why', 'partida en dos']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('t-1\n');
    expect(last()).toMatchObject({ method: 'POST', path: '/api/projects/demo/nodes/t-1/close', body: { as: 'replaced', by: 't-2', why: 'partida en dos' } });
    r = await cli(['node', 'close', 'a', '--as', 'done', '--report', 'https://basalt.example/r']);
    expect(last().body).toEqual({ as: 'done', reportUrl: 'https://basalt.example/r' });
  });

  it('node close: --as obligatorio y conocido, --by solo con replaced, porqué para replaced/dropped/learned', async () => {
    for (const argv of [
      ['node', 'close', 'a'],
      ['node', 'close', 'a', '--as', 'borrada'],
      ['node', 'close', 'a', '--as', 'replaced', '--why', 'x'],
      ['node', 'close', 'a', '--as', 'done', '--by', 'b'],
      ['node', 'close', 'a', '--as', 'dropped'],
      ['node', 'close', 'a', '--as', 'learned'],
    ]) {
      expect((await cli(argv)).code, argv.join(' ')).toBe(EXIT.usage);
    }
    expect(seen).toHaveLength(0);
  });

  it('edge add --kind origin --why manda un «nació de»; --why sin origin es error', async () => {
    const r = await cli(['edge', 'add', 'panel', 'p7', '--kind', 'origin', '--why', 'sale del panel']);
    expect(r.code).toBe(0);
    expect(last().body).toEqual({ from: 'panel', to: 'p7', kind: 'origin', why: 'sale del panel' });
    expect((await cli(['edge', 'add', 'a', 'b', '--why', 'x'])).code).toBe(EXIT.usage);
    expect((await cli(['edge', 'add', 'a', 'b', '--kind', 'nace'])).code).toBe(EXIT.usage);
  });
});

describe('msg', () => {
  it('manda el texto y el informe', async () => {
    const r = await cli(['msg', 'pagos', 'Listo el cobro, falta el reembolso', '--report', 'https://basalt.example/r']);
    expect(r.code).toBe(0);
    expect(last()).toMatchObject({ path: '/api/projects/demo/nodes/pagos/messages', body: { text: 'Listo el cobro, falta el reembolso', reportUrl: 'https://basalt.example/r' } });
  });

  it('rechaza más de 280 caracteres sin llamar al servidor', async () => {
    const r = await cli(['msg', 'pagos', 'a'.repeat(281)]);
    expect(r.code).toBe(EXIT.usage);
    expect(seen).toHaveLength(0);
  });
});

describe('next', () => {
  it('imprime el /goal del servidor en una sola línea física', async () => {
    nodes = [
      mockNode('flujo', 'diseno', 'done'),
      mockNode('pagos', 'construccion', 'pending', 'Pagos con tarjeta —\n  sigue el plan\ty cumple'),
      mockNode('reembolsos', 'construccion', 'pending'),
    ];
    edges = [
      { projectId: 'demo', from: 'flujo', to: 'pagos' },
      { projectId: 'demo', from: 'pagos', to: 'reembolsos' },
    ];
    const r = await cli(['next', '--project', 'demo']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('/goal Pagos con tarjeta — sigue el plan y cumple\n');
    expect(r.stdout.trimEnd().split('\n')).toHaveLength(1);
  });

  it('exit 3 si no hay nada arrancable', async () => {
    nodes = [mockNode('flujo', 'diseno', 'working'), mockNode('pagos', 'construccion', 'pending')];
    edges = [{ projectId: 'demo', from: 'flujo', to: 'pagos' }];
    const r = await cli(['next']);
    expect(r.code).toBe(EXIT.nothing);
    expect(r.stdout).toBe('');
  });

  it('el link de la tarea va por stderr (stdout sigue siendo solo el /goal) y en --json', async () => {
    nodes = [mockNode('pagos', 'construccion', 'pending')];
    const r = await cli(['next']);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('/goal ')).toBe(true);
    expect(r.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(r.stderr).toBe(`en el cielo: ${baseUrl}/?p=demo&n=pagos\n`);

    const j = await cli(['next', '--json']);
    expect(JSON.parse(j.stdout)).toMatchObject({ node: { id: 'pagos' }, link: `${baseUrl}/?p=demo&n=pagos` });
    expect(j.stderr).toBe('');
  });

  it('--json sin nada arrancable: link null', async () => {
    const r = await cli(['next', '--json']);
    expect(r.code).toBe(EXIT.nothing);
    expect(JSON.parse(r.stdout)).toMatchObject({ node: null, link: null });
  });
});

describe('open', () => {
  const opener = () => {
    const opened: string[] = [];
    return { opened, open: async (link: string) => void opened.push(link) };
  };

  it('sin tarea: el link del proyecto, y en macOS lo abre', async () => {
    const o = opener();
    const r = await cli(['open'], {}, undefined, { platform: 'darwin', open: o.open });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${baseUrl}/?p=demo\n`);
    expect(o.opened).toEqual([`${baseUrl}/?p=demo`]);
    expect(seen).toHaveLength(0); // no llama al servidor
  });

  it('con tarea: vuela a ella (id normalizado y codificado)', async () => {
    const o = opener();
    const r = await cli(['open', 'GH-47', '--project', 'Mi Proyecto', '--url', 'https://cielo.example/'], {}, undefined, {
      platform: 'darwin',
      open: o.open,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('https://cielo.example/?p=mi-proyecto&n=gh-47\n');
    expect(o.opened).toEqual(['https://cielo.example/?p=mi-proyecto&n=gh-47']);
  });

  it('--print y fuera de macOS solo imprime', async () => {
    const o = opener();
    expect((await cli(['open', 'x', '--print'], {}, undefined, { platform: 'darwin', open: o.open })).stdout).toBe(`${baseUrl}/?p=demo&n=x\n`);
    expect((await cli(['open', 'x'], {}, undefined, { platform: 'linux', open: o.open })).code).toBe(0);
    expect(o.opened).toEqual([]);
  });

  it('no necesita la key y nunca la pone en el link', async () => {
    const r = await cli(['open', 'x', '--print'], { DAGYARD_KEY: '' });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(KEY);
  });

  it('si el navegador no abre, avisa pero el link ya salió (exit 0)', async () => {
    const r = await cli(['open'], {}, undefined, {
      platform: 'darwin',
      open: async () => {
        throw new Error('sin navegador');
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${baseUrl}/?p=demo\n`);
    expect(r.stderr).toContain('no pude abrir el navegador (sin navegador)');
  });

  it('una sola tarea; sin servidor → exit 64', async () => {
    expect((await cli(['open', 'a', 'b', '--print'])).code).toBe(EXIT.usage);
    expect((await cli(['open', '--print'], { DAGYARD_URL: '' })).code).toBe(EXIT.usage);
  });

  it('skyLink: misma forma que la web', () => {
    expect(skyLink('https://x//', 'dagyard')).toBe('https://x/?p=dagyard');
    expect(skyLink('https://x', 'dagyard', 'gh-47')).toBe('https://x/?p=dagyard&n=gh-47');
    expect(skyLink('https://x', 'a b', 'c&d')).toBe('https://x/?p=a%20b&n=c%26d');
  });
});

describe('block + wait', () => {
  it('decision: block imprime el id y wait devuelve la elección cuando se resuelve por la API', async () => {
    const b = await cli(['block', 'pagos', '--kind', 'decision', '--q', '¿Qué pasarela?', '--opt', 'Culqi', '--opt', 'Niubiz']);
    expect(b.code).toBe(0);
    const id = b.stdout.trim();
    expect(blockers.get(id)).toMatchObject({ kind: 'decision', options: ['Culqi', 'Niubiz'] });

    const waiting = cli(['wait', 'pagos', '--blocker', id]);
    await new Promise((r) => setTimeout(r, 450)); // al menos una vuelta de long-poll vence en 204
    resolveByApi(id, 'Niubiz', { note: 'más barata' });
    const w = await waiting;
    expect(w.code).toBe(0);
    expect(w.stdout).toBe('Niubiz\nnota: más barata\n');
    const waits = seen.filter((s) => s.path.endsWith('/wait'));
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(waits[0]!.path).toBe(`/api/projects/demo/blockers/${id}/wait`);
  });

  it('access: wait devuelve el valor; --json la resolución completa', async () => {
    const b = await cli(['block', 'pagos', '--kind', 'access', '--q', 'Necesito la clave', '--label', 'Clave de la pasarela']);
    const id = b.stdout.trim();
    expect(blockers.get(id)).toMatchObject({ options: [], accessLabel: 'Clave de la pasarela' });
    resolveByApi(id, null, { value: 'sk_test_42' });
    const w = await cli(['wait', 'pagos', '--json']);
    expect(w.code).toBe(0);
    expect(JSON.parse(w.stdout)).toMatchObject({ value: 'sk_test_42', blocker: { id, status: 'resolved' } });
  });

  it('wait sin --blocker toma el último abierto del nodo desde el snapshot', async () => {
    const a = (await cli(['block', 'pagos', '--kind', 'decision', '--q', '¿A?', '--opt', 'Sí'])).stdout.trim();
    const b = (await cli(['block', 'pagos', '--kind', 'decision', '--q', '¿B?', '--opt', 'No'])).stdout.trim();
    resolveByApi(a, 'Sí');
    resolveByApi(b, 'No');
    blockers.get(a)!.createdAt = '2026-01-01T00:00:00.000Z';
    blockers.get(b)!.createdAt = '2026-01-02T00:00:00.000Z';
    const w = await cli(['wait', 'pagos']);
    expect(w.code).toBe(0);
    expect(w.stdout).toBe('No\n');
    expect(last().path).toBe(`/api/projects/demo/blockers/${b}/wait`);
  });

  it('wait de un nodo sin bloqueantes explica cómo abrir uno', async () => {
    const w = await cli(['wait', 'otro']);
    expect(w.code).toBe(EXIT.usage);
    expect(w.stderr).toContain('dagyard block otro');
  });

  it('review sin --opt ofrece Aprobar / Pedir cambios', async () => {
    const b = await cli(['block', 'pagos', '--kind', 'review', '--q', 'Revisa el flujo']);
    expect(blockers.get(b.stdout.trim())?.options).toEqual(['Aprobar', 'Pedir cambios']);
  });

  it('wait con --timeout vence con exit 2', async () => {
    await cli(['block', 'pagos', '--kind', 'decision', '--q', '¿Sí?', '--opt', 'Sí']);
    const w = await cli(['wait', 'pagos', '--timeout', '1']);
    expect(w.code).toBe(EXIT.timeout);
  });

  it('valida kind y opciones antes de llamar', async () => {
    expect((await cli(['block', 'pagos', '--kind', 'otro', '--q', 'x'])).code).toBe(EXIT.usage);
    expect((await cli(['block', 'pagos', '--kind', 'decision', '--q', 'x'])).code).toBe(EXIT.usage);
    expect(seen).toHaveLength(0);
  });
});

describe('import', () => {
  const from = join(__dirname, 'fixtures', 'basalt');

  it('--dry-run no necesita servidor ni key', async () => {
    const r = await cli(['import', '--from', from, '--dry-run'], { DAGYARD_URL: '', DAGYARD_KEY: '' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('23 nodos');
    expect(r.stdout).toContain('simulación');
    expect(seen).toHaveLength(0);
  });

  it('sin --dry-run crea el proyecto con un solo PUT exclusivo (If-None-Match: *), sin GET previo', async () => {
    const r = await cli(['import', '--from', from, '--project', 'basalt-fabrica', '--name', 'Basalt (fábrica)']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('importado');
    expect(seen.map((x) => `${x.method} ${x.path}`)).toEqual(['PUT /api/projects/basalt-fabrica']);
    const put = last();
    expect(put).toMatchObject({ method: 'PUT', path: '/api/projects/basalt-fabrica', ifNoneMatch: '*' });
    const body = put.body as { name: string; nodes: Array<{ id: string; deps: string[] }> };
    expect(body.name).toBe('Basalt (fábrica)');
    expect(body.nodes.find((n) => n.id === 'l3')?.deps).toEqual(['l1', 'l2']);
  });

  it('si el proyecto ya existe no lo pisa: el servidor responde 409 al PUT exclusivo, exit 1 y mensaje claro', async () => {
    projects.add('basalt');
    const r = await cli(['import', '--from', from, '--project', 'basalt']);
    expect(r.code).toBe(EXIT.api);
    expect(r.stderr).toContain('conflict');
    expect(r.stderr).toContain('ya existe');
    expect(r.stderr).toContain('--replace');
    expect(seen.map((x) => `${x.method} ${x.path} ${x.ifNoneMatch}`)).toEqual(['PUT /api/projects/basalt *']);
  });

  it('--replace reemplaza un proyecto existente: lee su idioma y PUT sin If-None-Match', async () => {
    projects.add('basalt');
    const r = await cli(['import', '--from', from, '--project', 'basalt', '--replace']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('reemplazado');
    expect(seen.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /api/projects/basalt', 'PUT /api/projects/basalt']);
    expect(last().ifNoneMatch).toBeUndefined();
  });

  it('--replace que el servidor rechaza (409): el mensaje del servidor llega tal cual', async () => {
    projects.add('basalt');
    lockedProjects.add('basalt');
    const r = await cli(['import', '--from', from, '--project', 'basalt', '--replace']);
    expect(r.code).toBe(EXIT.api);
    expect(r.stderr).toContain('conflict: El proyecto tiene una pregunta abierta para el dueño');
  });

  it('--titles en línea pone los títulos humanos en el PUT y lo cuenta', async () => {
    const titles = JSON.stringify({ l1: 'Cada cliente con su propio espacio' });
    const r = await cli(['import', '--from', from, '--project', 'basalt-pm', '--titles', titles]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Títulos de --titles: 1 de 23');
    const body = last().body as { nodes: Array<{ id: string; title: string }> };
    expect(body.nodes.find((n) => n.id === 'l1')?.title).toBe('Cada cliente con su propio espacio');
  });

  it('--titles desde archivo: un id desconocido avisa y el import sigue', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'dagyard-titles-')), 'titulos.json');
    writeFileSync(f, JSON.stringify({ 't-599': 'Avisos más claros', fantasma: 'No existe' }));
    const r = await cli(['import', '--from', from, '--titles', f, '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Títulos de --titles: 1 de 23');
    expect(r.stdout).toContain('no hay ninguna tarea «fantasma»');
    expect(seen).toHaveLength(0);
  });

  it('--titles que no es un objeto JSON es error de uso (64) y no envía nada', async () => {
    const r = await cli(['import', '--from', from, '--project', 'basalt-pm', '--titles', '{l1:']);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain('--titles: no es JSON válido');
    expect(seen).toHaveLength(0);
  });

  it('un error que no es 409 al crear se propaga tal cual', async () => {
    const r = await cli(['import', '--from', from, '--project', 'basalt'], { DAGYARD_KEY: 'otra' });
    expect(r.code).toBe(EXIT.api);
    expect(r.stderr).toContain('unauthorized');
    expect(r.stderr).not.toContain('--replace');
  });
});

describe('idioma de los datos = el del proyecto, no LANG (#77)', () => {
  const from = join(__dirname, 'fixtures', 'basalt');
  type Put = { lang?: string; stages: Array<{ id: string; name: string }>; nodes: Array<{ id: string; goal: string }> };
  const putBody = () => seen.find((x) => x.method === 'PUT')!.body as Put;

  it('import de un proyecto nuevo sin flag: etapas, misión y lang en inglés (la consola sigue a LANG)', async () => {
    const r = await cli(['import', '--from', from, '--project', 'nuevo']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('importado');
    expect(seen.map((x) => `${x.method} ${x.path}`)).toEqual(['PUT /api/projects/nuevo']);
    const body = putBody();
    expect(body.lang).toBe('en');
    expect(body.stages.map((s) => s.name)).toEqual(['Getting started', 'Finally']);
    expect(body.nodes.find((n) => n.id === 'l1')!.goal).toContain('meet its acceptance criteria');
  });

  it('un proyecto en es sigue recibiendo etapas en español aunque LANG=en_US', async () => {
    projects.add('fabrica');
    projectLangs.set('fabrica', 'es');
    const r = await cli(['import', '--from', from, '--project', 'fabrica', '--replace'], { LANG: 'en_US.UTF-8' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('replaced');
    const body = putBody();
    expect(body.lang).toBe('es');
    expect(body.stages.map((s) => s.name)).toEqual(['Para empezar', 'Al final']);
    expect(body.nodes.find((n) => n.id === 'l1')!.goal).toContain('cumple su aceptación');
  });

  it('--replace sobre un proyecto guardado sin idioma (dagyard, las demos) lo trata como español', async () => {
    projects.add('dagyard');
    await cli(['import', '--from', from, '--project', 'dagyard', '--replace'], { LANG: 'en_US.UTF-8' });
    expect(putBody().stages.map((s) => s.name)).toEqual(['Para empezar', 'Al final']);
  });

  it('--replace sobre un proyecto en inglés lo deja en inglés aunque LANG=es', async () => {
    projects.add('shop');
    projectLangs.set('shop', 'en');
    await cli(['import', '--from', from, '--project', 'shop', '--replace']);
    expect(putBody().lang).toBe('en');
    expect(putBody().stages[0]!.name).toBe('Getting started');
  });

  it('--replace sobre un proyecto que no existe: nuevo, en inglés', async () => {
    const r = await cli(['import', '--from', from, '--project', 'otro', '--replace']);
    expect(r.code).toBe(0);
    expect(putBody().lang).toBe('en');
  });

  it('--lang es crea el proyecto nuevo en español; --lang gana al idioma guardado', async () => {
    await cli(['import', '--from', from, '--project', 'tienda', '--lang', 'es'], { LANG: 'en_US.UTF-8' });
    expect(putBody()).toMatchObject({ lang: 'es' });
    expect(putBody().stages[0]!.name).toBe('Para empezar');
    seen = [];
    await cli(['import', '--from', from, '--project', 'tienda', '--replace', '--lang', 'en']);
    expect(putBody().lang).toBe('en');
  });

  it('--lang que no es en | es es error de uso (64) y no envía nada', async () => {
    const r = await cli(['import', '--from', from, '--project', 'x', '--lang', 'fr']);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain('--lang');
    expect(seen).toHaveLength(0);
  });

  it('--dry-run sigue sin servidor: sin --lang, inglés', async () => {
    const r = await cli(['import', '--from', from, '--dry-run', '--json'], { DAGYARD_URL: '', DAGYARD_KEY: '' });
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(0);
    expect(JSON.parse(r.stdout).graph.lang).toBe('en');
  });

  it('--dry-run --replace lee el idioma si hay servidor; si no puede, avisa y sigue', async () => {
    projects.add('fabrica');
    projectLangs.set('fabrica', 'es');
    const ok = await cli(['import', '--from', from, '--project', 'fabrica', '--replace', '--dry-run', '--json']);
    expect(JSON.parse(ok.stdout).graph.lang).toBe('es');
    expect(seen.map((x) => x.method)).toEqual(['GET']);
    const off = await cli(['import', '--from', from, '--project', 'fabrica', '--replace', '--dry-run'], { DAGYARD_URL: '', DAGYARD_KEY: '' });
    expect(off.code).toBe(0);
    expect(off.stdout).toContain('Getting started');
    expect(off.stdout).toMatch(/no pude leer el idioma/);
  });

  it('review sin --opt: no manda opciones ni lee el proyecto; el servidor las pone en su idioma', async () => {
    const r = await cli(['block', 'pagos', '--kind', 'review', '--q', 'Revisa el flujo']);
    expect(r.code).toBe(0);
    expect(seen.map((x) => x.method)).toEqual(['POST']);
    expect(last().body).not.toHaveProperty('options');
    projectLangs.set('demo', 'en');
    const en = await cli(['block', 'pagos', '--kind', 'review', '--q', 'Revisa el flujo']);
    expect(blockers.get(en.stdout.trim())?.options).toEqual(['Approve', 'Request changes']);
    projectLangs.set('demo', 'es');
    const es = await cli(['block', 'pagos', '--kind', 'review', '--q', 'Check the flow'], { LANG: 'en_US.UTF-8' });
    expect(blockers.get(es.stdout.trim())?.options).toEqual(['Aprobar', 'Pedir cambios']);
  });

  it('review con --opt o una decision no leen el proyecto', async () => {
    await cli(['block', 'pagos', '--kind', 'review', '--q', 'x', '--opt', 'Listo']);
    await cli(['block', 'pagos', '--kind', 'decision', '--q', 'x', '--opt', 'A']);
    expect(seen.map((x) => x.method)).toEqual(['POST', 'POST']);
  });
});

describe('opciones globales antes del comando (#45)', () => {
  it('dagyard --project p --url u node start x funciona como si fueran después', async () => {
    const r = await cli(['--project', 'Fabrica', '--url', baseUrl, 'node', 'start', 'x'], { DAGYARD_URL: '' });
    expect(r.code).toBe(EXIT.ok);
    expect(last()).toMatchObject({ method: 'PATCH', path: '/api/projects/fabrica/nodes/x', body: { status: 'working' } });
  });

  it('-p y --project=… también, con atajos y comandos de una palabra', async () => {
    await cli(['-p', 'otro', 'start', 'x']);
    expect(last().path).toBe('/api/projects/otro/nodes/x');
    await cli(['--project=tercero', 'msg', 'x', 'hola']);
    expect(last().path).toBe('/api/projects/tercero/nodes/x/messages');
  });

  it('la opción después del comando gana a la de antes', async () => {
    await cli(['--project', 'antes', 'start', 'x', '--project', 'despues']);
    expect(last().path).toBe('/api/projects/despues/nodes/x');
  });

  it('solo opciones globales, sin comando → ayuda', async () => {
    const r = await cli(['--project', 'p']);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain('Comandos:');
  });

  it('una opción global sin valor es error de uso', async () => {
    const r = await cli(['--project']);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain('--project');
  });
});

describe('.dagyard.json (#45)', () => {
  /** repo/.dagyard.json + repo/a/b (el cwd) */
  function repoWith(content: string): { root: string; deep: string } {
    const root = mkdtempSync(join(tmpdir(), 'dagyard-repo-'));
    writeFileSync(join(root, '.dagyard.json'), content);
    const deep = join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    return { root, deep };
  }

  it('lo busca subiendo desde el cwd y usa su project y url (de confianza)', async () => {
    const { deep } = repoWith(JSON.stringify({ project: 'Dagyard', url: 'https://dagyard.run' }));
    const r = await cli(['start', 'x'], { DAGYARD_URL: '', DAGYARD_PROJECT: '' }, deep, { fetch: capture.fetch });
    expect(r.code).toBe(EXIT.ok);
    expect(capture.urls).toEqual(['https://dagyard.run/api/projects/dagyard/nodes/x']);
    expect(r.stderr).toBe('');
  });

  it('precedencia: flag > env > .dagyard.json > ~/.config/dagyard', async () => {
    const { deep } = repoWith(JSON.stringify({ project: 'del-archivo', url: 'http://127.0.0.1:1' }));
    const cfg = mkdtempSync(join(tmpdir(), 'dagyard-cfg-'));
    writeFileSync(join(cfg, 'project'), 'global');
    writeFileSync(join(cfg, 'url'), 'http://127.0.0.1:2');
    // archivo > global
    await cli(['start', 'x', '--url', baseUrl], { DAGYARD_PROJECT: '', DAGYARD_CONFIG_DIR: cfg }, deep);
    expect(last().path).toBe('/api/projects/del-archivo/nodes/x');
    // env > archivo (url y proyecto)
    await cli(['start', 'x'], { DAGYARD_PROJECT: 'del-env', DAGYARD_CONFIG_DIR: cfg }, deep);
    expect(last().path).toBe('/api/projects/del-env/nodes/x');
    // flag > env
    await cli(['start', 'x', '-p', 'del-flag'], { DAGYARD_PROJECT: 'del-env', DAGYARD_CONFIG_DIR: cfg }, deep);
    expect(last().path).toBe('/api/projects/del-flag/nodes/x');
    // sin archivo, el global
    await cli(['start', 'x', '--url', baseUrl], { DAGYARD_PROJECT: '', DAGYARD_CONFIG_DIR: cfg });
    expect(last().path).toBe('/api/projects/global/nodes/x');
  });

  it('la key NUNCA sale del archivo (se commitea)', async () => {
    const { deep } = repoWith(JSON.stringify({ project: 'p', url: baseUrl, key: KEY }));
    const r = await cli(['start', 'x'], { DAGYARD_KEY: '' }, deep);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain('API key');
    expect(seen).toHaveLength(0);
  });

  it('JSON inválido → error claro con la ruta', async () => {
    const { root, deep } = repoWith('{ project: ');
    const r = await cli(['start', 'x'], {}, deep);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain(join(root, '.dagyard.json'));
    expect(seen).toHaveLength(0);
  });

  it('un campo que no es texto también es error con la ruta', async () => {
    const { root, deep } = repoWith(JSON.stringify({ project: 42 }));
    const r = await cli(['start', 'x'], {}, deep);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain(join(root, '.dagyard.json'));
  });

  it('un .dagyard.json roto no impide la ayuda', async () => {
    const { deep } = repoWith('nope');
    expect((await cli(['--help'], {}, deep)).code).toBe(EXIT.ok);
  });
});

/** fetch que solo anota a dónde iría (y con qué credencial): ninguna red. */
const capture = {
  urls: [] as string[],
  auths: [] as string[],
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    capture.urls.push(String(input));
    capture.auths.push(String((init?.headers as Record<string, string>)?.authorization));
    return new Response(JSON.stringify({ id: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch,
};
beforeEach(() => {
  capture.urls = [];
  capture.auths = [];
});

describe('.dagyard.json: la url recibe la key solo si es de confianza (#50)', () => {
  function repoWith(url: string, cfg: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'dagyard-repo-'));
    writeFileSync(join(root, '.dagyard.json'), JSON.stringify({ project: 'p', url }));
    const dir = mkdtempSync(join(tmpdir(), 'dagyard-cfg-'));
    for (const [k, v] of Object.entries(cfg)) writeFileSync(join(dir, k), v);
    return { root, env: { LANG: 'es_PE.UTF-8', DAGYARD_URL: '', DAGYARD_PROJECT: '', DAGYARD_CONFIG_DIR: dir } };
  }
  const go = (r: ReturnType<typeof repoWith>) => cli(['start', 'x'], r.env, r.root, { fetch: capture.fetch });

  it.each([
    ['https://dagyard.cofoundy-dev.workers.dev'],
    ['https://dagyard.run/'],
  ])('las constantes de confianza: %s', async (url) => {
    const r = await go(repoWith(url));
    expect(r.code).toBe(EXIT.ok);
    expect(capture.urls[0]).toMatch(/^https:\/\/dagyard\.(run|cofoundy-dev\.workers\.dev)\/api\//);
  });

  it.each([
    ['https://evil.example'],
    ['http://dagyard.run'],
    ['https://dagyard.run.evil.example'],
    ['https://dagyard.run@evil.example'],
    ['https://dagyard.run:8443'],
  ])('una url ajena (%s) se ignora con aviso y cae a ~/.config/dagyard/url', async (url) => {
    const r = await go(repoWith(url, { url: 'https://mio.example' }));
    expect(r.code).toBe(EXIT.ok);
    expect(capture.urls).toEqual(['https://mio.example/api/projects/p/nodes/x']);
    expect(r.stderr).toContain('.dagyard.json');
    expect(r.stderr).toContain('trusted-urls');
    expect(r.stderr).not.toContain(KEY);
  });

  it('ajena y sin nada más: falta el servidor, y la key no viaja a ningún lado', async () => {
    const r = await go(repoWith('https://evil.example'));
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain('falta el servidor');
    expect(capture.urls).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it('el origen de ~/.config/dagyard/url es de confianza (con otra ruta)', async () => {
    const r = await go(repoWith('https://mio.example/base', { url: 'https://mio.example' }));
    expect(r.code).toBe(EXIT.ok);
    expect(capture.urls[0]).toBe('https://mio.example/base/api/projects/p/nodes/x');
    expect(r.stderr).toBe('');
  });

  it('las líneas de ~/.config/dagyard/trusted-urls también (comentarios y vacías se ignoran)', async () => {
    const r = await go(repoWith('https://equipo.example', { 'trusted-urls': '# mías\n\nhttps://otro.example\nhttps://equipo.example/\n' }));
    expect(r.code).toBe(EXIT.ok);
    expect(capture.urls[0]).toBe('https://equipo.example/api/projects/p/nodes/x');
  });

  it('con --url o DAGYARD_URL la url del archivo ni se mira: sin aviso', async () => {
    const a = await cli(['start', 'x', '--url', 'https://mio.example'], { DAGYARD_URL: '' }, repoWith('https://evil.example').root, { fetch: capture.fetch });
    const b = await cli(['start', 'x'], { DAGYARD_URL: 'https://mio.example' }, repoWith('https://evil.example').root, { fetch: capture.fetch });
    expect(a.stderr + b.stderr).toBe('');
    expect(capture.urls.every((u) => u.startsWith('https://mio.example/'))).toBe(true);
  });
});

describe('.dagyard.json: la búsqueda para en la raíz del repo o en $HOME (#50)', () => {
  it('para en el primer directorio con .git (carpeta): el de más arriba no cuenta', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dagyard-up-'));
    writeFileSync(join(root, '.dagyard.json'), JSON.stringify({ project: 'plantado' }));
    mkdirSync(join(root, 'repo', '.git'), { recursive: true });
    mkdirSync(join(root, 'repo', 'src'));
    const r = await cli(['start', 'x'], { DAGYARD_PROJECT: '' }, join(root, 'repo', 'src'));
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain('falta el proyecto');
  });

  it('un .git archivo (worktree) también marca la raíz, y el .dagyard.json de esa raíz sí cuenta', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dagyard-up-'));
    mkdirSync(join(root, 'wt', 'src'), { recursive: true });
    writeFileSync(join(root, 'wt', '.git'), 'gitdir: /x\n');
    writeFileSync(join(root, 'wt', '.dagyard.json'), JSON.stringify({ project: 'del-repo' }));
    writeFileSync(join(root, '.dagyard.json'), JSON.stringify({ project: 'plantado' }));
    await cli(['start', 'x'], { DAGYARD_PROJECT: '' }, join(root, 'wt', 'src'));
    expect(last().path).toBe('/api/projects/del-repo/nodes/x');
  });

  it('para en $HOME', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dagyard-up-'));
    writeFileSync(join(root, '.dagyard.json'), JSON.stringify({ project: 'plantado' }));
    mkdirSync(join(root, 'home', 'a'), { recursive: true });
    const r = await cli(['start', 'x'], { DAGYARD_PROJECT: '', HOME: join(root, 'home') }, join(root, 'home', 'a'));
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain('falta el proyecto');
  });
});

describe('--link (#45)', () => {
  it('node add y node update mandan link', async () => {
    await cli(['node', 'add', 'gh-7', '--title', 'Cobros', '--stage', 'construccion', '--link', 'https://github.com/o/r/issues/7']);
    expect(last().body).toMatchObject({ id: 'gh-7', link: 'https://github.com/o/r/issues/7' });
    await cli(['node', 'update', 'gh-7', '--link', 'https://github.com/o/r/pull/9']);
    expect(last().body).toEqual({ link: 'https://github.com/o/r/pull/9' });
  });

  it('un link que no es http(s) se rechaza sin llamar', async () => {
    const r = await cli(['node', 'update', 'gh-7', '--link', 'issue 7']);
    expect(r.code).toBe(EXIT.usage);
    expect(seen).toHaveLength(0);
  });
});

describe('import: lo que pide algo a una persona (#38)', () => {
  function tasks(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'dagyard-tasks-'));
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    return dir;
  }

  it('dice «1 pide algo a una persona» y no dice «te esperan»', async () => {
    const from = tasks({
      'a.md': '---\nid: T-1\nstatus: done\n---\n# Base',
      'b.md': '---\nid: T-2\nstatus: blocked  # ESCALATION REQUIRED\ndeps: [T-1]\n---\n# Escalada',
    });
    const r = await cli(['import', '--from', from, '--dry-run']);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain('1 pide algo a una persona');
    expect(r.stdout).not.toContain('te esperan');
  });

  it('en plural con varias', async () => {
    const from = tasks({
      'a.md': '---\nid: T-1\nstatus: blocked  # needs founder decision\n---\n# Una',
      'b.md': '---\nid: T-2\nstatus: blocked  # ESCALATION REQUIRED\n---\n# Otra',
    });
    const r = await cli(['import', '--from', from, '--dry-run']);
    expect(r.stdout).toContain('2 piden algo a una persona');
  });

  it('sin ninguna, no muestra un contador en cero', async () => {
    const r = await cli(['import', '--from', join(__dirname, 'fixtures', 'pets'), '--dry-run']);
    expect(r.stdout).not.toContain('te esperan');
    expect(r.stdout).not.toContain('0 piden');
  });
});

describe('errores', () => {
  it('nunca imprime la API key, aunque el servidor la devuelva', async () => {
    const bad = 'otra-clave-que-no-sirve';
    const r = await cli(['msg', 'pagos', 'hola'], { DAGYARD_KEY: bad });
    expect(r.code).toBe(EXIT.api);
    expect(r.stderr).toContain('unauthorized');
    expect(r.stderr).not.toContain(bad);
    expect(r.stdout + r.stderr).not.toContain(KEY);
  });

  it('sin servidor configurado explica de dónde sale', async () => {
    const r = await cli(['next'], { DAGYARD_URL: '' });
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain('DAGYARD_URL');
  });

  it('servidor caído → exit 1 con mensaje', async () => {
    const r = await cli(['next'], { DAGYARD_URL: 'http://127.0.0.1:1' });
    expect(r.code).toBe(EXIT.api);
    expect(r.stderr).toContain('no pude conectar');
  });
});

describe('helpers', () => {
  it('progressArg acepta 0..1, 0..100 y %', () => {
    expect(progressArg('0.25')).toBe(0.25);
    expect(progressArg('40')).toBe(0.4);
    expect(progressArg('100%')).toBe(1);
    expect(() => progressArg('150%')).toThrow();
  });

  it('goalLine siempre empieza con /goal', () => {
    expect(goalLine('Pagos')).toBe('/goal Pagos');
    expect(goalLine('/goal  Pagos\n')).toBe('/goal Pagos');
  });
});
