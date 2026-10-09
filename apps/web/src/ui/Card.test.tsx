import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DagNode, Snapshot } from '../data/types';
import { Card } from './Card';
import { setLang } from '../i18n';

// estos tests leen la interfaz en español; jsdom diría en-US (#73)
beforeEach(() => setLang('es'));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ISSUE = 'https://github.com/cofoundy/dagyard/issues/45';
const REPORT = 'https://basalt.cofoundy.ai/r/1';
const PR = 'https://github.com/cofoundy/dagyard/pull/50';

const node = (extra: Partial<DagNode> = {}): DagNode => ({
  id: 'sincronizar-issues',
  stageId: 'construccion',
  title: 'Sincronizar issues',
  status: 'done',
  progress: 1,
  team: 'Construcción',
  ...extra,
});

const snapshot = (n: DagNode): Snapshot => ({
  project: { id: 'p', name: 'Dagyard' },
  stages: [{ id: 'construccion', name: 'Construcción' }],
  nodes: [n],
  edges: [],
  blockers: [],
  messages: [],
  seq: 1,
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(n: DagNode) {
  const noop = () => {};
  act(() => root.render(<Card snapshot={snapshot(n)} node={n} onClose={noop} onFocus={noop} onResolve={async () => {}} />));
}
const links = () => [...host.querySelectorAll<HTMLAnchorElement>('a.report')];

describe('ficha: detalle técnico', () => {
  it('con link, ofrece «Detalle técnico» debajo del informe, sin mostrar la URL', () => {
    render(node({ reportUrl: REPORT, link: ISSUE }));
    const [report, technical] = links();
    expect(report?.textContent).toBe('Informe en BasaltAbrir ↗');
    expect(technical?.textContent).toBe('Detalle técnicoAbrir ↗');
    expect(technical?.href).toBe(ISSUE);
    expect(technical?.target).toBe('_blank');
    expect(technical?.rel).toBe('noopener noreferrer');
    expect(host.textContent).not.toMatch(/github|https?:/);
  });

  it('sin informe, el detalle técnico aparece solo', () => {
    render(node({ link: ISSUE }));
    expect(links().map((a) => a.textContent)).toEqual(['Detalle técnicoAbrir ↗']);
  });

  it('sin link, no hay detalle técnico', () => {
    render(node({ reportUrl: REPORT }));
    expect(links().map((a) => a.textContent)).toEqual(['Informe en BasaltAbrir ↗']);
  });
});

describe('ficha: rótulo del informe según dónde vive', () => {
  const inline = () => [...host.querySelectorAll<HTMLAnchorElement>('a.inline-report')];
  const withMessage = (reportUrl: string) => {
    const n = node({ reportUrl });
    const s = snapshot(n);
    s.messages = [{ id: 'm_1', nodeId: n.id, from: 'Equipo de Construcción', text: 'Listo.', reportUrl, at: '2026-10-04T12:00:00Z' }];
    const noop = () => {};
    act(() => root.render(<Card snapshot={s} node={n} onClose={noop} onFocus={noop} onResolve={async () => {}} />));
  };

  it('un informe que es un PR de GitHub no dice «Basalt», ni en la ficha ni en el mensaje', () => {
    withMessage(PR);
    expect(links().map((a) => a.textContent)).toEqual(['InformeAbrir ↗']);
    expect(inline().map((a) => a.textContent)).toEqual(['Informe ↗']);
    expect(host.textContent).not.toMatch(/Basalt/);
  });

  it('un informe en Basalt conserva «Informe en Basalt», también en un subdominio', () => {
    withMessage('https://dagyard.basalt.cofoundy.ai/r/1');
    expect(links().map((a) => a.textContent)).toEqual(['Informe en BasaltAbrir ↗']);
    expect(inline().map((a) => a.textContent)).toEqual(['Informe en Basalt ↗']);
  });

  it('un host que solo se parece a Basalt, o una URL inválida, dice «Informe»', () => {
    for (const url of ['https://basalt.cofoundy.ai.evil.com/r/1', 'https://notbasalt.cofoundy.ai/r/1', 'https://basalt.example/r/1', 'no es una url']) {
      render(node({ reportUrl: url }));
      expect(links().map((a) => a.textContent)).toEqual(['InformeAbrir ↗']);
    }
  });
});

describe('ficha: una tarea suelta (#90)', () => {
  const meta: DagNode = { id: 'meta', stageId: 'construccion', title: 'Dagyard v1', status: 'working', progress: 0, kind: 'goal' };
  const suelta = node({ id: 'suelta', title: 'Algo sin dueño', status: 'pending', progress: 0 });
  const conMeta: Snapshot = { ...snapshot(suelta), nodes: [meta, suelta], origins: [] };

  it('ofrece atarla a una meta o dejarla ir, y manda lo elegido', async () => {
    const calls: string[] = [];
    act(() =>
      root.render(
        <Card
          snapshot={conMeta}
          node={suelta}
          onClose={() => {}}
          onFocus={() => {}}
          onResolve={async () => {}}
          onLink={async (from, to) => void calls.push(`link ${from}→${to}`)}
          onDrop={async (id, why) => void calls.push(`drop ${id}: ${why}`)}
        />,
      ),
    );
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.loose-actions button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Dagyard v1', 'Dejarla ir']);
    await act(async () => buttons[0]!.click());
    await act(async () => buttons[1]!.click());
    expect(calls).toEqual(['link meta→suelta', 'drop suelta: Nadie la necesitaba']);
  });

  it('una tarea cerrada como descartada no ofrece nada', () => {
    const cerrada = { ...suelta, status: 'done' as const, closedAs: 'dropped' as const, closedReason: 'no entra' };
    act(() =>
      root.render(
        <Card snapshot={{ ...conMeta, nodes: [meta, cerrada] }} node={cerrada} onClose={() => {}} onFocus={() => {}} onResolve={async () => {}} onLink={async () => {}} onDrop={async () => {}} />,
      ),
    );
    expect(host.querySelector('.loose-actions')).toBeNull();
    expect(host.textContent).not.toMatch(/Lista/);
    expect(host.textContent).toMatch(/no entra/);
  });
});

/** Una ficha con varias tareas en el plan (las otras se ven como chips). */
function renderIn(s: Snapshot, id: string) {
  const noop = () => {};
  const n = s.nodes.find((x) => x.id === id)!;
  act(() => root.render(<Card snapshot={s} node={n} onClose={noop} onFocus={noop} onResolve={async () => {}} />));
}
const plan = (nodes: DagNode[], edges: Snapshot['edges'] = [], blockers: Snapshot['blockers'] = []): Snapshot => ({
  ...snapshot(nodes[0]!),
  nodes,
  edges,
  blockers,
});
const at = (h: number) => new Date(Date.UTC(2026, 9, 9, h)).toISOString();

describe('ficha: lo que todavía necesita (#115)', () => {
  it('primero lo abierto (lo que la brújula nombra «después de»); lo cerrado después, con ✓ y marcado como listo', () => {
    const s = plan(
      [
        node({ id: 'v1', title: 'v1', status: 'pending', bornAt: at(9) }),
        node({ id: 'a', title: 'Diseñar la entrada', status: 'done', bornAt: at(1) }),
        node({ id: 'b', title: 'Abrir el código', status: 'working', bornAt: at(2) }),
        node({ id: 'c', title: 'Sincronizar issues', status: 'done', bornAt: at(3) }),
        node({ id: 'd', title: 'Avisos', status: 'done', bornAt: at(4) }),
      ],
      ['a', 'b', 'c', 'd'].map((from) => ({ from, to: 'v1' })),
    );
    renderIn(s, 'v1');
    const chips = [...host.querySelectorAll<HTMLButtonElement>('.needs .kids button')];
    expect(chips.map((b) => b.title)).toEqual(['Abrir el código', 'Diseñar la entrada', 'Sincronizar issues', 'Avisos']);
    expect(chips.map((b) => b.classList.contains('met'))).toEqual([false, true, true, true]);
    expect(chips[0]!.textContent).not.toContain('✓');
    for (const b of chips.slice(1)) expect(b.textContent).toMatch(/^✓.* · Lista$/);
  });

  it('lo que se dejó de lado no dice «Lista»: va tenue con – y su motivo', () => {
    const s = plan(
      [
        node({ id: 'v1', title: 'v1', status: 'pending' }),
        node({ id: 'x', title: 'Descartada', status: 'done', closedAs: 'dropped' }),
        node({ id: 'vieja', title: 'Vieja', status: 'done', closedAs: 'replaced', replacedBy: 'nueva' }),
        node({ id: 'nueva', title: 'Nueva', status: 'done', closedAs: 'dropped' }),
      ],
      [{ from: 'x', to: 'v1' }, { from: 'vieja', to: 'v1' }],
    );
    renderIn(s, 'v1');
    const chips = [...host.querySelectorAll<HTMLButtonElement>('.needs .kids button')];
    expect(chips.map((b) => b.textContent)).toEqual(['–Descartada · Descartada', '–Vieja · Descartada']);
    expect(chips.every((b) => b.classList.contains('met'))).toBe(true);
  });

  it('una necesidad reemplazada sigue abierta mientras lo esté su reemplazo', () => {
    const s = plan(
      [
        node({ id: 'v1', title: 'v1', status: 'pending' }),
        node({ id: 'vieja', title: 'Vieja', status: 'done', closedAs: 'replaced', replacedBy: 'nueva' }),
        node({ id: 'nueva', title: 'Nueva', status: 'working' }),
      ],
      [{ from: 'vieja', to: 'v1' }],
    );
    renderIn(s, 'v1');
    const chip = host.querySelector<HTMLButtonElement>('.needs .kids button')!;
    expect(chip.title).toBe('Vieja');
    expect(chip.classList.contains('met')).toBe(false);
  });
});

describe('ficha: pedidos largos y ajenos (#117)', () => {
  const Q = '¿' + 'Una pregunta larguísima sobre las facturas en PDF '.repeat(6) + 'REFERENCIA-SIN-ESPACIOS-'.repeat(2) + '?';
  const OPT = 'Opción con un texto de ciento veinte caracteres para ver cómo se parte dentro de la ficha sin salirse del borde ni tapar';

  it('una pregunta de ~300 caracteres y opciones de ~120 se muestran enteras', () => {
    expect(Q.length).toBeGreaterThanOrEqual(300);
    expect(OPT.length).toBeGreaterThanOrEqual(120);
    const s = plan(
      [node({ id: 'f', title: 'Facturas en PDF', status: 'blocked' })],
      [],
      [{ id: 'b1', nodeId: 'f', kind: 'decision', question: Q, options: [OPT, 'Opción dos'] }],
    );
    renderIn(s, 'f');
    expect(host.querySelector('.block p')?.textContent).toBe(Q);
    expect([...host.querySelectorAll('.block .opts button')].map((b) => b.textContent)).toEqual([OPT, 'Opción dos']);
  });

  it('las reglas de la hoja que las parten siguen ahí (jsdom no mide; el navegador real se verifica aparte)', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'styles.css'), 'utf8');
    const rule = (sel: string) => css.split('\n').find((l) => l.startsWith(`${sel} {`)) ?? '';
    expect(rule('.block p')).toContain('overflow-wrap: anywhere');
    expect(rule('.go')).toContain('overflow-wrap: anywhere');
    expect(rule('.go')).toContain('min-width: 0');
    expect(rule('.block .opts')).toContain('minmax(0, 1fr)');
    expect(rule('.card h2')).toContain('overflow-wrap: anywhere');
  });

  it('cada ficha muestra solo los pedidos de su tarea', () => {
    const s = plan(
      [node({ id: 'f', title: 'Facturas', status: 'blocked' }), node({ id: 'p', title: 'Pagos', status: 'blocked' })],
      [],
      [
        { id: 'bp', nodeId: 'p', kind: 'decision', question: '¿Tarjeta o transferencia?', options: ['Tarjeta'] },
        { id: 'bf', nodeId: 'f', kind: 'decision', question: '¿Detalle o resumen?', options: ['Detalle'] },
        { id: 'bp2', nodeId: 'p', kind: 'review', question: '¿Revisas el flujo de pagos?', options: [], resolvedAt: at(5), resolution: 'ok' },
      ],
    );
    renderIn(s, 'f');
    expect(host.textContent).toContain('¿Detalle o resumen?');
    expect(host.textContent).not.toMatch(/Tarjeta|pagos/);
  });
});

