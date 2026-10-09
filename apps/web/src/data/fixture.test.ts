import { beforeEach, describe, expect, it } from 'vitest';
import { RESOLVED_BY_YOU } from './adapter';
import { FixtureApi } from './fixture';
import { reduce } from './reduce';
import { ApiError } from './session';
import { UnauthorizedError, type DagEvent, type Snapshot } from './types';
import { setLang } from '../i18n';

// estos tests leen la interfaz en español; jsdom diría en-US (#73)
beforeEach(() => setLang('es'));

const P = 'marketplace-reservas';

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

async function loggedIn(storage: Storage | null = null) {
  const api = new FixtureApi({ storage });
  await api.login('cualquier-clave');
  return api;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('FixtureApi', () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('el proyecto de ejemplo es el del preview: 20 tareas, 5 etapas, 3 pedidos', async () => {
    const api = await loggedIn();
    const s = await api.getSnapshot(P);
    expect(s.project.name).toBe('Marketplace de reservas');
    expect(s.nodes).toHaveLength(20);
    expect(s.stages.map((x) => x.name)).toEqual(['Descubrimiento', 'Diseño', 'Construcción', 'Pruebas', 'Lanzamiento']);
    expect(s.blockers.map((b) => b.kind).sort()).toEqual(['access', 'decision', 'review']);
    expect(s.nodes.filter((n) => n.status === 'blocked')).toHaveLength(3);
  });

  it('sin sesión, una clave mala o vacía no entra', async () => {
    const api = new FixtureApi({ storage: null });
    await expect(api.listProjects()).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(api.login('clave-mala')).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(api.login('   ')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(await api.check()).toBe(false);
    await api.login('buena');
    expect(await api.check()).toBe(true);
    expect((await api.listProjects()).length).toBeGreaterThanOrEqual(2);
  });

  it('resuelve los 3 pedidos, emite eventos y la tarea sigue', async () => {
    const api = await loggedIn(storage);
    let snap: Snapshot = await api.getSnapshot(P);
    const events: DagEvent[] = [];
    const stop = api.subscribe(P, snap.seq, { onEvent: (e) => events.push(e) });
    await flush();

    const byKind = (k: string) => snap.blockers.find((b) => b.kind === k)!;
    const decision = byKind('decision');
    const review = byKind('review');
    const access = byKind('access');

    const d = await api.resolveBlocker(decision.id, { kind: 'decision', option: decision.options[0]! });
    expect(d.resolvedAt).toBeDefined();
    expect(d.resolution).toBe('«Al proveedor (10 % por reserva)»');

    const r = await api.resolveBlocker(review.id, { kind: 'review', verdict: 'changes', comment: 'El botón de pagar más grande' });
    expect(r.resolution).toBe('Pediste cambios: El botón de pagar más grande');

    const a = await api.resolveBlocker(access.id, { kind: 'access', value: 'sk_live_secreto' });
    expect(a.resolution).toBe('Acceso entregado');
    expect(JSON.stringify(a)).not.toContain('sk_live_secreto');

    for (const e of events) snap = reduce(snap, e);
    expect(events.filter((e) => e.type === 'blocker.resolved')).toHaveLength(3);
    for (const b of [decision, review, access]) {
      expect(snap.blockers.find((x) => x.id === b.id)?.resolvedAt).toBeDefined();
      expect(snap.nodes.find((n) => n.id === b.nodeId)?.status).toBe('working');
    }
    expect(snap.nodes.filter((n) => n.status === 'blocked')).toHaveLength(0);
    expect(events.some((e) => e.type === 'message.posted' && e.message.text.startsWith('Gracias'))).toBe(true);
    // El secreto no viaja en ningún evento.
    expect(JSON.stringify(events)).not.toContain('sk_live_secreto');
    stop();
  });

  it('lo resuelto persiste durante la sesión (sobrevive a recargar) y sin el secreto', async () => {
    const api = await loggedIn(storage);
    const s = await api.getSnapshot(P);
    const access = s.blockers.find((b) => b.kind === 'access')!;
    await api.resolveBlocker(access.id, { kind: 'access', value: 'sk_live_secreto' });

    const reloaded = new FixtureApi({ storage });
    expect(await reloaded.check()).toBe(true);
    const again = await reloaded.getSnapshot(P);
    expect(again.blockers.find((b) => b.id === access.id)?.resolvedAt).toBeDefined();
    expect(again.nodes.find((n) => n.id === access.nodeId)?.status).toBe('working');
    expect(storage.getItem('dagyard:fixture')).not.toContain('sk_live_secreto');
  });

  it('resolver dos veces responde conflicto', async () => {
    const api = await loggedIn();
    const s = await api.getSnapshot(P);
    const d = s.blockers.find((b) => b.kind === 'decision')!;
    await api.resolveBlocker(d.id, { kind: 'decision', option: d.options[1]! });
    await expect(api.resolveBlocker(d.id, { kind: 'decision', option: d.options[0]! })).rejects.toMatchObject({ code: 'conflict' });
    await expect(api.resolveBlocker('b_nada', { kind: 'decision', option: 'x' })).rejects.toBeInstanceOf(ApiError);
  });

  it('en inglés, el ejemplo es «Booking marketplace» y la respuesta es tuya y en inglés (#83)', async () => {
    setLang('en');
    const api = await loggedIn();
    const list = await api.listProjects();
    expect(list.map((p) => p.name)).toContain('Booking marketplace');
    expect(list.map((p) => p.name)).not.toContain('Marketplace de reservas');
    const s = await api.getSnapshot('booking-marketplace');
    expect(s.nodes).toHaveLength(20);
    expect(s.stages.map((x) => x.name)).toEqual(['Discovery', 'Design', 'Build', 'Testing', 'Launch']);
    expect(s.messages.every((m) => m.from.endsWith(' team'))).toBe(true);

    const events: DagEvent[] = [];
    api.subscribe('booking-marketplace', s.seq, { onEvent: (e) => events.push(e) });
    await flush();
    const decision = s.blockers.find((b) => b.kind === 'decision')!;
    const d = await api.resolveBlocker(decision.id, { kind: 'decision', option: decision.options[0]! });
    expect(d.resolution).toBe('“The provider (10% per booking)”');
    expect(d.resolvedBy).toBe(RESOLVED_BY_YOU);
    const thanks = events.find((e) => e.type === 'message.posted');
    expect(thanks).toMatchObject({ message: { from: 'Design team', text: 'Thanks. Picking up where I left off.' } });
  });

  it('en español, el ejemplo es «Marketplace de reservas» y la respuesta es tuya (#83)', async () => {
    const api = await loggedIn();
    expect((await api.listProjects()).map((p) => p.name)).toContain('Marketplace de reservas');
    const s = await api.getSnapshot(P);
    const d = await api.resolveBlocker(s.blockers[0]!.id, { kind: 'decision', option: s.blockers[0]!.options[0]! });
    expect(d.resolvedBy).toBe(RESOLVED_BY_YOU);
  });

  it('subscribe reenvía lo posterior a sinceSeq y avisa en vivo', async () => {
    const api = await loggedIn();
    api.message(P, 'pagos', 'Primero');
    const seen: DagEvent[] = [];
    const status: string[] = [];
    const stop = api.subscribe(P, 0, { onEvent: (e) => seen.push(e), onStatus: (s) => status.push(s) });
    await flush();
    expect(seen.map((e) => e.type)).toEqual(['message.posted']);
    expect(status).toEqual(['live']);
    api.done(P, 'buscador');
    expect(seen.at(-1)).toMatchObject({ type: 'node.updated', node: { status: 'done', progress: 1 } });
    stop();
    api.start(P, 'whatsapp');
    expect(seen).toHaveLength(2);
  });
});

describe('datos hostiles (#117)', () => {
  it('ningún pedido repite el título de otra tarea: en la ficha parecería de otra', async () => {
    const { estresSnapshot } = await import('./fixture');
    const s = estresSnapshot();
    const titles = new Map(s.nodes.map((n) => [n.title.replace(/^¿|\?$/g, ''), n.id]));
    for (const b of s.blockers) {
      const other = titles.get(b.question.replace(/^¿|\?$/g, ''));
      expect(other === undefined || other === b.nodeId, `${b.id} pregunta por ${other}`).toBe(true);
    }
    // y el pedido largo sigue ahí para probar el desborde
    expect(Math.max(...s.blockers.map((b) => b.question.length))).toBeGreaterThanOrEqual(250);
  });
});
