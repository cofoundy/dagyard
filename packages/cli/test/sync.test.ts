import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { wouldCreateCycle, type Blocker, type DagNode, type Edge, type NodeInput, type NodePatch, type Stage } from '@dagyard/model';
import { EXIT, run } from '../src/cli.js';
import {
  cleanTitle,
  closingRefs,
  dependencyRefs,
  ghCliSource,
  parseOptions,
  type GhIssue,
  type GhPull,
  type GithubSource,
} from '../src/sync/github.js';

const KEY = 'clave-sync';
const URL_BASE = 'http://dagyard.test';
const AT = '2026-10-04T00:00:00.000Z';

/* ------------------------------------------------------------ API falsa con estado */

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let calls: Call[];
let projectExists: boolean;
let stages: Stage[];
/** idioma del proyecto del mock; undefined = guardado antes del campo (#77) */
let projectLang: 'en' | 'es' | undefined;
let nodes: Map<string, DagNode>;
let edges: Edge[];
/** «nació de» (#90): from → to */
let origins: Edge[];
let blockers: Blocker[];

function node(id: string, extra: Partial<DagNode> = {}): DagNode {
  return {
    id,
    projectId: 'dagyard',
    stage: 'construccion',
    title: id,
    status: 'pending',
    progress: 0,
    team: null,
    goal: null,
    reportUrl: null,
    link: null,
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  };
}

function blocker(nodeId: string, question: string, status: Blocker['status'] = 'open'): Blocker {
  return {
    id: `b_${blockers.length + 1}`,
    projectId: 'dagyard',
    nodeId,
    kind: 'decision',
    question,
    options: ['Sí', 'No'],
    accessLabel: null,
    status,
    resolution: status === 'resolved' ? { choice: 'Sí', note: null, hasValue: false } : null,
    resolvedBy: status === 'resolved' ? 'owner' : null,
    resolvedAt: status === 'resolved' ? AT : null,
    createdAt: AT,
  };
}

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, path: url.pathname, body });
  if ((init?.headers as Record<string, string>)?.authorization !== `Bearer ${KEY}`) return err(401, 'unauthorized', 'token');
  const [, , , pid, kind, nid, sub] = url.pathname.split('/');
  if (!projectExists) return err(404, 'not_found', `El proyecto «${pid}» no existe`);
  if (method === 'GET' && !kind) {
    return json(200, {
      project: { id: pid, name: 'Dagyard', stages, ...(projectLang ? { lang: projectLang } : {}), createdAt: AT, updatedAt: AT },
      nodes: [...nodes.values()],
      edges,
      origins,
      blockers,
      messages: [],
      seq: 1,
    });
  }
  if (method === 'POST' && kind === 'nodes' && !nid) {
    const input = body as NodeInput;
    if (nodes.has(input.id!)) return err(409, 'conflict', 'id repetido');
    if (!stages.some((s) => s.id === input.stage)) return err(400, 'invalid', 'etapa');
    const n = node(input.id!, {
      stage: input.stage,
      title: input.title,
      status: input.status ?? 'pending',
      progress: input.status === 'done' ? 1 : 0,
      link: input.link ?? null,
    });
    nodes.set(n.id, n);
    return json(201, n);
  }
  if (method === 'PATCH' && kind === 'nodes' && nid) {
    const n = nodes.get(nid);
    if (!n) return err(404, 'not_found', 'nodo');
    const patch = body as NodePatch;
    if (patch.status && blockers.some((b) => b.nodeId === nid && b.status === 'open')) {
      return err(409, 'conflict', 'tiene un bloqueante abierto');
    }
    Object.assign(n, patch);
    return json(200, n);
  }
  if (method === 'POST' && kind === 'edges' && (body as { kind?: string }).kind === 'origin') {
    const { from, to } = body as { from: string; to: string };
    if (!nodes.has(from) || !nodes.has(to)) return err(404, 'not_found', 'nodo');
    if (origins.some((e) => e.from === from && e.to === to)) return err(409, 'conflict', 'ya existe');
    if (wouldCreateCycle(origins, from, to)) return err(400, 'cycle', 'cerraría un ciclo');
    const o = { projectId: 'dagyard', from, to };
    origins.push(o);
    return json(201, { ...o, why: null, createdAt: AT });
  }
  if (method === 'POST' && kind === 'edges') {
    const { from, to } = body as { from: string; to: string };
    if (!nodes.has(from) || !nodes.has(to)) return err(404, 'not_found', 'nodo');
    if (edges.some((e) => e.from === from && e.to === to)) return err(409, 'conflict', 'ya existe');
    if (wouldCreateCycle(edges, from, to)) return err(400, 'cycle', 'cerraría un ciclo');
    const e = { projectId: 'dagyard', from, to };
    edges.push(e);
    return json(201, e);
  }
  if (method === 'POST' && sub === 'blockers') {
    const b = { ...blocker(nid!, body.question), options: body.options };
    blockers.push(b);
    nodes.get(nid!)!.status = 'blocked';
    return json(201, b);
  }
  return err(500, 'internal', `ruta inesperada ${method} ${url.pathname}`);
};

