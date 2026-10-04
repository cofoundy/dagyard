/**
 * Equipos de la fábrica en el CLI (#75): `team start|close`, `start --site` / `$COFOUNDY_AGENT` e `import-ledger`
 * contra un servidor de mentira que hace el upsert de equipos como el Worker (sin cambios, sin evento).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { teamNameFromSlug, type DagNode, type Team } from '@dagyard/model';
import { repoOf, run } from '../src/cli.js';
import { parseLedger, teamPatchFromLedger, teamsFromLedger, type LedgerRow } from '../src/ledger.js';

const KEY = 'clave-ledger';
const FIXTURE = join(__dirname, 'fixtures', 'ledger', 'sites.json');

let server: Server;
let baseUrl = '';
let teams = new Map<string, Team>();
let nodes: DagNode[] = [];
/** cada escritura que llegó, y cuántas cambiaron algo (las que en el Worker emiten un evento) */
let writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
let events = 0;
/** se corre justo después de servir un snapshot: otro escritor que se cuela entre la lectura y la escritura */
let afterGet: (() => void) | null = null;
/** equipos que el servidor rechaza con 400 */
let rejected = new Set<string>();

function reply(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  if (req.headers.authorization !== `Bearer ${KEY}`) return reply(res, 401, { error: { code: 'unauthorized', message: 'no' } });
  const parts = new URL(req.url ?? '/', 'http://x').pathname.split('/').filter(Boolean);
  const [, , pid, kind, id] = parts;
  if (req.method === 'GET' && parts.length === 3) {
    reply(res, 200, { project: { id: pid }, nodes, edges: [], blockers: [], messages: [], teams: [...teams.values()], seq: events });
    afterGet?.();
    return;
  }
  writes.push({ method: req.method ?? '', path: parts.join('/'), body });
  if (req.method === 'PUT' && kind === 'teams') {
    if (rejected.has(id!)) return reply(res, 400, { error: { code: 'invalid', message: `startedAt: el equipo ${id} no pasa` } });
    const prev = teams.get(id!);
    const added = ((body.nodeIds as string[]) ?? prev?.nodeIds ?? []).slice();
    for (const n of (body.addNodeIds as string[]) ?? []) if (!added.includes(n)) added.push(n);
    const next: Team = {
      id: id!,
      projectId: pid!,
      name: (body.name as string) ?? prev?.name ?? teamNameFromSlug(id!),
      nodeIds: added,
      requestedAt: 'requestedAt' in body ? (body.requestedAt as string | null) : (prev?.requestedAt ?? null),
      startedAt: 'startedAt' in body ? (body.startedAt as string | null) : (prev?.startedAt ?? null),
      closedAt: 'closedAt' in body ? (body.closedAt as string | null) : (prev?.closedAt ?? null),
      outcome: 'outcome' in body ? (body.outcome as string | null) : (prev?.outcome ?? null),
      updatedAt: 'ahora',
    };
    const same = prev && JSON.stringify({ ...prev, updatedAt: 0 }) === JSON.stringify({ ...next, updatedAt: 0 });
    if (!same) {
      teams.set(id!, next);
      events++;
    }
    return reply(res, 200, same ? prev : next);
  }
  if (req.method === 'PATCH' && kind === 'nodes') return reply(res, 200, { id });
  return reply(res, 404, { error: { code: 'not_found', message: 'esa ruta no existe' } });
}

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  teams = new Map();
  nodes = [];
  writes = [];
  events = 0;
  afterGet = null;
  rejected = new Set();
});

async function cli(argv: string[], env: Record<string, string> = {}, cwd = mkdtempSync(join(tmpdir(), 'dagyard-cwd-'))) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    cwd,
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: { LANG: 'es_PE.UTF-8', DAGYARD_URL: baseUrl, DAGYARD_KEY: KEY, DAGYARD_PROJECT: 'dagyard', DAGYARD_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dagyard-cfg-')), ...env },
    sleep: async () => {},
  });
  return { code, stdout, stderr };
}

const fixtureRows = (): LedgerRow[] => parseLedger(readFileSync(FIXTURE, 'utf8')).rows;

/* ------------------------------------------------------------------ el ledger, puro */

