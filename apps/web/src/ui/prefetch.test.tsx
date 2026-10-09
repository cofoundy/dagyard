// #112: con `?p=`, el plan y la lista se piden junto con la sesión (no en serie), y sin sesión no se pinta nada del
// proyecto. Aquí corre el HttpApi de verdad sobre un fetch que retiene cada respuesta hasta que el test la suelta.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateSkyOptions } from '../scene/contract';
import type { WireSnapshot } from '../data/adapter';
import { HttpApi } from '../data/http';
import { App } from './App';
import { setLang } from '../i18n';

beforeEach(() => setLang('es'));

const scene = vi.hoisted(() => ({ graphs: [] as unknown[] }));
vi.mock('../scene', () => ({
  createSky: (_o: CreateSkyOptions) => ({
    setGraph: (g: unknown) => void scene.graphs.push(g),
    pulse: () => {},
    overview: () => {},
    replay: () => {},
    mark: () => {},
    setCardArea: () => {},
    focus: () => {},
    setSafeArea: () => {},
    dispose: () => {},
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------------------------------------------ dobles */

const T = '2026-10-09T06:00:00.000Z';
const NAME = 'Plan secreto de Dagyard';
const snap: WireSnapshot = {
  project: { id: 'dagyard', name: NAME, lang: 'es', stages: [{ id: 'diseno', name: 'Diseño' }], createdAt: T, updatedAt: T },
  nodes: [
    {
      id: 'gh-112', projectId: 'dagyard', stage: 'diseno', title: 'Cargar el plan en paralelo', status: 'running', progress: 0,
      team: 'Web', goal: null, reportUrl: null, link: null, createdAt: T, updatedAt: T,
    },
  ],
  edges: [],
  blockers: [],
  messages: [],
  seq: 3,
} as unknown as WireSnapshot;
const list = { projects: [{ id: 'dagyard', name: NAME }] };

/** Cada llamada queda pendiente hasta `release(ruta)`; así se ve qué arrancó antes de que algo responda. */
function heldFetch(routes: Record<string, () => Response>) {
  const started: string[] = [];
  const held: Array<{ key: string; go: () => void }> = [];
  const fn = vi.fn((url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    started.push(key);
    return new Promise<Response>((resolve) => {
      held.push({
        key,
        go: () => resolve(routes[key]?.() ?? new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 })),
      });
    });
  });
  const release = (key: string) => {
    for (const h of held.filter((x) => x.key === key)) {
      held.splice(held.indexOf(h), 1);
      h.go();
    }
  };
  const releaseAll = () => {
    for (const h of held.splice(0)) h.go();
  };
  return { fn: fn as unknown as typeof fetch, started, release, releaseAll };
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

class QuietWS {
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
}

/* ------------------------------------------------------------------ montaje */

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  scene.graphs = [];
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} });
  window.history.replaceState(null, '', '/?p=dagyard');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
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
const painted = () => scene.graphs.some((g) => ((g as { nodes?: unknown[] }).nodes?.length ?? 0) > 0);
const count = (started: string[], key: string) => started.filter((k) => k === key).length;

function mount(f: ReturnType<typeof heldFetch>) {
  const api = new HttpApi({ fetch: f.fn, WebSocket: QuietWS as unknown as typeof WebSocket, origin: 'https://dagyard.test' });
  act(() => root.render(<App api={api} />));
}

const ME = 'GET /api/me';
const LIST = 'GET /api/projects';
const PLAN = 'GET /api/projects/dagyard';

/* ------------------------------------------------------------------ casos */

describe('carga del plan con ?p= (#112)', () => {
  it('pide la sesión, la lista y el plan a la vez, y cada uno una sola vez', async () => {
    const f = heldFetch({ [ME]: json({ ok: true }), [LIST]: json(list), [PLAN]: json(snap) });
    mount(f);
    await settle();
    // Nada respondió todavía y ya arrancaron las tres.
    expect(f.started).toEqual(expect.arrayContaining([ME, LIST, PLAN]));
    expect(f.started.slice(0, 3).sort()).toEqual([LIST, PLAN, ME].sort());
    expect(painted()).toBe(false);

    // El plan y la lista llegan antes que la sesión: siguen sin pintarse hasta que la sesión responde.
    f.release(PLAN);
    f.release(LIST);
    await settle();
    expect(painted()).toBe(false);
    expect(text()).not.toContain(NAME);

    f.release(ME);
    await until(painted, 'pinta el plan');
    expect(text()).toContain(NAME);
    expect(count(f.started, LIST)).toBe(1);
    expect(count(f.started, PLAN)).toBe(1);
  });

  it('sin sesión muestra la entrada, no pinta nada del proyecto y tras la clave lo pide de nuevo', async () => {
    // Peor caso: el plan llega aunque la sesión diga que no. Igual se descarta.
    const f = heldFetch({
      [ME]: json({ error: { code: 'unauthorized' } }, 401),
      [LIST]: json(list),
      [PLAN]: json(snap),
      'POST /api/session': () => new Response(null, { status: 204 }),
    });
    mount(f);
    await settle();
    expect(f.started).toEqual(expect.arrayContaining([ME, LIST, PLAN]));
    f.releaseAll();
    await until(() => !!host.querySelector('#clave'), 'muestra la entrada');
    await settle();
    expect(painted()).toBe(false);
    expect(text()).not.toContain(NAME);

    // Con la clave, la lista y el plan se vuelven a pedir con la sesión nueva: lo adelantado no se reusa.
    const input = host.querySelector<HTMLInputElement>('#clave')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'clave-buena');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => void host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    for (let i = 0; i < 20 && !painted(); i++) {
      f.releaseAll();
      await settle(1);
    }
    await until(painted, 'pinta el plan tras entrar');
    expect(count(f.started, LIST)).toBe(2);
    expect(count(f.started, PLAN)).toBe(2);
  });

  it('sin ?p= no adelanta nada: la sesión va primero, como antes', async () => {
    window.history.replaceState(null, '', '/');
    const f = heldFetch({ [ME]: json({ ok: true }), [LIST]: json(list), [PLAN]: json(snap) });
    mount(f);
    await settle();
    expect(f.started).toEqual([ME]);
    f.releaseAll();
  });
});