/* ------------------------------------------------------------ GitHub falso */

let ghIssues: GhIssue[];
let ghPulls: GhPull[];
let sourceCalls: Array<{ repo: string; label?: string }>;

const fakeSource: GithubSource = {
  async issues(repo, opts) {
    sourceCalls.push({ repo, ...(opts.label ? { label: opts.label } : {}) });
    return ghIssues.filter((i) => !opts.label || i.labels.includes(opts.label));
  },
  async openPulls() {
    return ghPulls;
  },
};

const ghUrl = (n: number) => `https://github.com/cofoundy/dagyard/issues/${n}`;

function issue(n: number, title: string, extra: Partial<GhIssue> = {}): GhIssue {
  return {
    number: n,
    title,
    body: '',
    state: 'open',
    stateReason: null,
    url: `https://github.com/cofoundy/dagyard/issues/${n}`,
    labels: [],
    isPull: false,
    ...extra,
  };
}

beforeEach(() => {
  calls = [];
  projectExists = true;
  projectLang = undefined;
  stages = [
    { id: 'diseno', name: 'Diseño' },
    { id: 'construccion', name: 'Construcción' },
  ];
  nodes = new Map();
  edges = [];
  origins = [];
  blockers = [];
  ghIssues = [];
  ghPulls = [];
  sourceCalls = [];
});

async function sync(extra: string[] = [], env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const code = await run(['sync', '--github', 'cofoundy/dagyard', ...extra], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: {
      LANG: 'es_PE.UTF-8',
      DAGYARD_URL: URL_BASE,
      DAGYARD_KEY: KEY,
      DAGYARD_PROJECT: 'dagyard',
      DAGYARD_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dagyard-cfg-')),
      ...env,
    },
    cwd: mkdtempSync(join(tmpdir(), 'dagyard-cwd-')),
    fetch: fakeFetch,
    github: fakeSource,
  });
  return { code, stdout, stderr };
}

const writes = () => calls.filter((c) => c.method !== 'GET');

/* ------------------------------------------------------------ tests */