describe('ledger → equipos (puro)', () => {
  it('la copia de sites.json: 24 equipos por llegada, fechas normalizadas, issues como gh-<n>', () => {
    const { teams: ts, skipped } = teamsFromLedger(fixtureRows(), null);
    expect(skipped).toBe(0);
    expect(ts).toHaveLength(24);
    expect(ts.map((t) => t.id).slice(0, 5)).toEqual(['nucleo', 'cielo', 'cli', 'entrega', 'endurecer']);
    expect(ts[0]).toEqual({
      id: 'nucleo',
      nodeIds: ['gh-2'],
      requestedAt: '2026-10-04T05:35:20.000Z',
      startedAt: '2026-10-04T05:36:46.000Z',
      closedAt: '2026-10-04T06:38:36.000Z',
      outcome: 'merged',
    });
    expect(ts.find((t) => t.id === 'abierto')).toMatchObject({ outcome: 'pr-open-25', nodeIds: ['gh-25'] });
    expect(ts.at(-1)).toMatchObject({ id: 'tiempo', closedAt: null, outcome: null, nodeIds: ['gh-75'] });
  });

  it('JSONL con repo: solo las filas del repo; sin repo en la fila no cuenta; reabrir limpia el cierre', () => {
    const jsonl = [
      { site: 'a', event: 'requested', ts: '2026-10-04T01:00:00Z', repo: 'dagyard', issues: ['1', '#2', 'x'] },
      { site: 'b', event: 'requested', ts: '2026-10-04T01:00:00Z', repo: 'otro', issues: ['9'] },
      { site: 'c', event: 'requested', ts: '2026-10-04T01:00:00Z', issues: ['9'] },
      { site: 'a', event: 'started', ts: '2026-10-04T01:01:00Z', repo: 'dagyard' },
      { site: 'a', event: 'bitacora_reserved', ts: '2026-10-04T01:02:00Z', repo: 'dagyard' },
      { site: 'a', event: 'closed', ts: '2026-10-04T02:00:00Z', repo: 'dagyard', outcome: 'stopped' },
      { site: 'a', event: 'requested', ts: '2026-10-04T03:00:00Z', repo: 'dagyard', issues: ['3'] },
      { site: 'a', event: 'started', ts: '2026-10-04T03:01:00Z', repo: 'dagyard' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n');
    const { rows, invalid } = parseLedger(`${jsonl}\nesto no es json\n`);
    expect(invalid).toBe(1);
    const { teams: ts, skipped } = teamsFromLedger(rows, 'dagyard');
    expect(skipped).toBe(2);
    expect(ts).toEqual([
      { id: 'a', nodeIds: ['gh-1', 'gh-2', 'gh-3'], requestedAt: '2026-10-04T01:00:00.000Z', startedAt: '2026-10-04T01:01:00.000Z', closedAt: null, outcome: null },
    ]);
  });

  it('teamPatchFromLedger: null si ya está; el ledger manda en lo que sabe y no borra lo que no sabe', () => {
    const [l] = teamsFromLedger(fixtureRows(), null).teams;
    const current: Team = { ...l!, projectId: 'dagyard', name: 'Núcleo', updatedAt: 'x' };
    expect(teamPatchFromLedger(l!, current)).toBeNull();
    expect(teamPatchFromLedger(l!, { ...current, startedAt: '2026-10-04T05:40:00.000Z', nodeIds: ['gh-2', 'gh-9'] })).toEqual({ startedAt: l!.startedAt });
    expect(teamPatchFromLedger({ ...l!, closedAt: null, outcome: null }, current)).toBeNull();
    expect(teamPatchFromLedger({ ...l!, nodeIds: ['gh-2', 'gh-7'] }, current)).toEqual({ addNodeIds: ['gh-7'] });
  });
});

/* ------------------------------------------------------------------ dagyard import-ledger */

describe('dagyard import-ledger', () => {
  it('dos veces sobre la copia de sites.json: la segunda no manda nada (0 eventos)', async () => {
    nodes = [{ id: 'gh-2', team: 'Núcleo' } as DagNode, { id: 'gh-45', team: 'Fábrica' } as DagNode];
    const first = await cli(['import-ledger', FIXTURE]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain('24 equipos en el ledger → dagyard: 24 nuevos, 0 actualizados, 0 sin cambios');
    expect(events).toBe(24);
    // el nombre sale del team de sus tareas; «Fábrica» no cuenta y entonces lo pone el servidor
    expect(teams.get('nucleo')!.name).toBe('Núcleo');
    expect(teams.get('dogfood')!.name).toBe('Dogfood');
    expect(writes[0]).toMatchObject({ method: 'PUT', path: 'api/projects/dagyard/teams/nucleo', body: { name: 'Núcleo', addNodeIds: ['gh-2'], startedAt: '2026-10-04T05:36:46.000Z' } });
    expect(writes.find((w) => w.path.endsWith('/tiempo'))!.body).not.toHaveProperty('closedAt');

    writes = [];
    const second = await cli(['import-ledger', FIXTURE, '--json']);
    expect(second.code, second.stderr).toBe(0);
    expect(writes).toEqual([]);
    expect(events).toBe(24);
    const report = JSON.parse(second.stdout);
    expect(report.teams.every((t: { action: string }) => t.action === 'unchanged')).toBe(true);
  });

  it('--dry-run no escribe; un cambio en el ledger se manda solo', async () => {
    const dry = await cli(['import-ledger', FIXTURE, '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/^\(simulación, no envié nada\) 24 equipos/);
    expect(writes).toEqual([]);

    await cli(['import-ledger', FIXTURE]);
    const rows = JSON.parse(readFileSync(FIXTURE, 'utf8')) as LedgerRow[];
    rows.push({ site: 'tiempo', event: 'closed', ts: '2026-10-05T01:00:00Z', outcome: 'merged' });
    const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'sites.json');
    writeFileSync(file, JSON.stringify(rows));
    writes = [];
    const r = await cli(['import-ledger', file]);
    expect(r.stdout).toContain('0 nuevos, 1 actualizados, 23 sin cambios');
    expect(writes).toEqual([{ method: 'PUT', path: 'api/projects/dagyard/teams/tiempo', body: { closedAt: '2026-10-05T01:00:00.000Z', outcome: 'merged' } }]);
  });

  it('un ledger con repo: --repo filtra; sin --repo usa el remoto origin del cwd', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'sites.jsonl');
    writeFileSync(
      file,
      [
        { site: 'tiempo', event: 'started', ts: '2026-10-04T19:07:42Z', repo: 'dagyard' },
        { site: 'wsp', event: 'started', ts: '2026-10-04T19:07:42Z', repo: 'pets-marketplace' },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    await cli(['import-ledger', file, '--repo', 'pets-marketplace']);
    expect([...teams.keys()]).toEqual(['wsp']);

    const repo = mkdtempSync(join(tmpdir(), 'repo-'));
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:cofoundy/dagyard.git']);
    expect(repoOf(repo)).toBe('dagyard');
    const r = await cli(['import-ledger', file], {}, repo);
    expect(r.code, r.stderr).toBe(0);
    expect([...teams.keys()]).toEqual(['wsp', 'tiempo']);

    const nowhere = await cli(['import-ledger', file], {}, mkdtempSync(join(tmpdir(), 'sin-git-')));
    expect(nowhere.code).toBe(64);
    expect(nowhere.stderr).toContain('falta --repo');
  });

  it('un ledger que no existe es un error de uso', async () => {
    const r = await cli(['import-ledger', '/no/existe.jsonl']);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain('no pude leer el ledger');
  });
});

/* ------------------------------------------------------------------ team start | close, start --site */

describe('dagyard team start | close', () => {
  it('start: nombre, issues y la hora; arrancarlo otra vez conserva la primera', async () => {
    const r = await cli(['team', 'start', 'tiempo', '--name', 'Tiempo', '--issues', '75,#80', '--issues', 'gh-75', '--at', '2026-10-04T14:07:42-05:00']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe('tiempo\n');
    expect(writes.at(-1)).toEqual({
      method: 'PUT',
      path: 'api/projects/dagyard/teams/tiempo',
      body: { name: 'Tiempo', addNodeIds: ['gh-75', 'gh-80'], startedAt: '2026-10-04T19:07:42.000Z' },
    });
    await cli(['team', 'start', 'tiempo', '--issues', '81']);
    expect(writes.at(-1)!.body).toEqual({ addNodeIds: ['gh-81'] });
    expect(teams.get('tiempo')!.startedAt).toBe('2026-10-04T19:07:42.000Z');
  });

  it('close: desenlace y hora; cerrarlo igual no cambia nada; arrancarlo de nuevo lo reabre', async () => {
    await cli(['team', 'start', 'tiempo']);
    const startedAt = teams.get('tiempo')!.startedAt;
    expect(startedAt).toEqual(expect.any(String));
    const c = await cli(['team', 'close', 'tiempo', '--outcome', 'merged']);
    expect(c.code, c.stderr).toBe(0);
    const closed = teams.get('tiempo')!;
    expect(closed).toMatchObject({ outcome: 'merged', closedAt: expect.any(String) });
    const before = events;
    await cli(['team', 'close', 'tiempo', '--outcome', 'merged']);
    expect(events).toBe(before);
    await cli(['team', 'start', 'tiempo']);
    expect(teams.get('tiempo')).toMatchObject({ startedAt, closedAt: null, outcome: null });
  });

  it('errores de uso: sin sitio, sin --outcome, fecha o issue inválidos', async () => {
    for (const argv of [['team', 'start'], ['team', 'close', 'x'], ['team', 'start', 'x', '--at', 'ayer'], ['team', 'start', 'x', '--issues', 'abc'], ['team', 'stop', 'x']]) {
      const r = await cli(argv);
      expect(r.code, argv.join(' ')).toBe(64);
    }
    expect(writes).toEqual([]);
  });

  it('dagyard team sin subcomando muestra la ayuda del grupo', async () => {
    const r = await cli(['team']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('dagyard team start <sitio>');
    expect(r.stdout).toContain('dagyard team close <sitio>');
  });
});

describe('dagyard start manda el sitio como teamId', () => {
  it('con $COFOUNDY_AGENT, --site manda sobre él; sin ninguno no manda teamId', async () => {
    await cli(['start', 'gh-75'], { COFOUNDY_AGENT: 'tiempo' });
    expect(writes.at(-1)).toEqual({ method: 'PATCH', path: 'api/projects/dagyard/nodes/gh-75', body: { status: 'working', teamId: 'tiempo' } });
    await cli(['node', 'start', 'gh-75', '--site', 'Demo Viva', '--team', 'Demo'], { COFOUNDY_AGENT: 'tiempo' });
    expect(writes.at(-1)!.body).toEqual({ status: 'working', team: 'Demo', teamId: 'demo-viva' });
    await cli(['start', 'gh-75']);
    expect(writes.at(-1)!.body).toEqual({ status: 'working' });
  });
});

/* ------------------------------------------------------------------ revisión adversarial */

describe('revisión adversarial (#75)', () => {
  it('team start --issues manda addNodeIds: otro escritor entre la lectura y la escritura no se pierde', async () => {
    await cli(['team', 'start', 'tiempo', '--issues', '75']);
    afterGet = () => {
      const t = teams.get('tiempo')!;
      teams.set('tiempo', { ...t, nodeIds: [...t.nodeIds, 'gh-99'] });
      afterGet = null;
    };
    const r = await cli(['team', 'start', 'tiempo', '--issues', '81']);
    expect(r.code, r.stderr).toBe(0);
    expect(writes.at(-1)!.body).toEqual({ addNodeIds: ['gh-81'] });
    expect(teams.get('tiempo')!.nodeIds).toEqual(['gh-75', 'gh-99', 'gh-81']);
  });

  it('import-ledger suma con addNodeIds, nunca la lista leída antes', async () => {
    await cli(['import-ledger', FIXTURE]);
    expect(writes.every((w) => !('nodeIds' in w.body))).toBe(true);
    const rows = JSON.parse(readFileSync(FIXTURE, 'utf8')) as LedgerRow[];
    rows.push({ site: 'tiempo', event: 'requested', ts: '2026-10-04T20:00:00Z', issues: ['76'] });
    const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'sites.json');
    writeFileSync(file, JSON.stringify(rows));
    afterGet = () => {
      const t = teams.get('tiempo')!;
      teams.set('tiempo', { ...t, nodeIds: [...t.nodeIds, 'gh-99'] });
      afterGet = null;
    };
    writes = [];
    await cli(['import-ledger', file]);
    expect(writes).toEqual([{ method: 'PUT', path: 'api/projects/dagyard/teams/tiempo', body: { addNodeIds: ['gh-76'] } }]);
    expect(teams.get('tiempo')!.nodeIds).toEqual(['gh-75', 'gh-99', 'gh-76']);
  });

  it('un ledger hostil: issues que no son lista de strings o números, o ids de más de 64 → filas ilegibles, y sigue', () => {
    const rows = [
      { site: 'a', event: 'requested', ts: '2026-10-04T01:00:00Z', issues: '75' },
      { site: 'b', event: 'requested', ts: '2026-10-04T01:00:00Z', issues: [{ n: 1 }] },
      { site: 'c', event: 'requested', ts: '2026-10-04T01:00:00Z', issues: ['9'.repeat(70)] },
      { site: 'x'.repeat(65), event: 'started', ts: '2026-10-04T01:00:00Z' },
      { site: 'd', event: 'requested', ts: '2026-10-04T01:00:00Z', issues: [7, '8'] },
    ];
    const { rows: ok, invalid } = parseLedger(rows.map((r) => JSON.stringify(r)).join('\n'));
    expect(invalid).toBe(4);
    expect(teamsFromLedger(ok, null).teams).toEqual([
      { id: 'd', nodeIds: ['gh-7', 'gh-8'], requestedAt: '2026-10-04T01:00:00.000Z', startedAt: null, closedAt: null, outcome: null },
    ]);
  });

  it('un 400 de un equipo no corta el import: los demás se mandan y el error se reporta', async () => {
    rejected = new Set(['cielo', 'demo']);
    const r = await cli(['import-ledger', FIXTURE]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('cielo');
    expect(r.stderr).toContain('demo');
    expect(teams.size).toBe(22);
    expect(r.stdout).toContain('22 nuevos');
    rejected = new Set();
    writes = [];
    const again = await cli(['import-ledger', FIXTURE]);
    expect(again.code).toBe(0);
    expect(writes.map((w) => w.path.split('/').pop()).sort()).toEqual(['cielo', 'demo']);
  });
});
