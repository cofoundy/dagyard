import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toBlocker, toEvent, toResolveInput, toSnapshot, type WireBlocker, type WireEvent, type WireNode, type WireSnapshot } from './adapter';
import { HttpApi } from './http';
import { ApiError } from './session';
import { UnauthorizedError, type DagEvent } from './types';
import { setLang } from '../i18n';

// estos tests leen la interfaz en español; jsdom diría en-US (#73)
beforeEach(() => setLang('es'));

/* ------------------------------------------------------------------ dobles */

const T = '2026-10-04T06:00:00.000Z';
const wnode = (id: string, extra: Partial<WireNode> = {}): WireNode => ({
  id, projectId: 'p', stage: 'diseno', title: 'Modelo de comisiones', status: 'blocked', progress: 0,
  team: 'Diseño', goal: null, reportUrl: null, link: null, createdAt: T, updatedAt: T, ...extra,
});
const wblocker = (extra: Partial<WireBlocker> = {}): WireBlocker => ({
  id: 'b_1', projectId: 'p', nodeId: 'modelo-de-comisiones', kind: 'decision', question: '¿A quién le cobramos?',
  options: ['Al proveedor', 'Al cliente'], accessLabel: null, status: 'open', resolution: null, resolvedBy: null,
  resolvedAt: null, createdAt: T, ...extra,
});
const wsnap = (): WireSnapshot => ({
  project: { id: 'p', name: 'Marketplace de reservas', lang: 'es', stages: [{ id: 'diseno', name: 'Diseño' }], createdAt: T, updatedAt: T },
  nodes: [wnode('modelo-de-comisiones')],
  edges: [],
  blockers: [wblocker()],
  messages: [{ id: 'm_1', projectId: 'p', nodeId: 'modelo-de-comisiones', from: 'Equipo de Diseño', text: 'Hola', reportUrl: null, createdAt: T }],
  seq: 7,
});

