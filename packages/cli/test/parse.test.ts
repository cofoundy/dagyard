import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { humanTitle, normalizeStatus, parseTask } from '../src/tasks/parse.js';

const fixture = (repo: string, file: string) =>
  parseTask(file, readFileSync(join(__dirname, 'fixtures', repo, file), 'utf8'));

describe('front matter con deps (gateway)', () => {
  it('lee deps con comentario inline al final', () => {
    const t = fixture('gateway', 'T-027.md');
    expect(t.id).toBe('T-027');
    expect(t.status).toBe('done');
    expect(t.depRefs.join(' ')).toMatch(/T-024.*T-025/);
    expect(t.depRefs.join(' ')).not.toMatch(/Phase-5/);
    expect(t.title).toBe('Guest-checkout path (Pattern B) — address + RFC5322 email check for buy-once');
  });

  it('lee deps entre comillas y status con comentario', () => {
    expect(fixture('gateway', 'T-023.md').depRefs).toEqual(['["T-022"]']);
    const t = fixture('gateway', 'T-028.md');
    expect(t.status).toBe('done');
    expect(t.rawStatus).toBe('done');
  });

  it('deferred es Pendiente', () => {
    expect(fixture('gateway', 'T-021.md').status).toBe('pending');
  });
});

describe('front matter con blockedBy (pets)', () => {
  it('lee blockedBy y el título del primer #', () => {
    const t = fixture('pets', 'T-A02.md');
    expect(t.depRefs).toEqual(['[T-A01]']);
    expect(t.title).toBe('Calendario de disponibilidad');
    expect(t.team).toBe('frontend');
  });

  it('in-progress es En progreso', () => {
    expect(fixture('pets', 'T-SV-01.md').status).toBe('working');
  });

  it('sin front matter: título «ID · #n …» sin el id ni el número', () => {
    const t = fixture('pets', 'FIX-SEO.md');
    expect(t.id).toBe('FIX-SEO');
    expect(t.title).toBe('Perfiles sin vista previa al compartir');
  });
});

describe('basalt', () => {
  it('front matter con blockedBy: [] y título del cuerpo sin el prefijo T-xxx', () => {
    const t = fixture('basalt', 'T-314-A.md');
    expect(t.id).toBe('T-314-A');
    expect(t.depRefs).toEqual([]);
    expect(t.title).toBe('La RAMA reservar-vs-pagar, en el canal que llega a todo cliente');
  });

  it('front matter con phase y deps entre comillas', () => {
    const t = fixture('basalt', 'T-704.md');
    expect(t.phase).toBe('build');
    expect(t.depRefs.join(' ')).toMatch(/T-702.*T-703/);
  });

  it('sin front matter: viñetas en negrita (`- **status:** ready`, `- **blockedBy:** —`)', () => {
    const t = fixture('basalt', 'T-440.md');
    expect(t.id).toBe('T-440');
    expect(t.status).toBe('pending');
    expect(t.depRefs).toEqual([]);
  });

  it('sin front matter: «—» seguido de texto libre no es dependencia', () => {
    expect(fixture('basalt', 'T-458.md').depRefs).toEqual([]);
  });

  it('sin front matter: valores entre backticks y blockedBy con texto libre', () => {
    const t = fixture('basalt', 'T-606-M1.md');
    expect(t.status).toBe('blocked');
    expect(t.depRefs.join(' ')).toContain('T-606-instrument');
    expect(t.depRefs.join(' ')).not.toContain('ROJO');
  });

  it('línea con varios campos separados por «·» y «Task L1 — …»', () => {
    const l1 = fixture('basalt', 'L1-shared-cart-backend.md');
    expect(l1.id).toBe('L1');
    expect(l1.aliases).toContain('L1-shared-cart-backend');
    expect(l1.team).toBe('backend');
    expect(l1.depRefs).toEqual([]);
    expect(l1.title).toBe('Shared-cart backend (CORNERSTONE, payment-sensitive)');
    const l3 = fixture('basalt', 'L3-switcher-navbar-kill.md');
    expect(l3.depRefs.join(' ')).toMatch(/L1.*L2/);
  });

  it('status «blocked-by T-600 (…)» aporta la dependencia', () => {
    const t = fixture('basalt', 'T-599.md');
    expect(t.status).toBe('blocked');
    expect(t.depRefs.join(' ')).toContain('T-600');
    expect(t.title).toBe('El cliente puede dejar una nota en su pedido');
  });

  it('«status: blocked → **blockedBy: T-902**» en la misma línea', () => {
    const t = fixture('basalt', 'T-903.md');
    expect(t.status).toBe('blocked');
    expect(t.depRefs.join(' ')).toContain('T-902');
  });

  it('metadata dentro de un bloque ```yaml', () => {
    const t = fixture('basalt', 'T-528.md');
    expect(t.id).toBe('T-528');
    expect(t.status).toBe('pending');
    expect(t.team).toBe('lint-parity');
  });

  it('`**role:** brand · **status:** ready · **blockedBy:** T-646 (same files)`', () => {
    const t = fixture('basalt', 'T-647.md');
    expect(t.team).toBe('pricing');
    expect(t.status).toBe('pending');
    expect(t.depRefs).toEqual(['T-646']);
  });

  it('completed es Lista', () => {
    expect(fixture('basalt', 'T-640.md').status).toBe('done');
  });
});

describe('normalizeStatus', () => {
  it.each([
    ['ready', 'pending'],
    ['deferred', 'pending'],
    ['blocked', 'blocked'],
    ['blocked-by', 'blocked'],
    ['done', 'done'],
    ['completed', 'done'],
    ['in-progress', 'working'],
    ['algo-raro', 'pending'],
    [null, 'pending'],
  ])('%s → %s', (raw, want) => {
    expect(normalizeStatus(raw)).toBe(want);
  });
});

describe('humanTitle (D10)', () => {
  it('quita ids T-xxx y referencias (#123), no rompe nombres de código', () => {
    expect(humanTitle('Pagos (#599) tras T-402', 'x')).toBe('Pagos tras');
    expect(humanTitle('sweep.sh + lane prompts', 'x')).toBe('sweep.sh + lane prompts');
    expect(humanTitle('the `var()` decider', 'x')).toBe('The var() decider');
  });

  it('recorta a 120 caracteres en una sola línea', () => {
    const t = humanTitle('palabra '.repeat(40), 'x');
    expect(t.length).toBeLessThanOrEqual(120);
    expect(t).not.toContain('\n');
    expect(t.endsWith('…')).toBe(true);
  });
});