describe('sync: nodos nuevos', () => {
  it('crea gh-<n> desde los issues abiertos: título limpio, etapa construcción, link del issue', async () => {
    ghIssues = [issue(12, 'cli: el resumen del import dice «0 te esperan»'), issue(13, 'Pantalla de pagos')];
    const r = await sync();
    expect(r.code).toBe(EXIT.ok);
    expect(nodes.get('gh-12')).toMatchObject({
      title: 'El resumen del import dice «0 te esperan»',
      stage: 'construccion',
      status: 'pending',
      link: 'https://github.com/cofoundy/dagyard/issues/12',
    });
    expect(nodes.get('gh-13')?.title).toBe('Pantalla de pagos');
    expect(r.stdout).toContain('Sincronicé 2 issues: 2 nuevas · 0 actualizadas · 0 sin cambios');
  });

  it('el título nuevo pasa por legibleTitle: sin «desde #35», sin rutas ni MAYÚSCULAS enfáticas', async () => {
    ghIssues = [
      issue(38, 'cli: el resumen del import siempre dice «0 te esperan» desde #35'),
      issue(39, 'web: la ficha muestra T-402 en lib/x.ts — MAYÚSCULAS'),
      issue(40, 'Arreglo (ver #12) del panel'),
    ];
    await sync();
    expect(nodes.get('gh-38')?.title).toBe('El resumen del import siempre dice «0 te esperan»');
    expect(nodes.get('gh-39')?.title).toBe('La ficha muestra T-402 en x — mayúsculas');
    expect(nodes.get('gh-40')?.title).not.toMatch(/#\d/);
  });

  it('los PRs del listado no son issues', async () => {
    ghIssues = [issue(1, 'Algo'), issue(2, 'feat: un PR', { isPull: true })];
    const r = await sync();
    expect([...nodes.keys()]).toEqual(['gh-1']);
    expect(r.stdout).toContain('Sincronicé 1 issues');
  });

  it('sin --all no crea los cerrados; con --all los crea Listos; not_planned nunca', async () => {
    ghIssues = [
      issue(1, 'Abierto'),
      issue(2, 'Cerrado', { state: 'closed', stateReason: 'completed' }),
      issue(3, 'Descartado', { state: 'closed', stateReason: 'not_planned' }),
    ];
    await sync();
    expect([...nodes.keys()]).toEqual(['gh-1']);
    const r = await sync(['--all']);
    expect(nodes.get('gh-2')?.status).toBe('done');
    expect(nodes.has('gh-3')).toBe(false);
    expect(r.stdout).toContain('1 nuevas');
  });

  it('un issue abierto con un PR abierto que lo cierra nace En progreso', async () => {
    ghIssues = [issue(5, 'Login')];
    ghPulls = [{ number: 50, title: 'feat(auth): login', body: 'Algo.\n\nCLOSES #5' }];
    await sync();
    expect(nodes.get('gh-5')?.status).toBe('working');
  });

  it('--stage elige la etapa; sin «construccion» va a la primera', async () => {
    ghIssues = [issue(1, 'Uno')];
    await sync(['--stage', 'Diseño']);
    expect(nodes.get('gh-1')?.stage).toBe('diseno');
    nodes.clear();
    stages = [{ id: 'para-empezar', name: 'Para empezar' }, { id: 'despues', name: 'Después' }];
    await sync();
    expect(nodes.get('gh-1')?.stage).toBe('para-empezar');
  });

  it('--stage que no existe es error de uso y no escribe nada', async () => {
    ghIssues = [issue(1, 'Uno')];
    const r = await sync(['--stage', 'luna']);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain('luna');
    expect(writes()).toHaveLength(0);
  });

  it('--label filtra en la fuente', async () => {
    ghIssues = [issue(1, 'Uno', { labels: ['agent-ready'] }), issue(2, 'Dos')];
    await sync(['--label', 'agent-ready']);
    expect(sourceCalls).toEqual([{ repo: 'cofoundy/dagyard', label: 'agent-ready' }]);
    expect([...nodes.keys()]).toEqual(['gh-1']);
  });
});

describe('sync: idioma del proyecto (#77)', () => {
  const projectWrites = () => calls.filter((c) => c.method !== 'GET' && !c.path.includes('/nodes') && !c.path.includes('/edges'));

  it('un proyecto en es con LANG=en_US: la tarea nueva va a «Construcción» y no aparece ninguna etapa nueva', async () => {
    projectLang = 'es';
    const before = structuredClone(stages);
    ghIssues = [issue(1, 'Pagos')];
    const r = await sync([], { LANG: 'en_US.UTF-8' });
    expect(r.code).toBe(EXIT.ok);
    expect(nodes.get('gh-1')?.stage).toBe('construccion');
    expect(stages).toEqual(before);
    expect(projectWrites()).toEqual([]);
    expect(r.stdout).toContain('Synced 1 issues');
  });

  it('un proyecto en en con LANG=es: va a «Build»', async () => {
    projectLang = 'en';
    stages = [{ id: 'design', name: 'Design' }, { id: 'build', name: 'Build' }];
    ghIssues = [issue(1, 'Pagos')];
    await sync();
    expect(nodes.get('gh-1')?.stage).toBe('build');
  });

  it('reconoce la etapa por id o por nombre en cualquier idioma: nunca duplica', async () => {
    projectLang = 'es';
    for (const wanted of ['build', 'Build', 'construccion', 'Construcción']) {
      nodes = new Map();
      calls = [];
      ghIssues = [issue(1, 'Pagos')];
      const r = await sync(['--stage', wanted], { LANG: 'en_US.UTF-8' });
      expect(r.code, wanted).toBe(EXIT.ok);
      expect(nodes.get('gh-1')?.stage, wanted).toBe('construccion');
      expect(projectWrites(), wanted).toEqual([]);
    }
    projectLang = 'en';
    stages = [{ id: 'design', name: 'Design' }, { id: 'build', name: 'Build' }];
    for (const [wanted, id] of [['Construcción', 'build'], ['diseno', 'design'], ['Diseño', 'design']] as const) {
      nodes = new Map();
      ghIssues = [issue(1, 'Pagos')];
      await sync(['--stage', wanted]);
      expect(nodes.get('gh-1')?.stage, wanted).toBe(id);
    }
    expect(stages.map((s) => s.id)).toEqual(['design', 'build']);
  });

  it('la demo en inglés (ids en español, nombres en inglés) también: va a «Build»', async () => {
    projectLang = 'en';
    stages = [{ id: 'diseno', name: 'Design' }, { id: 'construccion', name: 'Build' }];
    ghIssues = [issue(1, 'Pagos'), issue(2, 'Pantalla')];
    await sync(['--stage', 'build']);
    expect(nodes.get('gh-1')?.stage).toBe('construccion');
  });

  it('si la etapa existe con el nombre exacto, gana a la del otro idioma', async () => {
    projectLang = 'en';
    stages = [{ id: 'construccion', name: 'Construcción' }, { id: 'build', name: 'Build' }];
    ghIssues = [issue(1, 'Pagos')];
    await sync(['--stage', 'construccion']);
    expect(nodes.get('gh-1')?.stage).toBe('construccion');
    nodes = new Map();
    await sync();
    expect(nodes.get('gh-1')?.stage).toBe('build');
  });

  it('founder-input sin opciones en el cuerpo: Yes / No en un proyecto en en, Sí / No en uno en es', async () => {
    projectLang = 'en';
    ghIssues = [issue(5, '¿Cobramos en dólares?', { labels: ['founder-input'] })];
    await sync();
    expect(calls.find((c) => c.path.endsWith('/blockers'))?.body).toMatchObject({ options: ['Yes', 'No'] });

    projectLang = 'es';
    nodes = new Map();
    blockers = [];
    calls = [];
    await sync([], { LANG: 'en_US.UTF-8' });
    expect(calls.find((c) => c.path.endsWith('/blockers'))?.body).toMatchObject({ options: ['Sí', 'No'] });
  });

  it('un proyecto guardado sin idioma se trata como español', async () => {
    ghIssues = [issue(5, '¿Cobramos en dólares?', { labels: ['founder-input'] })];
    await sync([], { LANG: 'en_US.UTF-8' });
    expect(calls.find((c) => c.path.endsWith('/blockers'))?.body).toMatchObject({ options: ['Sí', 'No'] });
  });
});

describe('sync: épicas', () => {
  it('un issue con la etiqueta epic no crea nodo ni aristas hacia él, y no cuenta', async () => {
    ghIssues = [issue(44, 'epic: dogfood', { labels: ['epic'] }), issue(45, 'Parte uno', { body: 'Parte de #44.' })];
    const r = await sync();
    expect([...nodes.keys()]).toEqual(['gh-45']);
    expect(edges).toEqual([]);
    expect(r.stdout).toContain('Sincronicé 1 issues: 1 nuevas · 0 actualizadas · 0 sin cambios');
  });

  it('si la épica ya es un nodo, se actualiza como cualquier otro (enlace, estado, aristas)', async () => {
    nodes.set('gh-44', node('gh-44', { title: 'Dogfood' }));
    ghIssues = [
      issue(44, 'epic: dogfood', { labels: ['epic'], state: 'closed', stateReason: 'completed' }),
      issue(45, 'Parte uno', { body: 'Parte de #44.' }),
    ];
    await sync();
    expect(nodes.get('gh-44')).toMatchObject({ title: 'Dogfood', status: 'done', link: 'https://github.com/cofoundy/dagyard/issues/44' });
    expect(edges.map((e) => `${e.from}>${e.to}`)).toEqual(['gh-45>gh-44']);
  });
});

describe('sync: nodos que ya existen (los cura la fábrica)', () => {
  it('nunca cambia título, etapa, equipo ni goal; link solo si está vacío', async () => {
    nodes.set('gh-1', node('gh-1', { title: 'Título de la fábrica', stage: 'diseno', team: 'Núcleo', goal: 'Mi misión' }));
    nodes.set('gh-2', node('gh-2', { link: 'https://github.com/cofoundy/dagyard/pull/99' }));
    ghIssues = [issue(1, 'otro: título distinto'), issue(2, 'Dos')];
    const r = await sync();
    expect(nodes.get('gh-1')).toMatchObject({
      title: 'Título de la fábrica',
      stage: 'diseno',
      team: 'Núcleo',
      goal: 'Mi misión',
      link: 'https://github.com/cofoundy/dagyard/issues/1',
    });
    expect(nodes.get('gh-2')?.link).toBe('https://github.com/cofoundy/dagyard/pull/99');
    expect(r.stdout).toContain('0 nuevas · 1 actualizadas · 1 sin cambios');
    for (const c of writes()) expect(Object.keys(c.body as object).sort()).toEqual(['link']);
  });

  it('el estado solo avanza: cerrado → Lista; con PR abierto y Pendiente → En progreso', async () => {
    nodes.set('gh-1', node('gh-1', { link: ghUrl(1) }));
    nodes.set('gh-2', node('gh-2', { link: ghUrl(2) }));
    nodes.set('gh-3', node('gh-3', { link: ghUrl(3), status: 'working' }));
    nodes.set('gh-4', node('gh-4', { link: ghUrl(4), status: 'done' }));
    ghIssues = [
      issue(1, 'Uno', { state: 'closed', stateReason: 'completed' }),
      issue(2, 'Dos'),
      issue(3, 'Tres'),
      issue(4, 'Cuatro'),
    ];
    ghPulls = [{ number: 9, title: 'Fixes #2', body: '' }];
    await sync();
    expect(nodes.get('gh-1')?.status).toBe('done');
    expect(nodes.get('gh-2')?.status).toBe('working');
    expect(nodes.get('gh-3')?.status).toBe('working'); // abierto sin PR: no retrocede a Pendiente
    expect(nodes.get('gh-4')?.status).toBe('done'); // reabierto: no retrocede
  });

  it('un cerrado como not_planned no marca Lista el nodo', async () => {
    nodes.set('gh-1', node('gh-1', { link: ghUrl(1) }));
    ghIssues = [issue(1, 'Uno', { state: 'closed', stateReason: 'not_planned' })];
    await sync();
    expect(nodes.get('gh-1')?.status).toBe('pending');
    expect(writes()).toHaveLength(0);
  });

  it('con un bloqueante abierto no toca el estado: aviso, no error (y el link sí entra)', async () => {
    nodes.set('gh-1', node('gh-1', { status: 'blocked' }));
    blockers.push(blocker('gh-1', '¿Qué pasarela?'));
    ghIssues = [issue(1, 'Uno', { state: 'closed', stateReason: 'completed' })];
    const r = await sync();
    expect(r.code).toBe(EXIT.ok);
    expect(nodes.get('gh-1')).toMatchObject({ status: 'blocked', link: 'https://github.com/cofoundy/dagyard/issues/1' });
    expect(r.stdout).toMatch(/Avisos[\s\S]*gh-1/);
  });

  it('si el servidor responde 409 al cambiar el estado, avisa y conserva el resto del cambio', async () => {
    nodes.set('gh-1', node('gh-1')); // el snapshot no dice blocked, pero el servidor sí tiene uno abierto
    ghIssues = [issue(1, 'Uno', { state: 'closed', stateReason: 'completed' })];
    const original = blockers;
    const realFetch = fakeFetch;
    // el bloqueante aparece justo después del snapshot
    let snapshotServed = false;
    const racing: typeof fetch = async (input, init) => {
      const res = await realFetch(input, init);
      if (!snapshotServed && (init?.method ?? 'GET') === 'GET') {
        snapshotServed = true;
        original.push(blocker('gh-1', '¿Algo?'));
      }
      return res;
    };
    let stdout = '';
    const code = await run(['sync', '--github', 'cofoundy/dagyard'], {
      stdout: (s) => (stdout += s),
      stderr: () => {},
      env: { LANG: 'es_PE.UTF-8', DAGYARD_URL: URL_BASE, DAGYARD_KEY: KEY, DAGYARD_PROJECT: 'dagyard', DAGYARD_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'c-')) },
      cwd: mkdtempSync(join(tmpdir(), 'w-')),
      fetch: racing,
      github: fakeSource,
    });
    expect(code).toBe(EXIT.ok);
    expect(nodes.get('gh-1')?.link).toBe('https://github.com/cofoundy/dagyard/issues/1');
    expect(nodes.get('gh-1')?.status).toBe('pending');
    expect(stdout).toContain('Avisos');
  });
});