type Call = { url: string; init: RequestInit };
function fakeFetch(routes: Record<string, (init: RequestInit) => Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${init.method ?? 'GET'} ${url}`;
    const h = routes[key];
    return h ? h(init) : new Response(JSON.stringify({ error: { code: 'not_found', message: 'No' } }), { status: 404 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

class FakeWS {
  static all: FakeWS[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeWS.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  open() {
    this.onopen?.();
  }
  frame(f: unknown) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  drop() {
    this.closed = true;
    this.onclose?.();
  }
}

const ev = (seq: number, type: WireEvent['type'], payload: unknown): WireEvent =>
  ({ seq, projectId: 'p', type, actor: 'agent', at: T, payload }) as WireEvent;

/* ------------------------------------------------------------------ adapter */

describe('adapter', () => {
  it('traduce el snapshot del servidor al modelo de la UI', () => {
    const s = toSnapshot(wsnap());
    expect(s.project).toEqual({ id: 'p', name: 'Marketplace de reservas' });
    expect(s.stages).toEqual([{ id: 'diseno', name: 'Diseño' }]);
    // sin #90 en el cable: nació cuando se creó y los orígenes quedan por deducir (undefined, no [])
    expect(s.nodes[0]).toEqual({ id: 'modelo-de-comisiones', stageId: 'diseno', title: 'Modelo de comisiones', status: 'blocked', progress: 0, team: 'Diseño', goal: undefined, reportUrl: undefined, bornAt: T });
    expect(s.origins).toBeUndefined();
    expect(s.messages[0]).toMatchObject({ at: T, reportUrl: undefined });
    expect(s.seq).toBe(7);
  });

  it('lee el modelo del DAG (#90) si el servidor lo manda: tipo, nacimiento, cita, cierre y «nació de»', () => {
    const w = wsnap();
    const born = '2026-10-04T05:24:00.000Z';
    Object.assign(w.nodes[0]!, { kind: 'request', bornAt: born, quote: 'quiero ver el grafo', quoteBy: 'André', closedAs: 'dropped', closedReason: 'ya no hace falta', replacedBy: null, closedAt: T });
    Object.assign(w, { origins: [{ projectId: 'p', from: 'meta', to: 'modelo-de-comisiones', why: 'la pidió André', createdAt: T }, { from: '', to: 'x' }] });
    const s = toSnapshot(w);
    expect(s.nodes[0]).toMatchObject({ kind: 'request', bornAt: born, quote: 'quiero ver el grafo', quoteBy: 'André', closedAs: 'dropped', closedReason: 'ya no hace falta', closedAt: T });
    expect(s.nodes[0]!.replacedBy).toBeUndefined();
    expect(s.origins).toEqual([{ from: 'meta', to: 'modelo-de-comisiones', why: 'la pidió André' }]);
    const added = toEvent({ seq: 8, type: 'origin.added', payload: { origin: { projectId: 'p', from: 'a', to: 'b', why: null, createdAt: T } } } as never);
    expect(added).toEqual({ seq: 8, type: 'origin.added', origin: { from: 'a', to: 'b' } });
    expect(toEvent({ seq: 9, type: 'origin.removed', payload: { origin: { projectId: 'p', from: 'a', to: 'b' } } } as never)).toEqual({ seq: 9, type: 'origin.removed', origin: { from: 'a', to: 'b' } });
    // ilegible: la UI recarga el snapshot
    expect(toEvent({ seq: 10, type: 'origin.added', payload: {} } as never)).toBeNull();
  });

  it('resume la resolución en humano y nunca expone el valor de un acceso', () => {
    const resolved = { status: 'resolved' as const, resolvedBy: 'owner' as const, resolvedAt: T };
    expect(toBlocker(wblocker({ ...resolved, resolution: { choice: 'Al cliente', note: null, hasValue: false } })).resolution).toBe('«Al cliente»');
    expect(toBlocker(wblocker({ ...resolved, kind: 'review', options: ['Aprobar', 'Pedir cambios'], resolution: { choice: 'Aprobar', note: null, hasValue: false } })).resolution).toBe('Aprobado');
    expect(toBlocker(wblocker({ ...resolved, kind: 'review', options: ['Aprobar', 'Pedir cambios'], resolution: { choice: 'Pedir cambios', note: 'Más grande', hasValue: false } })).resolution).toBe('Pediste cambios: Más grande');
    const acc = toBlocker(wblocker({ ...resolved, kind: 'access', options: [], accessLabel: 'Clave de la pasarela', resolution: { choice: null, note: null, hasValue: true } }));
    expect(acc).toMatchObject({ resolution: 'Acceso entregado', label: 'Clave de la pasarela', resolvedBy: 'you', options: [] });
    expect(toBlocker(wblocker()).resolvedAt).toBeUndefined();
  });

  it('traduce la respuesta del PM al cuerpo de resolve', () => {
    expect(toResolveInput({ kind: 'decision', option: 'Al cliente' })).toEqual({ choice: 'Al cliente' });
    expect(toResolveInput({ kind: 'review', verdict: 'approve' })).toEqual({ choice: 0, note: null });
    expect(toResolveInput({ kind: 'review', verdict: 'changes', comment: ' Más grande ' })).toEqual({ choice: 1, note: 'Más grande' });
    expect(toResolveInput({ kind: 'access', value: 'x' })).toEqual({ value: 'x' });
  });
});

/* ------------------------------------------------------------------ HttpApi */

describe('HttpApi', () => {
  beforeEach(() => {
    FakeWS.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = (routes: Record<string, (init: RequestInit) => Response>) => {
    const f = fakeFetch(routes);
    const api = new HttpApi({ fetch: f.fn, WebSocket: FakeWS as unknown as typeof WebSocket, origin: 'https://dagyard.test', backoff: () => 100, pingEvery: 1000, staleAfter: 5000 });
    return { api, calls: f.calls };
  };

  it('sesión: login por cookie, check y 401 → UnauthorizedError', async () => {
    const { api, calls } = make({
      'POST /api/session': () => new Response(null, { status: 204 }),
      'GET /api/me': json({ role: 'owner' }),
      'GET /api/projects': json({ error: { code: 'unauthorized', message: 'No' } }, 401),
    });
    await api.login('  clave  ');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ token: 'clave' });
    expect(calls[0]!.init.credentials).toBe('same-origin');
    expect(await api.check()).toBe(true);
    await expect(api.listProjects()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('lee proyectos y snapshot, y resuelve en la ruta del proyecto', async () => {
    const { api, calls } = make({
      'GET /api/projects': json({ projects: [{ id: 'p', name: 'Marketplace de reservas', stages: [], counts: {}, openBlockers: 1, updatedAt: T }] }),
      'GET /api/projects/p': json(wsnap()),
      'POST /api/projects/p/blockers/b_1/resolve': json(wblocker({ status: 'resolved', resolvedBy: 'owner', resolvedAt: T, resolution: { choice: 'Al cliente', note: null, hasValue: false } })),
    });
    expect(await api.listProjects()).toEqual([{ id: 'p', name: 'Marketplace de reservas' }]);
    await api.getSnapshot('p');
    const b = await api.resolveBlocker('b_1', { kind: 'decision', option: 'Al cliente' });
    expect(b.resolution).toBe('«Al cliente»');
    expect(JSON.parse(calls.at(-1)!.init.body as string)).toEqual({ choice: 'Al cliente' });
  });

  it('un error del servidor llega como ApiError con su código', async () => {
    const { api } = make({
      'GET /api/projects/p': json(wsnap()),
      'POST /api/projects/p/blockers/b_1/resolve': json({ error: { code: 'conflict', message: 'Ya está resuelto' } }, 409),
    });
    await api.getSnapshot('p');
    await expect(api.resolveBlocker('b_1', { kind: 'decision', option: 'Al cliente' })).rejects.toMatchObject({ code: 'conflict', status: 409 });
    await expect(api.resolveBlocker('b_desconocido', { kind: 'decision', option: 'x' })).rejects.toBeInstanceOf(ApiError);
  });

  it('tiempo real: traduce eventos, reconecta y reanuda desde el último seq', async () => {
    const { api } = make({ 'GET /api/me': json({ role: 'owner' }) });
    const events: DagEvent[] = [];
    const status: string[] = [];
    const stop = api.subscribe('p', 7, { onEvent: (e) => events.push(e), onStatus: (s) => status.push(s) });
    await vi.advanceTimersByTimeAsync(0);

    const ws1 = FakeWS.all[0]!;
    expect(ws1.url).toBe('wss://dagyard.test/api/projects/p/live?since=7');
    ws1.open();
    ws1.frame({ type: 'hello', projectId: 'p', seq: 7 });
    ws1.frame({ type: 'event', event: ev(8, 'node.updated', { node: wnode('modelo-de-comisiones', { status: 'working', progress: 0.1 }) }) });
    ws1.frame({ type: 'event', event: ev(9, 'message.posted', { message: { id: 'm_2', projectId: 'p', nodeId: 'modelo-de-comisiones', from: 'Equipo de Diseño', text: 'Sigo', reportUrl: null, createdAt: T } }) });
    ws1.frame({ type: 'event', event: ev(9, 'node.removed', { nodeId: 'repetido' }) }); // duplicado: se ignora
    expect(events.map((e) => [e.seq, e.type])).toEqual([[8, 'node.updated'], [9, 'message.posted']]);
    expect(events[0]).toMatchObject({ node: { stageId: 'diseno', status: 'working' } });
    expect(status).toEqual(['live']);

    ws1.drop();
    expect(status).toEqual(['live', 'reconnecting']);
    await vi.advanceTimersByTimeAsync(100);
    const ws2 = FakeWS.all[1]!;
    expect(ws2.url).toContain('since=9');
    ws2.open();
    ws2.frame({ type: 'hello', projectId: 'p', seq: 9 });
    expect(status).toEqual(['live', 'reconnecting', 'live']);

    stop();
    expect(ws2.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWS.all).toHaveLength(2);
  });

  it('resync y proyecto reemplazado piden recargar el snapshot', async () => {
    const { api } = make({});
    const onResync = vi.fn();
    const events: DagEvent[] = [];
    api.subscribe('p', 0, { onEvent: (e) => events.push(e), onResync });
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWS.all[0]!;
    ws.open();
    ws.frame({ type: 'resync', seq: 900 });
    ws.frame({ type: 'event', event: ev(901, 'project.replaced', { project: { id: 'p', name: 'X', stages: [] } }) });
    expect(onResync).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(0);
  });

  it('cambiar de idioma pide recargar el plan (los resúmenes salen en el idioma nuevo), solo mientras está suscrito', async () => {
    const { api } = make({});
    const onResync = vi.fn();
    const stop = api.subscribe('p', 0, { onEvent: () => {}, onResync });
    await vi.advanceTimersByTimeAsync(0);
    setLang('en');
    expect(onResync).toHaveBeenCalledTimes(1);
    setLang('en');
    expect(onResync).toHaveBeenCalledTimes(1);
    stop();
    setLang('es');
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('tras cerrarse un socket vivo, el primer reintento sale sin espera y los siguientes esperan', async () => {
    const { api } = make({ 'GET /api/me': json({ role: 'owner' }) });
    api.subscribe('p', 0, { onEvent: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    const ws1 = FakeWS.all[0]!;
    ws1.open();
    ws1.frame({ type: 'hello', projectId: 'p', seq: 0 });
    await vi.advanceTimersByTimeAsync(3000);

    ws1.drop(); // un deploy reinicia el proyecto
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.all).toHaveLength(2);

    FakeWS.all[1]!.drop(); // el reintento no llegó a `hello`: ahora sí hay backoff
    await vi.advanceTimersByTimeAsync(99);
    expect(FakeWS.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWS.all).toHaveLength(3);
  });

  it('un servidor caído sigue con backoff desde el primer reintento', async () => {
    const waits: number[] = [];
    const api = new HttpApi({
      fetch: fakeFetch({ 'GET /api/me': json({ role: 'owner' }) }).fn,
      WebSocket: FakeWS as unknown as typeof WebSocket,
      origin: 'https://dagyard.test',
      backoff: (a) => (waits.push(a), 100 * (a + 1)),
    });
    api.subscribe('p', 0, { onEvent: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    FakeWS.all[0]!.drop(); // nunca llegó a `hello`
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeWS.all).toHaveLength(2);
    FakeWS.all[1]!.drop();
    await vi.advanceTimersByTimeAsync(199);
    expect(FakeWS.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWS.all).toHaveLength(3);
    expect(waits).toEqual([0, 1]);
  });

  it('un socket que vive y muere en bucle no martilla: el reintento inmediato vuelve solo tras uno estable', async () => {
    const { api } = make({ 'GET /api/me': json({ role: 'owner' }) });
    api.subscribe('p', 0, { onEvent: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    const live = (i: number) => {
      FakeWS.all[i]!.open();
      FakeWS.all[i]!.frame({ type: 'hello', projectId: 'p', seq: 0 });
    };

    live(0);
    await vi.advanceTimersByTimeAsync(3000);
    FakeWS.all[0]!.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.all).toHaveLength(2); // inmediato

    live(1);
    FakeWS.all[1]!.drop(); // saluda y muere al toque
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.all).toHaveLength(2); // ya no es inmediato
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeWS.all).toHaveLength(3);

    live(2);
    await vi.advanceTimersByTimeAsync(3000); // este sí se quedó: recarga el reintento inmediato
    FakeWS.all[2]!.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.all).toHaveLength(4);
  });

  it('manda ping y da por muerta una conexión sin frames', async () => {
    const { api } = make({ 'GET /api/me': json({ role: 'owner' }) });
    api.subscribe('p', 0, { onEvent: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWS.all[0]!;
    ws.open();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.sent).toContain(JSON.stringify({ type: 'ping' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(ws.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeWS.all.length).toBeGreaterThan(1);
  });
});
