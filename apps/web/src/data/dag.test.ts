import { describe, expect, it } from 'vitest';
import { buildDag, chain, dagCounts, goalOf, purposeless, relatedOf } from './dag';
import { dagyardSnapshot, estresSnapshot, marketplaceSnapshot } from './fixture';
import { reduce } from './reduce';
import type { DagNode, Snapshot } from './types';

const NOW = Date.parse('2026-10-04T22:20:00Z');

const node = (id: string, extra: Partial<DagNode> = {}): DagNode => ({ id, stageId: 's', title: id, status: 'pending', progress: 0, ...extra });
const snap = (nodes: DagNode[], extra: Partial<Snapshot> = {}): Snapshot => ({
  project: { id: 'p', name: 'P' },
  stages: [{ id: 's', name: 'S' }],
  nodes,
  edges: [],
  blockers: [],
  messages: [],
  seq: 0,
  ...extra,
});

describe('buildDag con #90 (el proyecto real del 4 oct, ya migrado)', () => {
  const m = buildDag(dagyardSnapshot(NOW), NOW);

  it('lee orígenes, meta y pedidos tal cual; nada se deduce', () => {
    expect(m.derived).toBe(false);
    expect(m.hasGoals).toBe(true);
    expect(m.edges.some((e) => e.kind === 'origin')).toBe(true);
    const req = m.tasks.find((t) => t.kind === 'request' && t.quote);
    expect(req?.quoteBy).toBe('André');
    expect(m.tasks.every((t) => t.origins.every((o) => !o.derived))).toBe(true);
  });

  it('toda tarea llega a la meta por «nació de»: ningún cabo suelto', () => {
    expect(dagCounts(m).loose).toBe(0);
    expect(goalOf(m, 'gh-75')?.id).toBe('goal-fabrica');
    const c = chain(m, 'gh-75');
    expect(c.at(-1)?.id).toBe('gh-75');
    expect(c.length).toBeGreaterThan(1);
  });

  it('el porqué de un origen viaja con él (datos: sin traducir)', () => {
    const t = m.byId.get('gh-9')!;
    expect(t.origins[0]).toMatchObject({ from: 'gh-2', why: 'el token de Cloudflare no tenía permiso de D1' });
  });
});

describe('buildDag sin #90 (servidor anterior)', () => {
  it('nació de su dependencia más antigua; esa línea no se dibuja dos veces', () => {
    const s = marketplaceSnapshot(NOW, 'es');
    expect(s.origins).toBeUndefined();
    const m = buildDag(s, NOW);
    expect(m.derived).toBe(true);
    expect(m.edges.every((e) => e.kind === 'needs')).toBe(true);
    const withDeps = m.tasks.filter((t) => t.needs.length);
    expect(withDeps.length).toBeGreaterThan(0);
    for (const t of withDeps) {
      expect(t.origins).toHaveLength(1);
      expect(t.origins[0]!.derived).toBe(true);
      expect(t.needs).toContain(t.origins[0]!.from);
    }
  });

  it('sin metas, cabo suelto = terminada y sin ninguna relación', () => {
    const m = buildDag(snap([node('a', { status: 'done' }), node('b', { status: 'done' }), node('c')], { edges: [{ from: 'b', to: 'c' }] }), NOW);
    expect(m.tasks.filter((t) => t.loose).map((t) => t.id)).toEqual(['a']);
  });

  it('sin fecha, se ubica junto a lo más antiguo (estable entre eventos)', () => {
    const m = buildDag(snap([node('a', { bornAt: '2026-10-04T10:00:00Z' }), node('b')]), NOW);
    expect(m.byId.get('b')!.born).toBe(Date.parse('2026-10-04T10:00:00Z'));
    expect(m.byId.get('b')!.bornKnown).toBe(false);
  });
});

describe('propósito (#90)', () => {
  it('purposeless: sin camino por «nació de» a una meta', () => {
    const nodes = [{ id: 'g', kind: 'goal' as const }, { id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(purposeless(nodes, [{ from: 'g', to: 'a' }, { from: 'a', to: 'b' }])).toEqual(['c']);
  });

  it('lo cerrado con motivo no se marca como suelto; lo abierto sin meta sí', () => {
    const m = buildDag(
      snap(
        [
          node('g', { kind: 'goal', status: 'working' }),
          node('a', { status: 'done', closedAs: 'dropped', closedReason: 'no hacía falta' }),
          node('b'),
          node('c'),
        ],
        { origins: [{ from: 'g', to: 'c' }] },
      ),
      NOW,
    );
    expect(m.tasks.filter((t) => t.loose).map((t) => t.id)).toEqual(['b']);
    expect(m.byId.get('a')!.closedAs).toBe('dropped');
    expect(relatedOf(m, 'g')).toEqual(new Set(['g', 'c']));
  });

  it('aguanta los datos hostiles', () => {
    const m = buildDag(estresSnapshot(NOW), NOW);
    expect(m.tasks.length).toBe(185);
    expect(dagCounts(m).waiting).toBeGreaterThan(0);
  });
});

describe('reduce: «nació de» en vivo', () => {
  it('agrega, reemplaza y quita orígenes; al quitar un nodo se van sus orígenes', () => {
    let s = snap([node('a'), node('b')], { origins: [] });
    s = reduce(s, { seq: 1, type: 'origin.added', origin: { from: 'a', to: 'b', why: 'x' } });
    s = reduce(s, { seq: 2, type: 'origin.added', origin: { from: 'a', to: 'b', why: 'y' } });
    expect(s.origins).toEqual([{ from: 'a', to: 'b', why: 'y' }]);
    s = reduce(s, { seq: 3, type: 'node.removed', nodeId: 'a' });
    expect(s.origins).toEqual([]);
    s = reduce(s, { seq: 4, type: 'origin.added', origin: { from: 'b', to: 'b' } });
    s = reduce(s, { seq: 5, type: 'origin.removed', origin: { from: 'b', to: 'b' } });
    expect(s.origins).toEqual([]);
  });
});
