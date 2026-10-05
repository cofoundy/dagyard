/**
 * El modelo del DAG (#90, D12): dos aristas, cuatro tipos, cierre con motivo y propósito. Contrato: docs/spec/modelo.md.
 */
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  countNodes,
  depSatisfied,
  liveStages,
  nextStartable,
  parseCloseInput,
  parseEdgeInput,
  parseNodeInput,
  parseNodePatch,
  parseProjectGraphInput,
  purposeless,
  startable,
  DEFAULT_STAGES,
  type DagEvent,
  type DagNode,
  type Edge,
  type Origin,
  type ProjectSnapshot,
} from '../src/index.js';

const at = '2026-10-04T05:00:00.000Z';
const node = (id: string, over: Partial<DagNode> = {}): DagNode => ({
  id,
  projectId: 'p',
  stage: 'construccion',
  title: id,
  status: 'pending',
  progress: 0,
  team: null,
  goal: null,
  reportUrl: null,
  link: null,
  createdAt: at,
  updatedAt: at,
  ...over,
});
const edge = (from: string, to: string): Edge => ({ projectId: 'p', from, to });
const origin = (from: string, to: string): Origin => ({ projectId: 'p', from, to, why: null, createdAt: at });
const ids = (ns: DagNode[]) => ns.map((n) => n.id);

describe('lo arrancable (#90): solo tasks pending y solo «necesita»', () => {
  it('goal, request y stream nunca arrancan; un nodo sin kind (servidor viejo) es task', () => {
    const nodes = [node('g', { kind: 'goal' }), node('r', { kind: 'request' }), node('s', { kind: 'stream' }), node('t', { kind: 'task' }), node('viejo')];
    expect(ids(startable(nodes, []))).toEqual(['t', 'viejo']);
  });

  it('`next` ignora origins: nacer de una tarea abierta no bloquea', () => {
    const nodes = [node('a', { status: 'working' }), node('b')];
    // b nació de a (abierta): sigue arrancable porque no la «necesita»
    expect(nextStartable(DEFAULT_STAGES, nodes, []).node?.id).toBe('b');
    // con un «necesita» sí espera
    expect(nextStartable(DEFAULT_STAGES, nodes, [edge('a', 'b')]).node).toBeNull();
  });

  it('una dependencia cerrada con cualquier motivo satisface; replaced sigue replacedBy en cadena', () => {
    const closed = (id: string, closedAs: DagNode['closedAs'], replacedBy: string | null = null) => node(id, { status: 'done', closedAs, replacedBy });
    for (const how of ['done', 'dropped', 'learned'] as const) {
      expect(ids(startable([closed('a', how), node('b')], [edge('a', 'b')]))).toEqual(['b']);
    }
    // a reemplazada por c (abierta): b sigue esperando
    expect(ids(startable([closed('a', 'replaced', 'c'), node('b'), node('c', { status: 'working' })], [edge('a', 'b')]))).toEqual([]);
    // a → c → d, d lista: b arranca
    const chain = [closed('a', 'replaced', 'c'), node('b'), closed('c', 'replaced', 'd'), closed('d', 'done')];
    expect(ids(startable(chain, [edge('a', 'b')]))).toEqual(['b']);
  });

  it('una cadena de reemplazos con ciclo o hacia un nodo que no está no satisface (y no cuelga)', () => {
    const byId = new Map(
      [node('a', { status: 'done', closedAs: 'replaced', replacedBy: 'b' }), node('b', { status: 'done', closedAs: 'replaced', replacedBy: 'a' }), node('x', { status: 'done', closedAs: 'replaced', replacedBy: 'nadie' })].map((n) => [n.id, n]),
    );
    expect(depSatisfied(byId, 'a')).toBe(false);
    expect(depSatisfied(byId, 'x')).toBe(false);
    expect(depSatisfied(byId, 'nadie')).toBe(false);
  });

  it('unir dos: C necesita A y A se reemplaza por C → C arranca (la cadena llega al propio dependiente)', () => {
    const nodes = [node('a', { status: 'done', closedAs: 'replaced', replacedBy: 'c' }), node('c')];
    expect(ids(startable(nodes, [edge('a', 'c')]))).toEqual(['c']);
    // también por una cadena: A → B → C
    const chain = [node('a', { status: 'done', closedAs: 'replaced', replacedBy: 'b' }), node('b', { status: 'done', closedAs: 'replaced', replacedBy: 'c' }), node('c')];
    expect(ids(startable(chain, [edge('a', 'c')]))).toEqual(['c']);
  });

  it('un done viejo (sin closedAs) cuenta como cerrado', () => {
    expect(ids(startable([node('a', { status: 'done' }), node('b')], [edge('a', 'b')]))).toEqual(['b']);
  });
});

