import { describe, expect, it } from 'vitest';
import { buildDag } from '../data/dag';
import { estresSnapshot } from '../data/fixture';
import { toSceneGraph, touchedOf } from '../data/view';
import type { SceneNode } from './contract';
import { NOW_EDGE_MAX, nowEdge } from './now-edge';

const NOW = Date.parse('2026-10-09T17:00:00Z');
const H = 3600e3;

const node = (id: string, status: SceneNode['status'], touched: number, kind: SceneNode['kind'] = 'task'): SceneNode => ({
  id, title: id, status, kind, born: touched - H, touched, closedAs: null, loose: false, parent: null, children: [],
});

describe('nowEdge (#107)', () => {
  it('«dagyard» del 9 oct: los pedidos y la meta quietos desde hace días se agrupan; se nombra lo que cambió', () => {
    const quiet = Array.from({ length: 11 }, (_, i) => node(`req-${i}`, 'working', NOW - 5 * 24 * H + i * 1000, i ? 'request' : 'goal'));
    const nodes = [...quiet, node('gh-25', 'working', NOW - 5 * 24 * H), node('gh-107', 'working', NOW - 5 * 60e3), node('gh-108', 'working', NOW - 4 * 60e3), node('gh-1', 'done', NOW)];
    const { named, grouped } = nowEdge(nodes, { now: NOW });
    expect(named).toEqual(['gh-108', 'gh-107']);
    expect(grouped).toHaveLength(12);
    expect(grouped).not.toContain('gh-1');
  });

  it('lo que te espera se nombra aunque esté quieto, y va primero', () => {
    const { named } = nowEdge([node('a', 'working', NOW - 60e3), node('b', 'blocked', NOW - 9 * H)], { now: NOW });
    expect(named).toEqual(['b', 'a']);
  });

  it('nunca más de 6 hilos, y ninguna abierta se pierde: lo que no se nombra va al grupo', () => {
    const nodes = Array.from({ length: 19 }, (_, i) => node(`n${i}`, i < 4 ? 'blocked' : 'working', NOW - i * 60e3));
    const { named, grouped } = nowEdge(nodes, { now: NOW });
    expect(named).toHaveLength(NOW_EDGE_MAX);
    expect(named.slice(0, 4).sort()).toEqual(['n0', 'n1', 'n2', 'n3']);
    expect(new Set([...named, ...grouped]).size).toBe(19);
  });

  it('datos hostiles (19 en curso): ≤6 con nombre y las 19 abiertas alcanzables', () => {
    const snap = estresSnapshot(NOW);
    const g = toSceneGraph(buildDag(snap, NOW), undefined, touchedOf(snap));
    const open = g.nodes.filter((n) => n.status === 'working' || n.status === 'blocked').map((n) => n.id);
    const { named, grouped } = nowEdge(g.nodes, { now: g.now });
    expect(named.length).toBeLessThanOrEqual(NOW_EDGE_MAX);
    expect(new Set([...named, ...grouped])).toEqual(new Set(open));
  });

  it('un mensaje reciente cuenta como cambio', () => {
    const snap = estresSnapshot(NOW);
    const id = snap.nodes.find((n) => n.status === 'working')!.id;
    snap.messages.push({ id: 'm-x', nodeId: id, from: 'Cielo', text: 'hola', at: new Date(NOW - 60e3).toISOString() });
    expect(touchedOf(snap).get(id)).toBe(NOW - 60e3);
  });
});
