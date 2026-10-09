import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Blocker, DagEvent } from '@dagyard/model';
import { EXIT, run } from '../src/cli.js';
import { WATCH_GIVE_UP } from '../src/watch.js';

const KEY = 'clave-secreta-123';
const AT = '2026-10-09T19:06:00.000Z';

function blocker(id: string, nodeId: string, over: Partial<Blocker> = {}): Blocker {
  return {
    id,
    projectId: 'demo',
    nodeId,
    kind: 'review',
    question: '¿Te sirve así?',
    options: ['Aprobar', 'Pedir cambios'],
    accessLabel: null,
    status: 'open',
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: AT,
    ...over,
  };
}

const answered = (b: Blocker, choice: string | null, note: string | null = null): Blocker => ({
  ...b,
  status: 'resolved',
  resolution: { choice, note, hasValue: false },
  resolvedBy: 'owner',
  resolvedAt: AT,
});

function ev(seq: number, type: DagEvent['type'], payload: unknown): DagEvent {
  return { seq, projectId: 'demo', type, actor: 'agent', at: AT, payload } as DagEvent;
}

type Reply = { status: number; body?: unknown } | 'network';

/**
 * Un servidor falso: `events` es el log entero (el endpoint devuelve los de `seq > since`), `floor` el seq bajo el
 * cual pide `resync`, `script` respuestas forzadas en orden para las llamadas a `/events`.
 */