describe('sync: choques y cierres que no cuentan (#50)', () => {
  it('un nodo cuyo enlace apunta a otro repo se salta con aviso: ni estado, ni aristas, ni cuenta', async () => {
    nodes.set('gh-1', node('gh-1', { link: 'https://github.com/otra/cosa/issues/1' }));
    ghIssues = [issue(1, 'Uno', { state: 'closed', stateReason: 'completed' }), issue(2, 'Dos', { body: 'depende de #1' })];
    const r = await sync();
    expect(r.code).toBe(EXIT.ok);
    expect(nodes.get('gh-1')?.status).toBe('pending');
    expect(edges).toEqual([]);
    expect(r.stdout).toContain('Sincronicé 1 issues: 1 nuevas');
    expect(r.stdout).toMatch(/Avisos[\s\S]*gh-1[\s\S]*otra\/cosa/);
    expect(writes().map((c) => c.path)).toEqual(['/api/projects/dagyard/nodes']);
  });

  it('un enlace a OTRO issue del mismo repo también es choque', async () => {
    nodes.set('gh-1', node('gh-1', { link: ghUrl(77) }));
    ghIssues = [issue(1, 'Uno', { state: 'closed', stateReason: 'completed' })];
    const r = await sync();
    expect(nodes.get('gh-1')?.status).toBe('pending');
    expect(r.stdout).toContain('Avisos');
  });

  it('un enlace al PR del mismo repo no es choque: se sincroniza', async () => {
    nodes.set('gh-1', node('gh-1', { link: 'https://github.com/cofoundy/dagyard/pull/9' }));
    ghIssues = [issue(1, 'Uno', { state: 'closed', stateReason: 'completed' })];
    await sync();
    expect(nodes.get('gh-1')).toMatchObject({ status: 'done', link: 'https://github.com/cofoundy/dagyard/pull/9' });
  });

  it('cerrado como duplicate no es completado: no marca Lista ni se crea con --all', async () => {
    nodes.set('gh-1', node('gh-1', { link: ghUrl(1) }));
    ghIssues = [
      issue(1, 'Uno', { state: 'closed', stateReason: 'duplicate' }),
      issue(2, 'Dos', { state: 'closed', stateReason: 'duplicate' }),
    ];
    await sync(['--all']);
    expect(nodes.get('gh-1')?.status).toBe('pending');
    expect(nodes.has('gh-2')).toBe(false);
  });

  it('cerrado con state_reason null (issues viejos) sí es completado', async () => {
    nodes.set('gh-1', node('gh-1', { link: ghUrl(1) }));
    ghIssues = [issue(1, 'Uno', { state: 'closed', stateReason: null })];
    await sync();
    expect(nodes.get('gh-1')?.status).toBe('done');
  });
});