describe('conteos (#90): goals, requests y streams no son tareas', () => {
  it('countNodes y liveStages cuentan solo kind task', () => {
    const nodes = [
      node('g', { kind: 'goal', status: 'working' }),
      node('r', { kind: 'request', status: 'working', stage: 'diseno' }),
      node('s', { kind: 'stream', status: 'working', stage: 'pruebas' }),
      node('t', { status: 'working' }),
      node('viejo', { status: 'done' }),
    ];
    expect(countNodes(nodes)).toEqual({ total: 2, pending: 0, working: 1, blocked: 0, done: 1 });
    expect(liveStages(DEFAULT_STAGES, nodes).map((s) => s.id)).toEqual(['construccion']);
  });
});

describe('purposeless (#90): sin camino por «nació de» hasta un goal', () => {
  it('marca a quien no llega a un goal, también a través de varios padres (DAG, no árbol)', () => {
    const nodes = [node('g', { kind: 'goal' }), node('r', { kind: 'request' }), node('a'), node('b'), node('suelta'), node('s', { kind: 'stream' })];
    // a nace de r, r nace de g; b nace de suelta y de a; s no nace de nadie
    const origins = [origin('g', 'r'), origin('r', 'a'), origin('suelta', 'b'), origin('a', 'b')];
    expect(purposeless(nodes, origins)).toEqual(['suelta', 's']);
  });

  it('las aristas «necesita» no dan propósito, y un ciclo viejo no cuelga', () => {
    expect(purposeless([node('g', { kind: 'goal' }), node('a'), node('b')], [origin('a', 'b'), origin('b', 'a')])).toEqual(['a', 'b']);
  });
});

