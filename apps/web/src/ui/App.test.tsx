import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateSkyOptions } from '../scene/contract';
import { FixtureApi } from '../data/fixture';
import { measureSafeArea } from './useSafeArea';
import { App } from './App';
import { initialProject } from './Workspace';
import { setLang } from '../i18n';

// estos tests leen la interfaz en español; jsdom diría en-US (#73)
beforeEach(() => setLang('es'));

// La escena es de otro carril: aquí se reemplaza por un doble que registra lo que la interfaz le pide.
const scene = vi.hoisted(() => ({ opts: null as CreateSkyOptions | null, calls: [] as Array<[string, unknown[]]> }));
vi.mock('../scene', () => ({
  createSky: (o: CreateSkyOptions) => {
    scene.opts = o;
    const rec =
      (name: string) =>
      (...args: unknown[]) =>
        void scene.calls.push([name, args]);
    return {
      setGraph: rec('setGraph'),
      pulse: rec('pulse'),
      overview: rec('overview'),
      replay: rec('replay'),
      // la ficha y la búsqueda las llaman al pintar: no se registran para no tapar lo que se prueba
      mark: () => {},
      setCardArea: () => {},
      focus: rec('focus'),
      setSafeArea: rec('setSafeArea'),
      dispose: rec('dispose'),
    };
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const P = 'marketplace-reservas';
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  scene.opts = null;
  scene.calls = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function settle(times = 4) {
  for (let i = 0; i < times; i++) await act(() => new Promise<void>((r) => setTimeout(r, 0)));
}

async function until(cond: () => boolean, label: string) {
  for (let i = 0; i < 50; i++) {
    if (cond()) return;
    await settle(1);
  }
  throw new Error(`No se cumplió: ${label}\n${host.textContent}`);
}

const text = () => host.textContent ?? '';
const pick = (id: string | null) => act(() => scene.opts!.handlers.onPick(id));
const buttons = () => [...host.querySelectorAll('button')];
const button = (label: string | RegExp) => {
  const b = buttons().find((x) => (typeof label === 'string' ? x.textContent?.trim() === label : label.test(x.textContent ?? '')));
  if (!b) throw new Error(`No hay botón «${label}»`);
  return b;
};
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Todo lo que un PM puede leer: texto y atributos legibles. */
function readable(): string {
  const attrs = [...host.querySelectorAll('[aria-label],[placeholder],[title]')].flatMap((el) =>
    ['aria-label', 'placeholder', 'title'].map((a) => el.getAttribute(a) ?? ''),
  );
  return `${text()} ${attrs.join(' ')}`;
}

async function mountIn() {
  const api = new FixtureApi({ storage: null });
  await api.login('clave-de-prueba');
  act(() => root.render(<App api={api} demo />));
  await until(() => !!host.querySelector('.foot .tools') && !!scene.opts, 'carga el plan');
  return api;
}

describe('interfaz', () => {
  it('pinta el HUD, el pie y le pasa el DAG y el SafeArea a la escena', async () => {
    await mountIn();
    expect(text()).toContain('Marketplace de reservas');
    // la brújula (#109): lo que te espera con su «Responder», lo que está en curso y lo que sigue, por nombre
    expect(text()).toContain('3 cosas esperan tu respuesta');
    expect(text()).toContain('Responder');
    expect(text()).toContain('En curso ahora');
    expect(text()).toContain('Lo que sigue');
    expect(host.querySelector('.brief .b-row.blocked')?.textContent).toContain('Modelo de comisiones');
    expect(host.querySelector('.foot input[type="search"]')).not.toBeNull();
    const graphs = scene.calls
      .filter(([n]) => n === 'setGraph')
      .map(([, a]) => a[0] as { nodes: Array<{ born: number }>; edges: Array<{ kind: string }> });
    expect(graphs.at(-1)?.nodes).toHaveLength(20);
    // sin #90 en el cable, la escena recibe solo dependencias (los orígenes deducidos no se dibujan dos veces)
    expect(graphs.at(-1)?.edges.every((e) => e.kind === 'needs')).toBe(true);
    expect(graphs.at(-1)?.nodes.every((n) => Number.isFinite(n.born))).toBe(true);
    expect(scene.calls.some(([n]) => n === 'setSafeArea')).toBe(true);
  });

  it('ningún texto contiene ids ni estados técnicos, abriendo cada ficha y con avisos en vivo', async () => {
    const api = await mountIn();
    const snap = await api.getSnapshot(P);
    // Un id de la demo que es una palabra de su propio texto («competencia») no se distingue de la prosa: se salta.
    const prose = [snap.project.name, ...snap.stages.map((s) => s.name), ...snap.nodes.flatMap((n) => [n.title, n.goal ?? '']), ...snap.blockers.flatMap((b) => [b.question, ...b.options]), ...snap.messages.map((m) => m.text)].join(' ').toLowerCase();
    const ids = [...snap.nodes.map((n) => n.id), ...snap.blockers.map((b) => b.id), ...snap.messages.map((m) => m.id), snap.project.id].filter((id) => !prose.includes(id));
    const seen: string[] = [readable()];
    for (const n of snap.nodes) {
      pick(n.id);
      await settle(1);
      expect(host.querySelector('.card.open h2')?.textContent).toBe(n.title);
      seen.push(readable());
    }
    // Avisos de lo que hace la fábrica (los mismos eventos que manda el servidor).
    act(() => {
      api.message(P, 'pagos', 'Ya conecté la pasarela. Falta probar un reembolso.');
      api.done(P, 'buscador');
      api.start(P, 'velocidad');
      api.addNode(P, { id: 'recuperar-contrasena', title: 'Recuperar contraseña', stageId: 'construccion', deps: ['registro'] });
      api.block(P, 'whatsapp', 'review', '¿Te parece bien el texto del aviso?');
    });
    await settle(2);
    seen.push(readable());
    // Selector de proyecto abierto.
    click(host.querySelector('.proj')!);
    seen.push(readable());

    const all = seen.join('\n');
    for (const id of ids) expect(all, `aparece el id ${id}`).not.toContain(id);
    expect(all).not.toMatch(/\b(pending|working|blocked|done|queued|decision|review|access)\b/i);
    expect(all).not.toMatch(/\bT-\d+/);
    expect(all).not.toMatch(/\b[bm]_[a-z0-9]+/);
    expect(all).toContain('Equipo de Construcción');
    expect(all).toContain('Buscador con filtros');
  });

  it('resuelve los tres pedidos desde la ficha: decisión, revisión con cambios y acceso', async () => {
    await mountIn();

    pick('comision');
    await settle(1);
    expect(text()).toContain('Necesita tu decisión');
    click(button('Al proveedor (10 % por reserva)'));
    await until(() => text().includes('Decidiste'), 'decisión registrada');
    expect(text()).toContain('«Al proveedor (10 % por reserva)» · el equipo sigue');
    expect(host.querySelector('.card .chip')?.textContent).toBe('En curso');

    pick('checkout-d');
    await settle(1);
    expect(text()).toContain('Necesita tu revisión');
    click(button('Pedir cambios'));
    type(host.querySelector('.card textarea')!, 'Que el botón de pagar sea más visible');
    click(button('Enviar cambios'));
    await until(() => text().includes('Revisaste'), 'revisión registrada');
    expect(text()).toContain('Pediste cambios: Que el botón de pagar sea más visible');

    pick('pagos');
    await settle(1);
    expect(text()).toContain('Clave de la pasarela de pagos');
    click(button('Desbloquear'));
    expect(host.querySelector<HTMLInputElement>('.card input[type=password]')?.placeholder).toBe('Falta el valor');
    type(host.querySelector('.card input[type=password]')!, 'sk_live_no_se_muestra');
    click(button('Desbloquear'));
    await until(() => text().includes('Entregaste un acceso'), 'acceso registrado');
    expect(readable()).not.toContain('sk_live_no_se_muestra');

    expect(text()).toContain('Nada te espera');
    expect(scene.calls.some(([n, a]) => n === 'pulse' && a[0] === 'pagos' && a[1] === 'working')).toBe(true);
  });

  it('«Responder» recorre lo que te toca y Escape vuelve a la vista general', async () => {
    await mountIn();
    click(button('Responder'));
    expect(scene.calls.filter(([n]) => n === 'focus').at(-1)?.[1][0]).toBe('comision');
    click(button('Responder'));
    expect(scene.calls.filter(([n]) => n === 'focus').at(-1)?.[1][0]).toBe('checkout-d');
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(host.querySelector('.card.open')).toBeNull();
    expect(scene.calls.at(-1)?.[0]).toBe('overview');
    click(button(/^Repetir$/));
    expect(scene.calls.at(-1)?.[0]).toBe('replay');
  });

  it('con el teclado, una fila de la brújula abre la ficha con el foco dentro; Escape lo devuelve a la fila (#116)', async () => {
    await mountIn();
    const row = button(/^Buscador con filtros/);
    row.focus();
    // Enter sobre un botón es su clic
    click(row);
    await settle(1);
    const card = host.querySelector('.card.open');
    expect(card?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toBe('Buscador con filtros');
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await settle(1);
    expect(host.querySelector('.card.open')).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('la brújula: cada fila vuela a su estrella; desplegada crece hasta 8 sin scroll y el resto va a la búsqueda', async () => {
    await mountIn();
    click(button(/^Buscador con filtros/));
    expect(scene.calls.filter(([n]) => n === 'focus').at(-1)?.[1][0]).toBe('buscador');
    // «Lo que sigue» tiene 9: se ven 3 y «+6 más»; desplegado, 8, «Ver menos» y «1 más · Busca una tarea»
    const next = () => host.querySelectorAll('.brief .b-group:last-child .b-row');
    expect(next()).toHaveLength(3);
    click(button('+6 más'));
    expect(next()).toHaveLength(8);
    // desplegar un grupo pliega el otro a su cabecera, que lo vuelve a abrir
    expect(host.querySelectorAll('.brief .b-row.working')).toHaveLength(0);
    expect(button(/^En curso ahora/).getAttribute('aria-expanded')).toBe('false');
    click(button('1 más · Busca una tarea'));
    expect(document.activeElement).toBe(host.querySelector('.foot input[type="search"]'));
    click(button('Ver menos'));
    expect(next()).toHaveLength(3);
    expect(host.querySelectorAll('.brief .b-row.working')).toHaveLength(3);
  });

  it('la entrada rechaza una clave mala y deja pasar una buena', async () => {
    const api = new FixtureApi({ storage: null });
    act(() => root.render(<App api={api} demo />));
    await until(() => !!host.querySelector('#clave'), 'muestra la entrada');
    type(host.querySelector('#clave')!, 'clave-mala');
    await act(async () => void host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await until(() => text().includes('Esa clave no sirve'), 'error de clave');
    type(host.querySelector('#clave')!, 'clave-buena');
    await act(async () => void host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await until(() => text().includes('Marketplace de reservas'), 'entra');
  });
});

// #109 con los datos reales de «dagyard» (9 oct): «Abrir el código» lleva 5 días sin noticias y hay pedidos abiertos.
describe('la brújula con el proyecto «dagyard» del 9 oct', () => {
  async function mountDagyard() {
    window.history.replaceState(null, '', '/?p=dagyard-hoy');
    const api = new FixtureApi({ storage: null, extra: true });
    await api.login('clave-de-prueba');
    act(() => root.render(<App api={api} demo />));
    await until(() => !!host.querySelector('.brief') && text().includes('En curso ahora'), 'carga dagyard');
    return api;
  }
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
  });

  it('la ficha y el cielo dicen «Sin noticias» de lo quieto y no llaman «En curso» a un pedido abierto', async () => {
    const api = await mountDagyard();
    pick('gh-25');
    await settle(1);
    expect(host.querySelector('.card .chip')?.textContent).toBe('Sin noticias');
    const graph = scene.calls.filter(([n]) => n === 'setGraph').at(-1)![1][0] as { nodes: Array<{ id: string; quiet?: boolean }> };
    expect(graph.nodes.find((n) => n.id === 'gh-25')?.quiet).toBe(true);
    expect(graph.nodes.filter((n) => n.quiet).map((n) => n.id)).toEqual(['gh-25']);

    const snap = await api.getSnapshot('dagyard-hoy');
    const req = snap.nodes.find((n) => n.kind === 'request' && n.status === 'working')!;
    pick(req.id);
    await settle(1);
    const chips = [...host.querySelectorAll('.card .top .chip')].map((c) => c.textContent);
    expect(chips).toEqual(['Pedido']);
  });

  it('en celular, elegir una fila de un grupo desplegado lo pliega: la ficha no lo deja cortado', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('max-width: 720px'), addEventListener() {}, removeEventListener() {} }));
    await mountDagyard();
    click(button(/^En curso ahora/));
    expect(host.querySelectorAll('.brief .b-row.working')).toHaveLength(3);
    click(button(/^Abrir el código/));
    expect(scene.calls.filter(([n]) => n === 'focus').at(-1)?.[1][0]).toBe('gh-25');
    expect(host.querySelectorAll('.brief .b-row.working')).toHaveLength(0);
    expect(button(/^En curso ahora/).getAttribute('aria-expanded')).toBe('false');
  });
});

// #29: el servidor lista por última actualización, así que lo último importado llega primero; al entrar sin elección
// previa se abre la demo, y lo que el usuario elige se recuerda al recargar.
describe('proyecto al entrar', () => {
  const list = [
    { id: 'basalt', name: 'Basalt' },
    { id: P, name: 'Marketplace de reservas' },
  ];

  it('sin elección previa abre la demo aunque no sea la primera de la lista', () => {
    expect(initialProject(list, null)).toBe(P);
    expect(initialProject(list, 'ya-no-existe')).toBe(P);
    expect(initialProject(list, 'basalt')).toBe('basalt');
    expect(initialProject([{ id: 'basalt', name: 'Basalt' }], null)).toBe('basalt');
    expect(initialProject([], null)).toBeNull();
  });

  /** La fixture con la lista como la manda el servidor: el último actualizado primero. */
  class LatestFirst extends FixtureApi {
    override async listProjects() {
      return (await super.listProjects()).reverse();
    }
  }

  // el localStorage de Node tapa al de jsdom: uno en memoria, como un navegador limpio
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, String(v)),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('un navegador limpio entra a la demo; si eligió otro y recarga, sigue en ese', async () => {
    const api = new LatestFirst({ storage: null });
    await api.login('clave-de-prueba');
    expect((await api.listProjects())[0]!.id).not.toBe(P);
    act(() => root.render(<App api={api} demo />));
    await until(() => !!host.querySelector('.foot .tools'), 'carga la demo');
    expect(host.querySelector('.proj')?.textContent).toBe('Marketplace de reservas');

    click(host.querySelector('.proj')!);
    click(button('Renovación del sitio web'));
    await until(() => host.querySelector('.proj')?.textContent === 'Renovación del sitio web', 'cambia de proyecto');

    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<App api={api} demo />));
    await until(() => !!host.querySelector('.foot .tools'), 'recarga');
    expect(host.querySelector('.proj')?.textContent).toBe('Renovación del sitio web');
  });
});

describe('SafeArea', () => {
  const box = (top: number, bottom: number) => ({ getBoundingClientRect: () => ({ top, bottom, height: bottom - top }) }) as unknown as Element;
  it('reserva arriba el HUD más alto y abajo el carril', () => {
    expect(measureSafeArea([box(18, 82), box(18, 52)], [box(840, 882)], 1440, 900)).toEqual({ top: 94, bottom: 72, left: 20, right: 20 });
    expect(measureSafeArea([box(18, 70), box(70, 108)], [box(790, 826), null], 390, 844)).toEqual({ top: 120, bottom: 66, left: 16, right: 16 });
  });
});
