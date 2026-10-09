import { describe, expect, it } from 'vitest';
import { buildDag, type DagTask } from './dag';
import { dagyardHoySnapshot, estresSnapshot } from './fixture';
import { orientation, ROWS, ROWS_MAX, rowsShown, stateKey, twinTags } from './orient';

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

describe('filas de la brújula: sin scroll, tope 8 y el resto a la búsqueda', () => {
  it('plegado muestra 3 y «+N más» cuenta el resto', () => {
    expect(rowsShown(14, false)).toEqual({ shown: 3, more: 11, rest: 0 });
    expect(rowsShown(2, false)).toEqual({ shown: 2, more: 0, rest: 0 });
  });

  it('desplegado crece hasta 8 y lo que no cabe se busca por nombre', () => {
    expect(rowsShown(14, true)).toEqual({ shown: ROWS_MAX, more: 0, rest: 6 });
    expect(rowsShown(5, true)).toEqual({ shown: 5, more: 0, rest: 0 });
  });

  it('en una pantalla baja el tope baja (nunca de 1) y el resto también va a la búsqueda', () => {
    expect(rowsShown(14, true, ROWS, 5)).toEqual({ shown: 5, more: 0, rest: 9 });
    expect(rowsShown(14, true, ROWS, 0)).toEqual({ shown: 1, more: 0, rest: 13 });
  });

  it('plegado a su cabecera (celular, o el otro grupo abierto): ninguna fila, todo en «+N más»', () => {
    expect(rowsShown(4, false, 0)).toEqual({ shown: 0, more: 4, rest: 0 });
  });
});

describe('títulos repetidos: un distintivo corto, solo cuando se repiten', () => {
  const task = (id: string, title: string, born = 0) => ({ id, title, born }) as DagTask;
  const at = (t: DagTask) => `t${t.born}`;

  it('un título único no lleva nada', () => {
    expect(twinTags([task('a', 'Pagos'), task('b', 'Modo oscuro')], at).size).toBe(0);
  });

  it('con número de issue, el número; sin él, la hora en que nació', () => {
    const tags = twinTags([task('gh-109', 'Calendario compartido'), task('gh-31', 'calendario compartido '), task('x', 'Pagos', 1), task('y', 'Pagos', 2)], at);
    expect(tags.get('gh-109')).toBe('#109');
    expect(tags.get('gh-31')).toBe('#31');
    expect(tags.get('x')).toBe('t1');
    expect(tags.get('y')).toBe('t2');
  });

  it('si la hora también choca, su orden; y la misma tarea en dos grupos no cuenta como repetida', () => {
    const a = task('a', 'X', 5);
    const tags = twinTags([a, task('b', 'X', 5), a], at);
    expect([tags.get('a'), tags.get('b')]).toEqual(['t5 · 1', 't5 · 2']);
    expect(twinTags([a, a], at).size).toBe(0);
  });

  it('en los datos hostiles, «Calendario compartido» te espera y está en curso: cada fila lleva su distintivo', () => {
    const s = estresSnapshot(NOW);
    const o = orientation(buildDag(s, NOW), s);
    const all = [...o.waiting, ...o.moving, ...o.next].map((x) => x.task);
    const tags = twinTags(all, at);
    const cal = all.filter((x) => x.title === 'Calendario compartido');
    expect(cal.length).toBeGreaterThan(1);
    expect(new Set(cal.map((x) => tags.get(x.id))).size).toBe(cal.length);
  });
});

describe('una palabra por estado (#109): la de la brújula, también en la ficha y en el cielo', () => {
  it('una tarea en curso quieta dice «Sin noticias»; con noticias, «En curso»', () => {
    expect(stateKey({ status: 'working', kind: 'task' }, true)).toBe('status.quiet');
    expect(stateKey({ status: 'working', kind: 'task' })).toBe('status.working');
  });

  it('un pedido, una meta o un trabajo continuo abiertos no son trabajo en curso: se nombran por lo que son', () => {
    expect(stateKey({ status: 'working', kind: 'request' })).toBe('kind.request');
    expect(stateKey({ status: 'working', kind: 'goal' }, true)).toBe('kind.goal');
    expect(stateKey({ status: 'working', kind: 'stream' })).toBe('kind.stream');
  });

  it('lo demás, por su estado', () => {
    expect(stateKey({ status: 'blocked', kind: 'task' })).toBe('status.blocked');
    expect(stateKey({ status: 'pending', kind: 'task' }, true)).toBe('status.pending');
    expect(stateKey({ status: 'done', kind: 'request' })).toBe('status.done');
  });
});