describe('sync: aristas', () => {
  it('«Parte de #n» → la épica necesita sus partes; «depende de / blocked by / bloqueado por #n» → n antes', async () => {
    ghIssues = [
      issue(44, 'Épica'),
      issue(45, 'Parte uno', { body: 'Parte de #44.' }),
      issue(46, 'Parte dos', { body: 'Depende de #45 y blocked by #47' }),
      issue(47, 'Base'),
      issue(48, 'Otra', { body: 'BLOQUEADO POR #47' }),
    ];
    await sync();
    const pairs = edges.map((e) => `${e.from}>${e.to}`).sort();
    expect(pairs).toEqual(['gh-45>gh-44', 'gh-45>gh-46', 'gh-47>gh-46', 'gh-47>gh-48']);
  });

  it('solo si ambos nodos existen; nunca borra', async () => {
    edges.push({ projectId: 'dagyard', from: 'gh-1', to: 'otro' });
    nodes.set('gh-1', node('gh-1', { link: ghUrl(1) }));
    nodes.set('otro', node('otro'));
    ghIssues = [issue(1, 'Uno', { body: 'depende de #999' })];
    await sync();
    expect(edges.map((e) => `${e.from}>${e.to}`)).toEqual(['gh-1>otro']);
    expect(writes()).toHaveLength(0);
  });

  it('una arista que ya existe no se vuelve a pedir; un ciclo es aviso', async () => {
    ghIssues = [issue(1, 'Uno', { body: 'depende de #2' }), issue(2, 'Dos', { body: 'depende de #1' })];
    const r = await sync();
    expect(r.code).toBe(EXIT.ok);
    expect(edges).toHaveLength(1);
    expect(r.stdout).toContain('ciclo');
  });
});

