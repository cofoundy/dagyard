import { describe, expect, it } from 'vitest';
import { buildDag } from '../data/dag';
import { dagyardSnapshot, estresSnapshot, marketplaceSnapshot, renovacionSnapshot } from '../data/fixture';
import { toSceneGraph } from '../data/view';
import { layoutDag, timeTicks, type LayoutTask } from './dag-layout';

const NOW = Date.parse('2026-10-04T22:20:00Z');

function tasksOf(snap: ReturnType<typeof dagyardSnapshot>, now: number): { tasks: LayoutTask[]; now: number } {
  const g = toSceneGraph(buildDag(snap, now));
  return { tasks: g.nodes.map((n) => ({ id: n.id, born: n.born, parent: n.parent, children: n.children, status: n.status })), now: g.now };
}

describe('layoutDag', () => {
  it('x crece con el nacimiento: lo que nació después nunca queda a la izquierda', () => {
    const { tasks, now } = tasksOf(dagyardSnapshot(NOW), NOW);
    const L = layoutDag(tasks, { width: 1300, now });
    const sorted = [...tasks].sort((a, b) => a.born - b.born);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]!, b = sorted[i]!;
      if (b.born - a.born > 90e3) expect(L.x.get(b.id)!).toBeGreaterThanOrEqual(L.x.get(a.id)! - 1e-6);
    }
    expect(L.width).toBeLessThanOrEqual(1300 + 1);
    expect(L.nowX).toBeGreaterThanOrEqual(Math.max(...L.x.values()));
  });

  it('una tarea nunca cae en la columna de su origen', () => {
    const { tasks, now } = tasksOf(dagyardSnapshot(NOW), NOW);
    const L = layoutDag(tasks, { width: 1300, now });
    const born = new Map(tasks.map((t) => [t.id, t.born]));
    // en los datos reales un origen puede haberse registrado después (la intención antes que el pedido): ahí no aplica
    for (const t of tasks) if (t.parent && born.get(t.parent)! <= t.born) expect(L.x.get(t.id)!).toBeGreaterThan(L.x.get(t.parent)!);
  });

  it('todo nacido junto (proyecto sembrado de una vez): las generaciones llenan el ancho', () => {
    const { tasks, now } = tasksOf(renovacionSnapshot(NOW), NOW);
    expect(new Set(tasks.map((t) => t.born)).size).toBe(1);
    const L = layoutDag(tasks, { width: 1200, now });
    const xs = [...L.x.values()];
    expect(new Set(xs).size).toBeGreaterThan(3);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(400);
  });

  it('nacer algo no reordena las filas de lo que ya estaba', () => {
    const { tasks, now } = tasksOf(dagyardSnapshot(NOW), NOW);
    const L0 = layoutDag(tasks, { width: 1300, now });
    const kid: LayoutTask = { id: 'nueva', born: now, parent: 'gh-75', children: [], status: 'working' };
    const withKid = tasks.map((t) => (t.id === 'gh-75' ? { ...t, children: [...t.children, 'nueva'] } : t));
    const L1 = layoutDag([...withKid, kid], { width: 1300, now: now + 1000, prevRows: L0.row });
    let same = 0;
    for (const t of tasks) if (L1.row.get(t.id) === L0.row.get(t.id)) same++;
    expect(same / tasks.length).toBeGreaterThan(0.9);
  });

  it('aguanta los datos hostiles (185 tareas en 3 días) y pliega los silencios', () => {
    const t0 = performance.now();
    const { tasks, now } = tasksOf(estresSnapshot(NOW), NOW);
    const L = layoutDag(tasks, { width: 1300, now });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(L.x.size).toBe(tasks.length);
    expect(L.folds.length).toBeGreaterThan(0);
    expect(timeTicks(L).length).toBeGreaterThan(1);
  });

  it('la demo y un proyecto vacío', () => {
    const { tasks, now } = tasksOf(marketplaceSnapshot(NOW, 'en'), NOW);
    expect(layoutDag(tasks, { width: 1300, now }).x.size).toBe(tasks.length);
    const empty = layoutDag([], { width: 1000, now: NOW });
    expect(empty.x.size).toBe(0);
  });
});
