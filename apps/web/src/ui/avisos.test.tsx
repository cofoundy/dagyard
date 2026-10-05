// #47: la web te avisa cuando algo te espera, con la app montada sobre la fixture (los mismos eventos que el servidor).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateSkyOptions } from '../scene/contract';
import { FixtureApi } from '../data/fixture';
import type { DagEvent } from '../data/types';
import { AMBER } from './attention';
import { App } from './App';
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

const P = 'marketplace-reservas';
let root: Root;
let host: HTMLDivElement;

interface Shown {
  title: string;
  options?: NotificationOptions;
  closed: boolean;
  onclick: ((e: Event) => void) | null;
}

function installNotification(permission: NotificationPermission, ask: NotificationPermission = 'granted') {
  const shown: Shown[] = [];
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = vi.fn(async () => {
      FakeNotification.permission = ask;
      return ask;
    });
    constructor(title: string, options?: NotificationOptions) {
      const rec: Shown = { title, options, closed: false, onclick: null };
      shown.push(rec);
      Object.defineProperty(this, 'onclick', { set: (fn) => (rec.onclick = fn), get: () => rec.onclick });
    }
    close() {
      const rec = shown.find((s) => s.onclick === (this as unknown as { onclick: unknown }).onclick);
      if (rec) rec.closed = true;
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
  return { FakeNotification, shown };
}

/** La fixture con un interruptor: eventos que se pierden (socket caído) y un `resync` a mano. */
class Flaky extends FixtureApi {
  mute = false;
  resync: (() => void) | null = null;
  override subscribe(projectId: string, since: number, h: Parameters<FixtureApi['subscribe']>[2]) {
    this.resync = () => h.onResync?.();
    return super.subscribe(projectId, since, { ...h, onEvent: (e: DagEvent) => void (!this.mute && h.onEvent(e)) });
  }
}

/** Si la página está a la vista: pestaña al frente (`document.hidden`) y ventana con foco (`hasFocus`). */
function viewing({ hidden, focused }: { hidden: boolean; focused: boolean }) {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
}

beforeEach(() => {
  // Por defecto no la estás mirando (otra pestaña al frente): es cuando el aviso del navegador tiene sentido.
  viewing({ hidden: true, focused: false });
  scene.opts = null;
  scene.calls = [];
  document.head.innerHTML = '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />';
  document.title = 'Dagyard';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
const favicon = () => decodeURIComponent(document.querySelector('link[rel~="icon"]')!.getAttribute('href')!);
const notifyButton = () => host.querySelector<HTMLButtonElement>('button.notify');
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

async function mount(api: FixtureApi = new FixtureApi({ storage: null })) {
  await api.login('clave-de-prueba');
  act(() => root.render(<App api={api} demo />));
  await until(() => !!host.querySelector('.foot .tools') && !!scene.opts, 'carga el plan');
  await settle(2);
  return api;
}

describe('pestaña y favicon', () => {
  it('la demo abre con «(3) Dagyard» y el punto ámbar; al resolverlo todo vuelve a «Dagyard»', async () => {
    installNotification('default');
    const api = await mount();
    expect(document.title).toBe('(3) Dagyard');
    expect(favicon()).toContain(AMBER);

    const snap = await api.getSnapshot(P);
    for (const b of snap.blockers.filter((x) => !x.resolvedAt)) {
      act(() => {
        void api.resolveBlocker(
          b.id,
          b.kind === 'access' ? { kind: 'access', value: 'x' } : b.kind === 'review' ? { kind: 'review', verdict: 'approve' } : { kind: 'decision', option: b.options[0]! },
        );
      });
    }
    await until(() => text().includes('Nada te espera'), 'sin pendientes');
    expect(document.title).toBe('Dagyard');
    expect(favicon()).toBe('/favicon.svg');
  });

  it('un pedido nuevo por tiempo real sube la cuenta', async () => {
    installNotification('default');
    const api = await mount();
    act(() => void api.block(P, 'whatsapp', 'review', '¿Te parece bien el texto del aviso?'));
    await until(() => document.title === '(4) Dagyard', 'sube a 4');
    expect(favicon()).toContain(AMBER);
  });

  it('al salir de la sesión la pestaña vuelve a «Dagyard»', async () => {
    installNotification('default');
    await mount();
    expect(document.title).toBe('(3) Dagyard');
    act(() => root.render(<></>));
    expect(document.title).toBe('Dagyard');
    expect(favicon()).toBe('/favicon.svg');
  });
});

describe('«Avisarme»', () => {
  it('aparece si el navegador puede avisar y no has decidido; pide permiso solo al clic', async () => {
    const { FakeNotification } = installNotification('default');
    await mount();
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    const btn = notifyButton();
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('aria-label')).toBe('Avisarme');
    click(btn!);
    await until(() => !notifyButton(), 'se va tras dar permiso');
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('no aparece con el permiso ya dado, negado o sin la API', async () => {
    installNotification('granted');
    await mount();
    expect(notifyButton()).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);

    installNotification('denied');
    await mount();
    expect(notifyButton()).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);

    vi.stubGlobal('Notification', undefined);
    await mount();
    expect(notifyButton()).toBeNull();
  });
});

describe('aviso del navegador', () => {
  it('con permiso, un pedido nuevo en vivo avisa una vez «Te espera: <tarea>» y su clic abre la ficha', async () => {
    const { shown } = installNotification('granted');
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    const api = await mount();
    // Los tres de la demo ya estaban en el snapshot: no avisan.
    expect(shown).toHaveLength(0);

    let id = '';
    act(() => void (id = api.block(P, 'whatsapp', 'review', '¿Te parece bien el texto del aviso?').id));
    await until(() => shown.length === 1, 'llega el aviso');
    expect(shown[0]!.title).toBe('Te espera: Avisos por WhatsApp');
    expect(shown[0]!.options?.tag).toBe(id);
    expect(shown[0]!.options?.body).toBe('Necesita tu revisión · Marketplace de reservas');
    expect(host.querySelector('.card.open')).toBeNull();

    act(() => shown[0]!.onclick!(new Event('click')));
    await settle(1);
    expect(window.focus).toHaveBeenCalled();
    expect(host.querySelector('.card.open h2')?.textContent).toBe('Avisos por WhatsApp');
    expect(scene.calls.filter(([n]) => n === 'focus').at(-1)?.[1][0]).toBe('whatsapp');

    // Mensajes, avances y otros eventos no avisan.
    act(() => api.message(P, 'pagos', 'Ya conecté la pasarela.'));
    await settle(2);
    expect(shown).toHaveLength(1);
  });

  it('con la página a la vista no avisa (ya están el aviso en pantalla y la cuenta); con la pestaña de fondo o sin foco, sí', async () => {
    const { shown } = installNotification('granted');
    viewing({ hidden: false, focused: true });
    const api = await mount();
    act(() => void api.block(P, 'whatsapp', 'review', '¿Te parece bien el texto del aviso?'));
    await until(() => document.title === '(4) Dagyard', 'sube la cuenta igual');
    await settle(2);
    expect(shown).toHaveLength(0);
    expect(text()).toContain('necesita tu revisión');

    // Pestaña de fondo.
    viewing({ hidden: true, focused: false });
    act(() => void api.block(P, 'reservas', 'decision', '¿Cuál?', { options: ['A', 'B'] }));
    await until(() => shown.length === 1, 'avisa con la pestaña de fondo');
    expect(shown[0]!.title).toBe('Te espera: Reservas y calendario');

    // Pestaña al frente pero la ventana sin foco (estás en otra app).
    viewing({ hidden: false, focused: false });
    act(() => void api.block(P, 'panel', 'decision', '¿Cuál?', { options: ['A', 'B'] }));
    await until(() => shown.length === 2, 'avisa sin foco');
    expect(shown[1]!.title).toBe('Te espera: Panel del proveedor');
  });

  it('lo que llega al volver a sincronizar no avisa (ya estaba), pero sí sube la cuenta', async () => {
    const { shown } = installNotification('granted');
    const api = (await mount(new Flaky({ storage: null }))) as Flaky;
    api.mute = true;
    act(() => void api.block(P, 'whatsapp', 'review', '¿Te parece bien el texto del aviso?'));
    await settle(2);
    expect(document.title).toBe('(3) Dagyard');
    api.mute = false;
    act(() => api.resync!());
    await until(() => document.title === '(4) Dagyard', 'resync trae el pedido');
    await settle(2);
    expect(shown).toHaveLength(0);
  });

  it('al resolverse, el aviso que quedó se cierra', async () => {
    const { shown } = installNotification('granted');
    const api = await mount();
    let id = '';
    act(() => void (id = api.block(P, 'whatsapp', 'decision', '¿Cuál?', { options: ['A', 'B'] }).id));
    await until(() => shown.length === 1, 'llega el aviso');
    act(() => void api.resolveBlocker(id, { kind: 'decision', option: 'A' }));
    await until(() => shown[0]!.closed, 'se cierra');
  });
});
