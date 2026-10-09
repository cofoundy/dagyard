// #64: un link abre un proyecto o una tarea directo, y la URL sigue a lo que miras. En la fixture, «Renovación del sitio
// web» hace de «Dagyard» y «Portada nueva» de la tarea gh-47.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateSkyOptions } from '../scene/contract';
import { FixtureApi } from '../data/fixture';
import { App } from './App';
import { readLink, writeLink } from './link';
import { initialProject } from './Workspace';
import { setLang } from '../i18n';

// estos tests leen la interfaz en español; jsdom diría en-US (#73)
beforeEach(() => setLang('es'));

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

const DEMO = 'marketplace-reservas';
const OTHER = 'renovacion-del-sitio';
const PROJECT_KEY = 'dagyard:project';
let root: Root;
let host: HTMLDivElement;
let store: Map<string, string>;

beforeEach(() => {
  scene.opts = null;
  scene.calls = [];
  // el localStorage de Node tapa al de jsdom: uno en memoria, como un navegador limpio
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
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
const project = () => host.querySelector('.proj')?.textContent;
const card = () => host.querySelector('.card.open h2')?.textContent ?? null;
const params = () => Object.fromEntries(new URLSearchParams(window.location.search));
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const calls = (name: string) => scene.calls.filter(([n]) => n === name);

function open(url: string) {
  window.history.replaceState(null, '', url);
}

async function mount(api: FixtureApi, { login = true } = {}) {
  if (login) await api.login('clave-de-prueba');
  act(() => root.render(<App api={api} demo />));
}

describe('el enlace', () => {
  it('lee proyecto y tarea; una tarea sin proyecto no dice a dónde ir', () => {
    expect(readLink('?p=dagyard&n=gh-47')).toEqual({ project: 'dagyard', node: 'gh-47' });
    expect(readLink('?p=dagyard')).toEqual({ project: 'dagyard', node: null });
    expect(readLink('?n=gh-47')).toEqual({ project: null, node: null });
    expect(readLink('?p=%20&n=gh-47')).toEqual({ project: null, node: null });
    expect(readLink('')).toEqual({ project: null, node: null });
  });

  it('se escribe sin entrada de historial y conserva los demás parámetros y el ancla', () => {
    open('/?debug=1&n=vieja#x');
    const before = window.history.length;
    writeLink({ project: 'dagyard', node: 'gh-47' });
    expect(window.location.search).toBe('?debug=1&n=gh-47&p=dagyard');
    expect(window.location.hash).toBe('#x');
    writeLink({ project: 'dagyard', node: null });
    expect(params()).toEqual({ debug: '1', p: 'dagyard' });
    expect(window.history.length).toBe(before);
  });

  it('el proyecto del enlace manda sobre lo recordado y la demo; si no existe, cuenta lo de siempre', () => {
    const list = [
      { id: 'dagyard', name: 'Dagyard' },
      { id: DEMO, name: 'Marketplace de reservas' },
    ];
    expect(initialProject(list, DEMO, 'dagyard')).toBe('dagyard');
    expect(initialProject(list, null, 'dagyard')).toBe('dagyard');
    expect(initialProject(list, null, 'ya-no-existe')).toBe(DEMO);
    expect(initialProject(list, 'dagyard', null)).toBe('dagyard');
  });

  // #74: sin enlace ni elección, la demo en el idioma del PM; el enlace y lo recordado siguen ganando
  it('sin enlace ni elección abre la demo del idioma: en → booking-marketplace, es → marketplace-reservas', () => {
    const list = [
      { id: 'dagyard', name: 'Dagyard' },
      { id: DEMO, name: 'Marketplace de reservas' },
      { id: 'booking-marketplace', name: 'Booking marketplace' },
    ];
    expect(initialProject(list, null, null, 'en')).toBe('booking-marketplace');
    expect(initialProject(list, null, null, 'es')).toBe(DEMO);
    expect(initialProject(list, 'ya-no-existe', null, 'en')).toBe('booking-marketplace');
    for (const l of ['en', 'es'] as const) {
      expect(initialProject(list, 'dagyard', null, l)).toBe('dagyard');
      expect(initialProject(list, DEMO, 'dagyard', l)).toBe('dagyard');
    }
    expect(initialProject(list, DEMO, null, 'en')).toBe(DEMO);
    // si falta la demo de su idioma, la otra antes que un proyecto cualquiera
    expect(initialProject(list.slice(0, 2), null, null, 'en')).toBe(DEMO);
    expect(initialProject([list[0]!, list[2]!], null, null, 'es')).toBe('booking-marketplace');
  });

  it('sin idioma explícito usa el de la UI', () => {
    const list = [
      { id: DEMO, name: 'Marketplace de reservas' },
      { id: 'booking-marketplace', name: 'Booking marketplace' },
    ];
    setLang('es');
    expect(initialProject(list, null)).toBe(DEMO);
    setLang('en');
    expect(initialProject(list, null)).toBe('booking-marketplace');
  });
});

describe('abrir un enlace', () => {
  it('/?p=<proyecto> abre ese proyecto aunque el navegador recuerde otro, y lo recuerda', async () => {
    store.set(PROJECT_KEY, DEMO);
    open(`/?p=${OTHER}`);
    await mount(new FixtureApi({ storage: null }));
    await until(() => project() === 'Renovación del sitio web' && !!host.querySelector('.foot .tools'), 'abre el proyecto del enlace');
    expect(store.get(PROJECT_KEY)).toBe(OTHER);
    expect(card()).toBeNull();
    expect(params()).toEqual({ p: OTHER });
  });

  it('/?p=<proyecto>&n=<tarea> vuela a la tarea y abre su ficha', async () => {
    open(`/?p=${OTHER}&n=portada-nueva`);
    await mount(new FixtureApi({ storage: null }));
    await until(() => card() === 'Portada nueva', 'abre la ficha de la tarea');
    expect(project()).toBe('Renovación del sitio web');
    // vuela después de que el plan está en el cielo, y una sola vez
    const order = scene.calls.map(([n]) => n);
    expect(order.indexOf('focus')).toBeGreaterThan(order.indexOf('setGraph'));
    expect(calls('focus')).toEqual([['focus', ['portada-nueva']]]);
    expect(params()).toEqual({ p: OTHER, n: 'portada-nueva' });
  });

  it('un enlace abierto sin sesión lleva al destino después de entrar', async () => {
    open(`/?p=${OTHER}&n=portada-nueva`);
    const api = new FixtureApi({ storage: null });
    await mount(api, { login: false });
    await until(() => !!host.querySelector('#clave'), 'pide la clave');
    expect(window.location.search).toBe(`?p=${OTHER}&n=portada-nueva`);

    const input = host.querySelector<HTMLInputElement>('#clave')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'clave-buena');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => void host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await until(() => card() === 'Portada nueva', 'llega a la ficha tras entrar');
    expect(project()).toBe('Renovación del sitio web');
    // la clave nunca viaja en la URL
    expect(window.location.href).not.toContain('clave');
  });

  it('una tarea que no existe se ignora: vista general y el enlace pierde la tarea', async () => {
    open(`/?p=${OTHER}&n=ya-no-existe`);
    await mount(new FixtureApi({ storage: null }));
    await until(() => project() === 'Renovación del sitio web' && !!host.querySelector('.foot .tools'), 'abre el proyecto');
    await settle(2);
    expect(card()).toBeNull();
    expect(calls('focus')).toEqual([]);
    expect(params()).toEqual({ p: OTHER });
  });

  it('un proyecto que no existe abre la demo; sin enlace también', async () => {
    open('/?p=ya-no-existe&n=portada-nueva');
    await mount(new FixtureApi({ storage: null }));
    await until(() => !!host.querySelector('.foot .tools'), 'abre la demo');
    expect(project()).toBe('Marketplace de reservas');
    expect(card()).toBeNull();
    expect(params()).toEqual({ p: DEMO });

    act(() => root.unmount());
    root = createRoot(host);
    store.clear();
    open('/');
    await mount(new FixtureApi({ storage: null }));
    await until(() => !!host.querySelector('.foot .tools'), 'abre la demo sin enlace');
    expect(project()).toBe('Marketplace de reservas');
  });
});

describe('la URL sigue a lo que miras', () => {
  it('al abrir una tarea, volver a la vista general o cambiar de proyecto, sin perder otros parámetros', async () => {
    open('/?debug=1');
    await mount(new FixtureApi({ storage: null }));
    await until(() => !!host.querySelector('.foot .tools') && !!scene.opts, 'carga la demo');
    expect(params()).toEqual({ debug: '1', p: DEMO });

    act(() => scene.opts!.handlers.onPick('pagos'));
    await until(() => card() === 'Pagos con tarjeta', 'abre la ficha');
    expect(params()).toEqual({ debug: '1', p: DEMO, n: 'pagos' });

    act(() => scene.opts!.handlers.onPick(null));
    await until(() => card() === null, 'cierra la ficha');
    expect(params()).toEqual({ debug: '1', p: DEMO });

    act(() => scene.opts!.handlers.onPick('pagos'));
    click(host.querySelector('.proj')!);
    click([...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Renovación del sitio web')!);
    await until(() => project() === 'Renovación del sitio web', 'cambia de proyecto');
    expect(params()).toEqual({ debug: '1', p: OTHER });
  });
});