function fake(opts: { events?: DagEvent[]; blockers?: Blocker[]; seq?: number; floor?: number; script?: Reply[] }) {
  const calls: string[] = [];
  const script = [...(opts.script ?? [])];
  const fetch = async (url: string): Promise<Response> => {
    const u = new URL(url);
    calls.push(`${u.pathname}${u.search}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/events')) {
      const forced = script.shift();
      if (forced === 'network') throw new TypeError('fetch failed');
      if (forced) return json(forced.status, forced.body ?? { error: { code: `http_${forced.status}`, message: 'caído' } });
      const since = Number(u.searchParams.get('since'));
      if (since < (opts.floor ?? 0)) return json(200, { events: [], resync: true });
      return json(200, { events: (opts.events ?? []).filter((e) => e.seq > since) });
    }
    const all = opts.events ?? [];
    return json(200, {
      project: { id: 'demo' },
      nodes: [],
      edges: [],
      blockers: opts.blockers ?? [],
      messages: [],
      seq: opts.seq ?? (all.length ? all[all.length - 1]!.seq : 0),
    });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

async function cli(argv: string[], f: ReturnType<typeof fake>, lang = 'es_PE.UTF-8') {
  let stdout = '';
  let stderr = '';
  const slept: number[] = [];
  const code = await run(argv, {
    cwd: mkdtempSync(join(tmpdir(), 'dagyard-cwd-')),
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: { LANG: lang, DAGYARD_URL: 'https://dagyard.example', DAGYARD_KEY: KEY, DAGYARD_PROJECT: 'demo', DAGYARD_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dagyard-cfg-')) },
    fetch: f.fetch,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  return { code, stdout, stderr, slept, lines: stdout.split('\n').filter(Boolean) };
}

const b1 = blocker('b_1', 'gh-121');
const b2 = blocker('b_2', 'gh-7', { kind: 'decision', question: '¿Cuál?', options: ['A', 'B'] });
const log: DagEvent[] = [
  ev(1, 'node.updated', { node: { id: 'gh-121' } }),
  ev(2, 'blocker.opened', { blocker: b1 }),
  ev(3, 'message.posted', { message: { id: 'm_1' } }),
  ev(4, 'blocker.resolved', { blocker: answered(b1, 'Aprobar', 'Así\nestá bien') }),
  ev(5, 'blocker.opened', { blocker: b2 }),
];

describe('dagyard watch (#121)', () => {
  it('con --since repite solo los bloqueantes abiertos y respondidos, una línea cada uno', async () => {
    const r = await cli(['watch', '--since', '0', '--once'], fake({ events: log }));
    expect(r.code).toBe(EXIT.ok);
    expect(r.lines).toEqual([
      '#2 gh-121 pregunta (review): «¿Te sirve así?» [Aprobar | Pedir cambios] · b_1',
      '#4 gh-121 respondieron «¿Te sirve así?»: Aprobar — nota: Así está bien · b_1',
      '#5 gh-7 pregunta (decision): «¿Cuál?» [A | B] · b_2',
    ]);
    expect(r.stderr).toContain('escuchando «demo» después del evento #0');
  });

  it('--json trae nodo, opción, nota y quién; --since 3 empieza después del 3', async () => {
    const r = await cli(['watch', '--since', '3', '--once', '--json'], fake({ events: log }));
    const lines = r.lines.map((l) => JSON.parse(l));
    expect(lines.map((l) => l.seq)).toEqual([4, 5]);
    expect(lines[0]).toMatchObject({ type: 'blocker.resolved', node: 'gh-121', blocker: 'b_1', choice: 'Aprobar', note: 'Así\nestá bien', by: 'owner' });
    expect(lines[1]).toMatchObject({ type: 'blocker.opened', node: 'gh-7', kind: 'decision', options: ['A', 'B'] });
    expect(lines[1]).not.toHaveProperty('choice');
  });

  it('sin --since empieza ahora: lista lo que ya espera y sigue desde el seq del snapshot', async () => {
    const f = fake({ events: log, blockers: [b2, answered(b1, 'Aprobar')], seq: 5 });
    const r = await cli(['watch', '--once'], f);
    expect(r.lines).toEqual(['#5 gh-7 sigue esperando (decision): «¿Cuál?» [A | B] · b_2']);
    expect(f.calls).toEqual(['/api/projects/demo', '/api/projects/demo/events?since=5']);
  });

  it('en inglés con LANG=en', async () => {
    const r = await cli(['watch', '--since', '3', '--once'], fake({ events: log }), 'en_US.UTF-8');
    expect(r.lines[0]).toBe('#4 gh-121 answered «¿Te sirve así?»: Aprobar — note: Así está bien · b_1');
    expect(r.lines[1]).toBe('#5 gh-7 asks (decision): «¿Cuál?» [A | B] · b_2');
  });

  it('un acceso respondido nunca trae el valor: dice cómo leerlo', async () => {
    const acc = blocker('b_9', 'gh-3', { kind: 'access', question: 'La clave', options: [], accessLabel: 'Clave' });
    const done = { ...acc, status: 'resolved' as const, resolution: { choice: null, note: null, hasValue: true }, resolvedBy: 'owner' as const, resolvedAt: AT };
    const r = await cli(['watch', '--since', '0', '--once'], fake({ events: [ev(1, 'blocker.resolved', { blocker: done })] }));
    expect(r.lines).toEqual(['#1 gh-3 respondieron «La clave»: acceso guardado (léelo con «dagyard wait gh-3 --blocker b_9») · b_9']);
  });

  it('--cursor guarda el último evento visto y, sin --since, reanuda desde ahí', async () => {
    const cursor = join(mkdtempSync(join(tmpdir(), 'dagyard-cur-')), 'sub', 'demo.cursor');
    const first = await cli(['watch', '--cursor', cursor, '--once'], fake({ events: log.slice(0, 3), seq: 3 }));
    expect(first.lines).toEqual([]);
    expect(readFileSync(cursor, 'utf8')).toBe('3\n');
    // muere el watch; André responde y se abre otra pregunta; el watch nuevo reanuda desde el cursor
    const f = fake({ events: log });
    const again = await cli(['watch', '--cursor', cursor, '--once'], f);
    expect(again.lines.map((l) => l.split(' ')[0])).toEqual(['#4', '#5']);
    expect(f.calls[0]).toBe('/api/projects/demo/events?since=3');
    expect(readFileSync(cursor, 'utf8')).toBe('5\n');
    // --since gana sobre el cursor
    const f2 = fake({ events: log });
    await cli(['watch', '--cursor', cursor, '--since', '1', '--once'], f2);
    expect(f2.calls[0]).toBe('/api/projects/demo/events?since=1');
  });

  it('un cursor que no es un número es un error de uso, no un watch desde cero', async () => {
    const cursor = join(mkdtempSync(join(tmpdir(), 'dagyard-cur-')), 'demo.cursor');
    writeFileSync(cursor, 'basura');
    const r = await cli(['watch', '--cursor', cursor, '--once'], fake({ events: log }));
    expect(r.code).toBe(EXIT.usage);
  });

  it('resync: avisa y sigue desde el snapshot, con lo que sigue abierto', async () => {
    const f = fake({ events: log, blockers: [b2], seq: 5, floor: 4 });
    const r = await cli(['watch', '--since', '2', '--once'], f);
    expect(r.lines).toEqual([
      '#5 resync: el servidor ya no tiene los eventos después de #2; sigo desde el estado actual',
      '#5 gh-7 sigue esperando (decision): «¿Cuál?» [A | B] · b_2',
    ]);
    expect(f.calls).toEqual(['/api/projects/demo/events?since=2', '/api/projects/demo', '/api/projects/demo/events?since=5']);
    const j = await cli(['watch', '--since', '2', '--once', '--json'], fake({ events: log, blockers: [b2], seq: 5, floor: 4 }));
    expect(JSON.parse(j.lines[0]!)).toEqual({ type: 'resync', seq: 5, since: 2 });
    expect(JSON.parse(j.lines[1]!)).toMatchObject({ type: 'blocker.opened', blocker: 'b_2', snapshot: true });
  });

  it('una página llena se sigue sin esperar', async () => {
    const many = Array.from({ length: 501 }, (_, i) => ev(i + 1, 'message.posted', { message: { id: `m_${i}` } }));
    many.push(ev(502, 'blocker.opened', { blocker: b1 }));
    const page = (since: number) => many.filter((e) => e.seq > since).slice(0, 500);
    const calls: string[] = [];
    const fetch = (async (url: string) => {
      const u = new URL(url);
      calls.push(u.search);
      return new Response(JSON.stringify({ events: page(Number(u.searchParams.get('since'))) }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const r = await cli(['watch', '--since', '0', '--once'], { fetch, calls });
    expect(calls).toEqual(['?since=0', '?since=500']);
    expect(r.lines).toEqual(['#502 gh-121 pregunta (review): «¿Te sirve así?» [Aprobar | Pedir cambios] · b_1']);
    expect(r.slept).toEqual([]);
  });

  it('una caída suelta se reintenta y no se pierde nada', async () => {
    const f = fake({ events: log, script: ['network', 'network', { status: 503 }] });
    const r = await cli(['watch', '--since', '3', '--once'], f);
    expect(r.code).toBe(EXIT.ok);
    expect(r.lines).toHaveLength(2);
    expect(r.stderr).toContain('el servidor no responde');
    expect(r.stderr).toContain('volvió a responder');
  });

  it('si el servidor no responde, sale 4 y dice cómo reanudar (no muere en silencio)', async () => {
    const f = fake({ events: log, script: Array.from({ length: 100 }, () => 'network' as const) });
    const r = await cli(['watch', '--since', '3'], f);
    expect(r.code).toBe(EXIT.unreachable);
    expect(r.stderr).toContain(`no respondió ${WATCH_GIVE_UP} veces seguidas`);
    expect(r.stderr).toContain('«dagyard watch --since 3»');
    expect(r.stdout).toBe('');
  });

  it('un 4xx (la key, el proyecto) no se reintenta: exit 1', async () => {
    const f = fake({ events: log, script: [{ status: 401, body: { error: { code: 'unauthorized', message: 'no' } } }] });
    const r = await cli(['watch', '--since', '0'], f);
    expect(r.code).toBe(EXIT.api);
    expect(f.calls).toHaveLength(1);
    expect(r.stderr).not.toContain(KEY);
  });

  it('sin --once sigue escuchando: espera --interval entre vueltas y emite lo nuevo', async () => {
    // el log crece entre vueltas; la tercera vuelta corta con un 401 para terminar el test
    const events: DagEvent[] = [log[1]!];
    let n = 0;
    const fetch = (async (url: string) => {
      const u = new URL(url);
      n++;
      if (n === 2) events.push(log[3]!);
      if (n === 3) return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'fin' } }), { status: 401 });
      return new Response(JSON.stringify({ events: events.filter((e) => e.seq > Number(u.searchParams.get('since'))) }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const r = await cli(['watch', '--since', '0', '--interval', '2'], { fetch, calls: [] });
    expect(r.lines.map((l) => l.split(' ')[0])).toEqual(['#2', '#4']);
    expect(r.slept).toEqual([2000, 2000]);
  });

  it('uso: --since y --interval se validan', async () => {
    expect((await cli(['watch', '--since', '-1'], fake({}))).code).toBe(EXIT.usage);
    expect((await cli(['watch', '--interval', '0'], fake({}))).code).toBe(EXIT.usage);
    expect(existsSync('demo.cursor')).toBe(false);
  });
});
