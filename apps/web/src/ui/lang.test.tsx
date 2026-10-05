// La interfaz en el idioma del navegador (#73): en-US → inglés, es-PE → español; el selector cambia sin recargar y
// lo que escribe un usuario (títulos, preguntas, mensajes, nombres de etapa) no se traduce.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESOLVED_BY_AGENT, RESOLVED_BY_YOU } from '../data/adapter';
import type { SessionApi } from '../data/session';
import type { Blocker, DagNode, Snapshot } from '../data/types';
import { initLang, lang, STORAGE_KEY } from '../i18n';
import { Card } from './Card';
import { Entry } from './Entry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api: SessionApi = { check: async () => false, login: async () => {}, logout: async () => {} } as unknown as SessionApi;

const node: DagNode = {
  id: 'pantalla-de-pago',
  stageId: 'diseno',
  title: 'Pantalla de pago',
  status: 'blocked',
  progress: 0.4,
  team: 'Diseño',
};

const blocker = (extra: Partial<Blocker> = {}): Blocker => ({
  id: 'b1',
  nodeId: node.id,
  kind: 'review',
  question: '¿Va así el pago en 3 pantallas?',
  options: ['Aprobar', 'Pedir cambios'],
  ...extra,
});

const snapshot = (blockers: Blocker[]): Snapshot => ({
  project: { id: 'p', name: 'Marketplace' },
  stages: [{ id: 'diseno', name: 'Diseño' }],
  nodes: [node],
  edges: [],
  blockers,
  messages: [{ id: 'm1', nodeId: node.id, from: 'Equipo de Diseño', text: 'Te dejé las 3 pantallas.', at: new Date().toISOString() }],
  seq: 1,
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  // el localStorage de Node tapa al de jsdom: uno en memoria, como un navegador limpio
  vi.stubGlobal('localStorage', memoryStorage());
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

/** Arranca como un navegador con esos idiomas, sin elección guardada. */
function browser(...languages: string[]) {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages);
  initLang();
}

const text = () => host.textContent ?? '';
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent);
const langButton = (code: string) => [...host.querySelectorAll<HTMLButtonElement>('.lang button')].find((b) => b.textContent === code)!;

function renderCard(blockers: Blocker[]) {
  const noop = () => {};
  act(() => root.render(<Card snapshot={snapshot(blockers)} node={node} onClose={noop} onFocus={noop} onResolve={async () => {}} />));
}

describe('idioma de la interfaz', () => {
  it('en-US: la entrada en inglés', () => {
    browser('en-US', 'en');
    act(() => root.render(<Entry api={api} onEnter={() => {}} />));
    expect(document.documentElement.lang).toBe('en');
    expect(host.querySelector('h1')?.textContent).toBe('Your factory, in one sky');
    expect(host.querySelector('input')?.placeholder).toBe('Paste your key');
    expect(buttons()).toContain('Sign in');
    expect(host.querySelector('.lang')?.getAttribute('aria-label')).toBe('Language');
  });

  it('es-PE: la entrada en español', () => {
    browser('es-PE', 'es');
    act(() => root.render(<Entry api={api} onEnter={() => {}} />));
    expect(document.documentElement.lang).toBe('es');
    expect(host.querySelector('h1')?.textContent).toBe('Tu fábrica, en un cielo');
    expect(host.querySelector('input')?.placeholder).toBe('Pega tu clave');
    expect(buttons()).toContain('Entrar');
  });

  it('en-US: la ficha en inglés, con el glosario; lo que escribió el equipo, tal cual', () => {
    browser('en-US');
    renderCard([blocker()]);
    expect(host.querySelector('.chip')?.textContent).toBe('Needs you');
    expect(host.querySelector('.block .kind')?.textContent).toBe('Needs your review');
    // las opciones por defecto del servidor se pintan en el idioma de la interfaz
    expect(buttons()).toEqual(expect.arrayContaining(['Approve', 'Request changes']));
    expect(text()).toContain('Built by the Diseño team.');
    expect(text()).toContain("What it's for");
    expect(text()).toContain('Why it exists');
    expect(text()).toContain('just now');
    // datos del usuario: sin traducir
    expect(text()).toContain('Pantalla de pago');
    expect(text()).toContain('¿Va así el pago en 3 pantallas?');
    expect(text()).toContain('Te dejé las 3 pantallas.');
    expect(text()).toMatch(/Born \d/);
    expect(host.querySelector('.x')?.getAttribute('aria-label')).toBe('Close');
  });

  it('es-PE: la ficha en español', () => {
    browser('es-PE');
    renderCard([blocker()]);
    expect(host.querySelector('.chip')?.textContent).toBe('Te espera');
    expect(host.querySelector('.block .kind')?.textContent).toBe('Necesita tu revisión');
    expect(buttons()).toEqual(expect.arrayContaining(['Aprobar', 'Pedir cambios']));
    expect(text()).toContain('La lleva el Equipo de Diseño.');
    expect(text()).toContain('Para qué existe');
    expect(text()).toContain('Por qué existe');
    expect(text()).toContain('hace un momento');
  });

  it('las opciones por defecto de un proyecto en inglés también se pintan en el idioma de quien mira (#77)', () => {
    browser('es-PE');
    renderCard([blocker({ options: ['Approve', 'Request changes'] })]);
    expect(buttons()).toEqual(expect.arrayContaining(['Aprobar', 'Pedir cambios']));
    expect(buttons()).not.toEqual(expect.arrayContaining(['Approve']));
  });

  it('opciones escritas por el equipo no se traducen', () => {
    browser('en-US');
    renderCard([blocker({ options: ['Va', 'Otra vuelta'] })]);
    expect(buttons()).toEqual(expect.arrayContaining(['Va', 'Otra vuelta']));
  });

  it('quién respondió: centinelas traducidos al pintar, un nombre tal cual', () => {
    const at = new Date().toISOString();
    const answered = (id: string, kind: Blocker['kind'], resolvedBy: string): Blocker =>
      blocker({ id, kind, resolvedBy, resolvedAt: at, resolution: 'Aprobado', options: kind === 'access' ? [] : ['Aprobar', 'Pedir cambios'] });
    browser('en-US');
    renderCard([answered('a', 'decision', RESOLVED_BY_YOU), answered('b', 'review', RESOLVED_BY_AGENT), answered('c', 'review', 'Lucía')]);
    const labs = [...host.querySelectorAll('.answer .lab')].map((e) => e.textContent);
    expect(labs).toEqual(['You decided · just now', 'An agent answered · just now', 'Lucía answered · just now']);
  });

  it('el selector cambia de idioma sin recargar, se recuerda y la ficha lo sigue', () => {
    browser('en-US');
    act(() =>
      root.render(
        <>
          <Entry api={api} onEnter={() => {}} />
          <Card snapshot={snapshot([blocker()])} node={node} onClose={() => {}} onFocus={() => {}} onResolve={async () => {}} />
        </>,
      ),
    );
    expect(langButton('EN').getAttribute('aria-pressed')).toBe('true');
    act(() => langButton('ES').click());
    expect(lang()).toBe('es');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('es');
    expect(document.documentElement.lang).toBe('es');
    expect(host.querySelector('h1')?.textContent).toBe('Tu fábrica, en un cielo');
    expect(host.querySelector('.chip')?.textContent).toBe('Te espera');
    expect(langButton('ES').getAttribute('aria-pressed')).toBe('true');
    // la próxima visita arranca en lo elegido aunque el navegador diga inglés
    browser('en-US');
    expect(lang()).toBe('es');
  });
});
