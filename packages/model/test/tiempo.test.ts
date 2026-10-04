import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  normalizeIso,
  parseNodePatch,
  parseProjectGraphInput,
  parseTeamPatch,
  sortTeams,
  teamNameFromSlug,
  type DagEvent,
  type ProjectSnapshot,
  type Team,
} from '../src/index.js';

const team = (id: string, startedAt: string | null, extra: Partial<Team> = {}): Team => ({
  id,
  projectId: 'p',
  name: id,
  nodeIds: [],
  requestedAt: null,
  startedAt,
  closedAt: null,
  outcome: null,
  updatedAt: '2026-10-04T00:00:00.000Z',
  ...extra,
});

const base = (teams?: Team[]): ProjectSnapshot => ({
  project: { id: 'p', name: 'P', lang: 'es', stages: [], createdAt: '', updatedAt: '' },
  nodes: [],
  edges: [],
  blockers: [],
  messages: [],
  ...(teams && { teams }),
  seq: 1,
});

const updated = (seq: number, t: Team): DagEvent => ({ seq, projectId: 'p', type: 'team.updated', actor: 'agent', at: '', payload: { team: t } });

describe('equipos (#75)', () => {
  it('normalizeIso: con hora y zona, a toISOString; lo demás es null', () => {
    expect(normalizeIso('2026-10-04T05:35:20Z')).toBe('2026-10-04T05:35:20.000Z');
    expect(normalizeIso('2026-10-04T00:35:20-05:00')).toBe('2026-10-04T05:35:20.000Z');
    for (const bad of ['2026-10-04', 'ayer', '2026-13-40T99:00:00Z', 42, null]) expect(normalizeIso(bad)).toBeNull();
  });

  it('parseTeamPatch: upsert parcial validado', () => {
    expect(parseTeamPatch({})).toEqual({ ok: true, value: {} });
    expect(parseTeamPatch({ name: ' Tiempo ', nodeIds: ['gh-75', 'gh-75'], startedAt: '2026-10-04T19:07:42Z', closedAt: null, outcome: '' })).toEqual({
      ok: true,
      value: { name: 'Tiempo', nodeIds: ['gh-75'], startedAt: '2026-10-04T19:07:42.000Z', closedAt: null, outcome: null },
    });
    for (const bad of [{ id: 'x' }, { nodeIds: 'gh-1' }, { nodeIds: ['A B'] }, { startedAt: '2026-10-04' }, { name: 3 }, []])
      expect(parseTeamPatch(bad).ok, JSON.stringify(bad)).toBe(false);
    expect(parseTeamPatch({ nodeIds: Array.from({ length: 51 }, (_, i) => `n${i}`) }).ok).toBe(false);
  });

  it('parseNodePatch acepta teamId (slug o null), nunca startedAt/doneAt', () => {
    expect(parseNodePatch({ teamId: 'tiempo' })).toEqual({ ok: true, value: { teamId: 'tiempo' } });
    expect(parseNodePatch({ status: 'working', teamId: null })).toEqual({ ok: true, value: { status: 'working', teamId: null } });
    for (const bad of [{ teamId: 'No Vale' }, { startedAt: '2026-10-04T00:00:00Z' }, { doneAt: null }]) expect(parseNodePatch(bad).ok).toBe(false);
  });

  it('parseProjectGraphInput: un bloqueante del cuerpo puede traer su createdAt', () => {
    const g = { name: 'P', nodes: [{ id: 'a', stage: 's', title: 'A' }], blockers: [{ nodeId: 'a', kind: 'review', question: '¿Va?', createdAt: '2026-10-04T10:00:00Z' }] };
    const r = parseProjectGraphInput(g);
    expect(r.ok && r.value.blockers![0]).toMatchObject({ createdAt: '2026-10-04T10:00:00.000Z' });
    expect(parseProjectGraphInput({ ...g, blockers: [{ ...g.blockers[0], createdAt: 'ayer' }] }).ok).toBe(false);
  });

  it('teamNameFromSlug', () => {
    expect(teamNameFromSlug('demo-viva')).toBe('Demo viva');
    expect(teamNameFromSlug('i18n')).toBe('I18n');
  });

  it('applyEvent team.updated: agrega o reemplaza y mantiene el orden por startedAt (nulos al final)', () => {
    const s0 = base();
    const s1 = applyEvent(s0, updated(2, team('tarde', '2026-10-04T09:00:00.000Z')));
    const s2 = applyEvent(s1, updated(3, team('sin', null)));
    const s3 = applyEvent(s2, updated(4, team('temprano', '2026-10-04T08:00:00.000Z')));
    expect(s3.teams!.map((t) => t.id)).toEqual(['temprano', 'tarde', 'sin']);
    const s4 = applyEvent(s3, updated(5, team('sin', '2026-10-04T07:00:00.000Z', { name: 'Ahora sí' })));
    expect(s4.teams!.map((t) => [t.id, t.name])).toEqual([['sin', 'Ahora sí'], ['temprano', 'temprano'], ['tarde', 'tarde']]);
    expect(s4.seq).toBe(5);
    // idempotente: un seq viejo no cambia nada; el snapshot original no se muta
    expect(applyEvent(s4, updated(5, team('otro', null)))).toBe(s4);
    expect(s0.teams).toBeUndefined();
  });

  it('sortTeams es estable a igualdad de startedAt', () => {
    const at = '2026-10-04T05:37:49.000Z';
    expect(sortTeams([team('cielo', at), team('x', null), team('cli', at)]).map((t) => t.id)).toEqual(['cielo', 'cli', 'x']);
  });
});

describe('revisión adversarial (#75)', () => {
  it('normalizeIso rechaza fechas imposibles que V8 corre al mes siguiente', () => {
    for (const bad of ['2026-02-30T00:00:00Z', '2026-02-29T10:00:00Z', '2026-04-31T10:00:00Z', '2026-10-04T24:00:00Z', '2026-10-04T23:60:00Z', '2026-10-04T23:00:61Z'])
      expect(normalizeIso(bad), bad).toBeNull();
    expect(normalizeIso('2024-02-29T10:00:00Z')).toBe('2024-02-29T10:00:00.000Z');
  });

  it('parseTeamPatch: fechas entre 2020 y mañana; closedAt no antes de startedAt; addNodeIds', () => {
    const soon = new Date(Date.now() + 12 * 3600e3).toISOString();
    const late = new Date(Date.now() + 25 * 3600e3).toISOString();
    expect(parseTeamPatch({ startedAt: soon }).ok).toBe(true);
    for (const bad of [
      { startedAt: '2019-12-31T23:59:59Z' },
      { closedAt: late },
      { requestedAt: '2026-02-30T00:00:00Z' },
      { startedAt: '2026-10-04T10:00:00Z', closedAt: '2026-10-04T09:59:59Z' },
      { addNodeIds: ['No Vale'] },
      { addNodeIds: Array.from({ length: 51 }, (_, i) => `n${i}`) },
    ])
      expect(parseTeamPatch(bad).ok, JSON.stringify(bad)).toBe(false);
    expect(parseTeamPatch({ addNodeIds: ['gh-1', 'gh-1', 'gh-2'] })).toEqual({ ok: true, value: { addNodeIds: ['gh-1', 'gh-2'] } });
  });
});