describe('validación (#90)', () => {
  it('nodo: stage opcional, kind, bornAt, quote, quoteBy y origins', () => {
    const r = parseNodeInput({ title: 'Pedido', kind: 'request', quote: '  hazlo DAG  ', quoteBy: 'André', bornAt: '2026-10-04T18:00:00Z', origins: [{ from: 'g', why: 'el porqué' }, { from: 'g' }] });
    expect(r).toEqual({ ok: true, value: { title: 'Pedido', kind: 'request', quote: 'hazlo DAG', quoteBy: 'André', bornAt: '2026-10-04T18:00:00.000Z', origins: [{ from: 'g', why: 'el porqué' }] } });
  });

  it('un request sin cita, una cita fuera de un request o un goal «done» son 400', () => {
    expect(parseNodeInput({ title: 'x', kind: 'request' }).ok).toBe(false);
    expect(parseNodeInput({ title: 'x', kind: 'task', quote: 'cita' }).ok).toBe(false);
    expect(parseNodeInput({ title: 'x', kind: 'goal', status: 'done' }).ok).toBe(false);
    expect(parseNodeInput({ title: 'x', kind: 'stream', status: 'done' }).ok).toBe(false);
    expect(parseNodeInput({ title: 'x', kind: 'epica' }).ok).toBe(false);
    expect(parseNodeInput({ title: 'x', bornAt: '2099-01-01T00:00:00Z' }).ok).toBe(false);
    expect(parseNodeInput({ title: 'x', origins: [{ from: 'No Slug' }] }).ok).toBe(false);
  });

  it('PATCH acepta kind, quote y quoteBy; closedAs no (para eso, close)', () => {
    expect(parseNodePatch({ kind: 'goal' })).toEqual({ ok: true, value: { kind: 'goal' } });
    const r = parseNodePatch({ closedAs: 'dropped' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/close/);
  });

  it('close: motivos, porqué obligatorio salvo done, by solo con replaced', () => {
    expect(parseCloseInput({ as: 'done' })).toEqual({ ok: true, value: { as: 'done' } });
    expect(parseCloseInput({ as: 'replaced', by: 'b', why: 'la parte' })).toEqual({ ok: true, value: { as: 'replaced', by: 'b', why: 'la parte' } });
    expect(parseCloseInput({ as: 'replaced', why: 'x' }).ok).toBe(false);
    expect(parseCloseInput({ as: 'replaced', by: 'b' }).ok).toBe(false);
    expect(parseCloseInput({ as: 'dropped' }).ok).toBe(false);
    expect(parseCloseInput({ as: 'learned' }).ok).toBe(false);
    expect(parseCloseInput({ as: 'done', by: 'b' }).ok).toBe(false);
    expect(parseCloseInput({ as: 'borrado', why: 'x' }).ok).toBe(false);
    expect(parseCloseInput({ as: 'done', closedAs: 'done' }).ok).toBe(false);
  });

  it('arista: sin kind es «necesita»; why solo con origin', () => {
    expect(parseEdgeInput({ from: 'a', to: 'b' })).toEqual({ ok: true, value: { from: 'a', to: 'b' } });
    expect(parseEdgeInput({ from: 'a', to: 'b', kind: 'origin', why: 'por esto' })).toEqual({ ok: true, value: { from: 'a', to: 'b', kind: 'origin', why: 'por esto' } });
    expect(parseEdgeInput({ from: 'a', to: 'b', why: 'x' }).ok).toBe(false);
    expect(parseEdgeInput({ from: 'a', to: 'b', kind: 'nace' }).ok).toBe(false);
  });

  it('PUT: origins a nodos del cuerpo, sin ciclos (aparte de los de «necesita»), y nada necesita un goal', () => {
    const base = { name: 'P', nodes: [{ id: 'g', title: 'G', kind: 'goal' }, { id: 'a', title: 'A', origins: [{ from: 'g' }] }] };
    expect(parseProjectGraphInput(base).ok).toBe(true);
    expect(parseProjectGraphInput({ ...base, nodes: [...base.nodes, { id: 'b', title: 'B', origins: [{ from: 'nadie' }] }] }).ok).toBe(false);
    const cyc = parseProjectGraphInput({ name: 'P', nodes: [{ id: 'a', title: 'A', origins: [{ from: 'b' }] }, { id: 'b', title: 'B', origins: [{ from: 'a' }] }] });
    expect(!cyc.ok && cyc.message).toMatch(/nació de/);
    // a necesita b y b nació de a: son aristas distintas, no hay ciclo
    expect(parseProjectGraphInput({ name: 'P', nodes: [{ id: 'a', title: 'A', deps: ['b'] }, { id: 'b', title: 'B', origins: [{ from: 'a' }] }] }).ok).toBe(true);
    expect(parseProjectGraphInput({ name: 'P', nodes: [{ id: 'g', title: 'G', kind: 'goal' }, { id: 'a', title: 'A', deps: ['g'] }] }).ok).toBe(false);
  });
});

describe('applyEvent (#90)', () => {
  const snap = (): ProjectSnapshot => ({
    project: { id: 'p', name: 'P', lang: 'es', stages: [...DEFAULT_STAGES], createdAt: at, updatedAt: at },
    nodes: [node('a'), node('b')],
    edges: [],
    origins: [],
    blockers: [],
    messages: [],
    seq: 1,
  });
  const ev = <E extends DagEvent>(e: Omit<E, 'projectId' | 'actor' | 'at'>): DagEvent => ({ projectId: 'p', actor: 'agent', at, ...e }) as DagEvent;

  it('origin.added y origin.removed tocan solo origins (edges queda igual)', () => {
    let s = applyEvent(snap(), ev({ seq: 2, type: 'origin.added', payload: { origin: { ...origin('a', 'b'), why: 'x' } } }));
    expect(s.origins).toEqual([{ ...origin('a', 'b'), why: 'x' }]);
    expect(s.edges).toEqual([]);
    s = applyEvent(s, ev({ seq: 3, type: 'origin.added', payload: { origin: origin('a', 'b') } }));
    expect(s.origins).toHaveLength(1);
    s = applyEvent(s, ev({ seq: 4, type: 'origin.removed', payload: { origin: { projectId: 'p', from: 'a', to: 'b' } } }));
    expect(s.origins).toEqual([]);
  });

  it('un snapshot de un servidor viejo (sin origins) acepta origin.added', () => {
    const { origins: _o, ...old } = snap();
    expect(applyEvent(old, ev({ seq: 2, type: 'origin.added', payload: { origin: origin('a', 'b') } })).origins).toHaveLength(1);
  });

  it('node.removed de un log viejo sigue reproduciéndose y limpia sus orígenes', () => {
    const s = applyEvent({ ...snap(), origins: [origin('a', 'b')] }, ev({ seq: 2, type: 'node.removed', payload: { nodeId: 'a' } }));
    expect(ids(s.nodes)).toEqual(['b']);
    expect(s.origins).toEqual([]);
  });
});