describe('ficha: el foco (#116)', () => {
  it('al abrirse entra en la ficha; al cerrarse vuelve a lo que la abrió', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const n = node({ id: 'f', title: 'Facturas' });
    const s = plan([n, node({ id: 'g', title: 'Pagos' })], [{ from: 'g', to: 'f' }]);
    const noop = () => {};
    const show = (x: DagNode | undefined) =>
      act(() => root.render(<Card snapshot={s} node={x} onClose={noop} onFocus={noop} onResolve={async () => {}} />));
    show(n);
    expect(document.activeElement?.tagName).toBe('H2');
    expect(host.contains(document.activeElement)).toBe(true);
    // pasar a otra tarea desde la propia ficha no cambia a dónde se vuelve
    show(s.nodes[1]);
    expect(document.activeElement?.textContent).toBe('Pagos');
    show(undefined);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('si al cerrar el foco ya está en otra parte, no se lo roba', () => {
    const opener = document.createElement('button');
    const elsewhere = document.createElement('input');
    document.body.append(opener, elsewhere);
    opener.focus();
    const n = node({ id: 'f', title: 'Facturas' });
    const noop = () => {};
    const show = (x: DagNode | undefined) =>
      act(() => root.render(<Card snapshot={snapshot(n)} node={x} onClose={noop} onFocus={noop} onResolve={async () => {}} />));
    show(n);
    elsewhere.focus();
    show(undefined);
    expect(document.activeElement).toBe(elsewhere);
    opener.remove();
    elsewhere.remove();
  });
});
