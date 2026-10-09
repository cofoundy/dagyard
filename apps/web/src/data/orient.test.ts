import { describe, expect, it } from 'vitest';
import { buildDag } from './dag';
import { dagyardHoySnapshot } from './fixture';
import { orientation } from './orient';

const NOW = Date.parse('2026-10-09T17:15:00Z');

describe('la brújula (#109) sobre el proyecto «dagyard» del 9 oct', () => {
  it('en curso son solo tareas: los pedidos y la meta vivos no cuentan', () => {
    const s = dagyardHoySnapshot(NOW);
    const o = orientation(buildDag(s, NOW), s);
    expect(o.waiting).toEqual([]);
    expect(o.moving.map((x) => x.task.id).sort()).toEqual(['gh-107', 'gh-108', 'gh-25']);
    // «Abrir el código» no tiene noticias desde el 4 oct: va después de lo que se mueve y se dice
    expect(o.moving.at(-1)).toMatchObject({ task: { id: 'gh-25' }, quiet: true });
  });

  it('lo que sigue: primero lo que puede arrancar; v1 espera a «Abrir el código»', () => {
    const s = dagyardHoySnapshot(NOW);
    const o = orientation(buildDag(s, NOW), s);
    expect(o.next.slice(0, 2).every((x) => x.ready)).toBe(true);
    expect(o.next.find((x) => x.task.id === 'v1')).toMatchObject({ ready: false, after: { id: 'gh-25' } });
  });

  it('con pedidos abiertos, la brújula nombra cada tarea que te espera', () => {
    const s = dagyardHoySnapshot(NOW, true);
    const o = orientation(buildDag(s, NOW), s);
    expect(o.waiting.map((x) => [x.task.id, x.blocker.kind])).toEqual(
      expect.arrayContaining([
        ['gh-9', 'decision'],
        ['gh-108', 'review'],
      ]),
    );
  });
});