describe('sync: founder-input → decisión', () => {
  const body = `Necesito que elijas.

- **A (Cloudflare):** quedarnos en Workers
- **B:** irnos a Railway
- C) no hacer nada todavía
- nota suelta que no es opción`;

  it('abre un bloqueante decision con la pregunta y las opciones del cuerpo', async () => {
    ghIssues = [issue(7, 'infra: ¿dónde corre el panel?', { labels: ['founder-input'], body })];
    await sync();
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      nodeId: 'gh-7',
      question: '¿Dónde corre el panel?',
      options: ['A (Cloudflare): quedarnos en Workers', 'B: irnos a Railway', 'C: no hacer nada todavía'],
    });
    expect(calls.find((c) => c.path.endsWith('/blockers'))?.body).toMatchObject({ kind: 'decision' });
  });

  it('sin opciones parseables ofrece Sí / No', async () => {
    ghIssues = [issue(7, '¿Seguimos?', { labels: ['founder-input'], body: 'Dime.' })];
    await sync();
    expect(blockers[0]?.options).toEqual(['Sí', 'No']);
  });

  it('no re-pregunta lo que el dueño ya respondió (contrato #31)', async () => {
    nodes.set('gh-7', node('gh-7', { link: ghUrl(7), status: 'working' }));
    blockers.push(blocker('gh-7', '¿Seguimos?', 'resolved'));
    ghIssues = [issue(7, '¿Seguimos?', { labels: ['founder-input'] })];
    const r = await sync();
    expect(blockers).toHaveLength(1);
    expect(writes()).toHaveLength(0);
    expect(r.stdout).toContain('0 nuevas · 0 actualizadas · 1 sin cambios');
  });

  it('si el nodo ya tiene CUALQUIER decisión (abierta o resuelta, con otro texto), no abre otra', async () => {
    nodes.set('gh-7', node('gh-7', { link: ghUrl(7), status: 'working' }));
    nodes.set('gh-25', node('gh-25', { link: ghUrl(25), status: 'blocked' }));
    blockers.push(blocker('gh-7', 'Pregunta curada por la fábrica', 'resolved'));
    blockers.push(blocker('gh-25', '¿Abrimos el código ya?', 'open'));
    ghIssues = [
      issue(7, '¿Compramos dagyard.run? (default: todavía no)', { labels: ['founder-input'], body: '- **A:** no\n- **B:** sí' }),
      issue(25, '¿Cuándo abrimos el código?', { labels: ['founder-input'] }),
    ];
    const r = await sync();
    expect(blockers).toHaveLength(2);
    expect(writes()).toHaveLength(0);
    expect(r.stdout).toContain('0 nuevas · 0 actualizadas · 2 sin cambios');
  });

  it('un bloqueante que no es decisión (revisión o acceso) no cuenta: la decisión se abre', async () => {
    nodes.set('gh-7', node('gh-7', { link: ghUrl(7), status: 'working' }));
    blockers.push({ ...blocker('gh-7', 'Revisa el flujo', 'resolved'), kind: 'review' });
    ghIssues = [issue(7, '¿Seguimos?', { labels: ['founder-input'] })];
    await sync();
    expect(blockers.filter((b) => b.kind === 'decision')).toHaveLength(1);
  });

  it('un issue cerrado no abre pregunta', async () => {
    nodes.set('gh-7', node('gh-7', { link: ghUrl(7), status: 'done' }));
    ghIssues = [issue(7, '¿Seguimos?', { labels: ['founder-input'], state: 'closed', stateReason: 'completed' })];
    await sync();
    expect(blockers).toHaveLength(0);
  });
});

describe('sync: idempotencia y contrato', () => {
  function realistic() {
    ghIssues = [
      issue(44, 'epic: dogfood'),
      issue(45, 'dogfood: el proyecto por repo', { body: 'Parte de #44.' }),
      issue(46, 'Depende', { body: 'depende de #45' }),
      issue(47, '¿Dónde corre?', { labels: ['founder-input'], body: '- **A:** aquí\n- **B:** allá' }),
      issue(38, 'cli: resumen', { state: 'closed', stateReason: 'completed' }),
      issue(49, 'feat: PR', { isPull: true }),
    ];
    ghPulls = [{ number: 49, title: 'feat: algo', body: 'closes #46' }];
  }

  it('correrlo dos veces: la segunda, 0 nuevas, 0 actualizadas y ninguna escritura', async () => {
    realistic();
    const first = await sync();
    expect(first.stdout).toContain('Sincronicé 4 issues: 4 nuevas · 0 actualizadas · 0 sin cambios');
    const count = nodes.size;
    calls = [];
    const second = await sync();
    expect(second.code).toBe(EXIT.ok);
    expect(second.stdout).toContain('Sincronicé 4 issues: 0 nuevas · 0 actualizadas · 4 sin cambios');
    expect(writes()).toHaveLength(0);
    expect(nodes.size).toBe(count);
  });

  it('nunca usa PUT: solo GET snapshot y POST/PATCH granulares', async () => {
    realistic();
    await sync(['--all']);
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(['GET', 'POST', 'PATCH']).toContain(c.method);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('--dry-run no escribe nada y cuenta lo mismo', async () => {
    realistic();
    const r = await sync(['--dry-run']);
    expect(r.code).toBe(EXIT.ok);
    expect(writes()).toHaveLength(0);
    expect(r.stdout).toContain('Sincronicé 4 issues: 4 nuevas · 0 actualizadas · 0 sin cambios');
    expect(r.stdout).toContain('simulación');
  });

  it('--json devuelve el reporte', async () => {
    realistic();
    const r = await sync(['--json']);
    const rep = JSON.parse(r.stdout);
    expect(rep).toMatchObject({ repo: 'cofoundy/dagyard', project: 'dagyard', issues: 4, dryRun: false });
    expect(rep.created).toEqual(['gh-44', 'gh-45', 'gh-46', 'gh-47']);
    expect(rep.updated).toEqual([]);
  });
});

describe('sync: errores de uso', () => {
  it('sin --github o con un repo mal escrito → 64 sin llamar', async () => {
    let out = '';
    const code = await run(['sync'], {
      stdout: () => {},
      stderr: (s) => (out += s),
      env: { LANG: 'es_PE.UTF-8', DAGYARD_URL: URL_BASE, DAGYARD_KEY: KEY, DAGYARD_PROJECT: 'dagyard' },
      cwd: mkdtempSync(join(tmpdir(), 'w-')),
      fetch: fakeFetch,
      github: fakeSource,
    });
    expect(code).toBe(EXIT.usage);
    expect(out).toContain('--github');
    expect((await sync(['--github', 'solo-un-nombre'])).code).toBe(EXIT.usage);
    for (const bad of ['cofoundy/..', '../dagyard', 'cofoundy/a..b', './x']) {
      expect((await sync(['--github', bad])).code).toBe(EXIT.usage);
    }
    expect(calls).toHaveLength(0);
  });

  it('proyecto inexistente → exit 1 con el mensaje del servidor', async () => {
    projectExists = false;
    const r = await sync();
    expect(r.code).toBe(EXIT.api);
    expect(r.stderr).toContain('no existe');
  });

  it('sync --help', async () => {
    const r = await sync(['--help']);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toMatch(/^Uso: dagyard sync/);
  });
});

/* ------------------------------------------------------------ piezas puras */

describe('cleanTitle', () => {
  it.each([
    ['cli: el resumen del import', 'El resumen del import'],
    ['feat(model): el nodo gana un link', 'El nodo gana un link'],
    ['Pantalla de pagos', 'Pantalla de pagos'],
    ['épica: ñandú', 'Ñandú'],
    ['¿Dónde corre?', '¿Dónde corre?'],
    ['x:', 'X:'],
  ])('%s → %s', (raw, want) => expect(cleanTitle(raw)).toBe(want));

  it('recorta a 120', () => expect([...cleanTitle('a'.repeat(300))].length).toBeLessThanOrEqual(120));
});

describe('parseOptions', () => {
  it('lee los tres formatos, máximo 6, recortadas a 120', () => {
    const body = ['- **A (rápida):** uno', '- **B:** dos', '- C) tres', '* **D**: cuatro', '- E) cinco', '- F) seis', '- G) siete'].join('\n');
    expect(parseOptions(body)).toEqual(['A (rápida): uno', 'B: dos', 'C: tres', 'D: cuatro', 'E: cinco', 'F: seis']);
    expect([...parseOptions(`- A) ${'x'.repeat(400)}`)[0]!].length).toBeLessThanOrEqual(120);
  });

  it('nada parseable → []', () => expect(parseOptions('- una nota\n- otra')).toEqual([]));

  it('el formato real de los issues founder-input (#25)', () => {
    const body = [
      '**Opciones:**',
      '- **A (default):** sigue privado una semana de uso real y se abre después.',
      '- **B:** abrirlo ya. Antes hay que revisar que no haya datos internos en `docs/qa/` ni en la demo.',
      '',
      '**Si no contestas:** queda A.',
    ].join('\n');
    expect(parseOptions(body)).toEqual([
      'A (default): sigue privado una semana de uso real y se abre después.',
      'B: abrirlo ya. Antes hay que revisar que no haya datos internos en docs/qa/ ni en la demo.',
    ]);
  });
});

describe('referencias', () => {
  it('closingRefs: closes|fixes|resolves|cierra|resuelve #n sin distinguir mayúsculas', () => {
    expect(closingRefs('Closes #1, fixes #2. RESUELVE #3 y cierra #4; resolves #5; ver #6')).toEqual([1, 2, 3, 4, 5]);
  });

  it('dependencyRefs separa «parte de» de «depende de»', () => {
    expect(dependencyRefs('Parte de #44. Depende de #3 y #4, blocked by #5; bloqueado por #6')).toEqual({
      partOf: [44],
      dependsOn: [3, 4, 5, 6],
      bornFrom: [],
    });
  });

  it('dependencyRefs (#90): «sale de la revisión de», «nace de» y «born from» son «nació de», no dependencias', () => {
    expect(dependencyRefs('Sale de la revisión de #75. Nace de #61 y #62; born from #9. Sale de la revision de #8')).toEqual({
      partOf: [],
      dependsOn: [],
      bornFrom: [75, 61, 62, 9, 8],
    });
  });
});

describe('sync: «nació de» (#90)', () => {
  it('crea la arista «nació de» desde gh-n (no un «necesita»), sin repetirla al volver a sincronizar', async () => {
    ghIssues = [issue(75, 'Tiempo'), issue(80, 'Ajustes', { body: 'Sale de la revisión de #75. Parte de #90.' }), issue(90, 'Épica')];
    let r = await sync();
    expect(r.code).toBe(EXIT.ok);
    expect(origins.map((o) => [o.from, o.to])).toEqual([['gh-75', 'gh-80']]);
    expect(edges.map((e) => [e.from, e.to])).toEqual([['gh-80', 'gh-90']]);
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/edges')).map((c) => c.body)).toContainEqual({ from: 'gh-75', to: 'gh-80', kind: 'origin' });
    calls = [];
    r = await sync();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('en --dry-run no escribe y avisa si cerraría un ciclo', async () => {
    nodes.set('gh-1', node('gh-1', { link: ghUrl(1) }));
    nodes.set('gh-2', node('gh-2', { link: ghUrl(2) }));
    origins.push({ projectId: 'dagyard', from: 'gh-2', to: 'gh-1' });
    ghIssues = [issue(1, 'Uno'), issue(2, 'Dos', { body: 'Nace de #1' })];
    const r = await sync(['--dry-run']);
    expect(r.code).toBe(EXIT.ok);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(r.stdout).toMatch(/cerraría un ciclo/);
  });
});

describe('ghCliSource (gh api, sin red)', () => {
  it('pagina con gh api --paginate, pide todos los estados y marca los PRs', async () => {
    const seenArgs: string[][] = [];
    const lines = [
      { number: 1, title: 'Uno', body: null, state: 'open', state_reason: null, html_url: 'https://github.com/o/r/issues/1', labels: ['founder-input'], pull_request: false },
      { number: 2, title: 'PR', body: 'b', state: 'open', state_reason: null, html_url: 'https://github.com/o/r/pull/2', labels: [], pull_request: true },
    ];
    const src = ghCliSource(async (file, args) => {
      seenArgs.push([file, ...args]);
      return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
    });
    const got = await src.issues('o/r', { label: 'agent ready' });
    expect(seenArgs[0]!.slice(0, 4)).toEqual(['gh', 'api', '--paginate', 'repos/o/r/issues?state=all&per_page=100&labels=agent%20ready']);
    expect(seenArgs[0]).toContain('--jq');
    expect(got).toEqual([
      { number: 1, title: 'Uno', body: '', state: 'open', stateReason: null, url: 'https://github.com/o/r/issues/1', labels: ['founder-input'], isPull: false },
      { number: 2, title: 'PR', body: 'b', state: 'open', stateReason: null, url: 'https://github.com/o/r/pull/2', labels: [], isPull: true },
    ]);
  });

  it('openPulls pide los PRs abiertos', async () => {
    const seenArgs: string[][] = [];
    const src = ghCliSource(async (_file, args) => {
      seenArgs.push(args);
      return `${JSON.stringify({ number: 3, title: 't', body: null })}\n`;
    });
    expect(await src.openPulls('o/r')).toEqual([{ number: 3, title: 't', body: '' }]);
    expect(seenArgs[0]).toContain('repos/o/r/pulls?state=open&per_page=100');
  });
});
