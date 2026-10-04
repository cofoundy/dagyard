import { describe, expect, it } from 'vitest';
import {
  DEMO_PROJECT_ID,
  DEMO_PROJECT_IDS,
  LIMITS,
  demoLang,
  demoProject,
  demoProjectId,
  demoPulse,
  isDemoProject,
  parseProjectGraphInput,
  startable,
  type DemoLang,
  type PulseState,
  type PulseStep,
} from '../src/index.js';

/** Un azar repetible (mulberry32): el pulso es puro y el test no depende de la suerte. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** El estado inicial de la demo tal como lo deja la semilla. */
function initial(lang: DemoLang): PulseState {
  const d = demoProject(lang);
  return {
    nodes: d.nodes.map((n) => ({ id: n.id!, stage: n.stage, status: n.status!, progress: n.progress!, team: n.team ?? null })),
    edges: d.nodes.flatMap((n) => (n.deps ?? []).map((from) => ({ from, to: n.id! }))),
    blockers: d.blockers!.map((b) => ({ nodeId: b.nodeId, status: 'open' as const })),
  };
}

/** Aplica un latido como lo haría el servidor. */
function apply(s: PulseState, step: PulseStep): PulseState {
  if (step.kind === 'idle') return s;
  return {
    ...s,
    nodes: s.nodes.map((n) => {
      if (n.id !== step.nodeId) return n;
      if (step.kind === 'start') return { ...n, status: 'working', progress: 0, team: step.team };
      if (step.kind === 'complete') return { ...n, status: 'done', progress: 1 };
      return { ...n, progress: step.progress };
    }),
  };
}

/** Corre el pulso hasta que no quede nada que avanzar. */
function run(s: PulseState, lang: DemoLang, rand: () => number, max = 1000): { end: PulseState; steps: PulseStep[] } {
  const steps: PulseStep[] = [];
  for (let i = 0; i < max; i++) {
    const step = demoPulse(s, lang, rand);
    if (step.kind === 'idle') return { end: s, steps };
    steps.push(step);
    s = apply(s, step);
  }
  throw new Error(`el pulso no terminó en ${max} latidos`);
}

const texts = (lang: DemoLang) => {
  const d = demoProject(lang);
  return [
    d.name,
    ...d.stages!.map((s) => s.name),
    ...d.nodes.flatMap((n) => [n.title, n.goal ?? '', n.team ?? '']),
    ...d.blockers!.flatMap((b) => [b.question, ...(b.options ?? []), b.accessLabel ?? '']),
    ...d.messages!.flatMap((m) => [m.text, m.from ?? '']),
  ];
};

describe('la demo en dos idiomas (#74)', () => {
  it('ids: booking-marketplace en inglés, marketplace-reservas en español', () => {
    expect([...DEMO_PROJECT_IDS].sort()).toEqual(['booking-marketplace', 'marketplace-reservas']);
    expect(demoProjectId('en')).toBe('booking-marketplace');
    expect(demoProjectId('es')).toBe('marketplace-reservas');
    expect(DEMO_PROJECT_ID).toBe('marketplace-reservas');
    expect(isDemoProject('booking-marketplace')).toBe(true);
    expect(isDemoProject('marketplace-reservas')).toBe(true);
    expect(isDemoProject('marketplace-reservas-1234')).toBe(false);
    expect(isDemoProject('dagyard')).toBe(false);
    expect(demoLang('booking-marketplace')).toBe('en');
    expect(demoLang('marketplace-reservas')).toBe('es');
    expect(demoLang('dagyard')).toBeNull();
  });

  it('nombres: «Booking marketplace» y «Marketplace de reservas»; sin idioma, la española', () => {
    expect(demoProject('en').name).toBe('Booking marketplace');
    expect(demoProject('es').name).toBe('Marketplace de reservas');
    expect(demoProject()).toEqual(demoProject('es'));
  });

  it('mismo grafo: mismos ids, etapas, aristas, estados, avance y los mismos 3 bloqueantes', () => {
    const [en, es] = [demoProject('en'), demoProject('es')];
    const shape = (d: typeof en) => ({
      stages: d.stages!.map((s) => s.id),
      nodes: d.nodes.map((n) => [n.id, n.stage, n.status, n.progress, [...(n.deps ?? [])].sort(), n.team === null]),
      blockers: d.blockers!.map((b) => [b.nodeId, b.kind, b.options?.length ?? 0, b.accessLabel === null]),
      messages: d.messages!.map((m) => m.nodeId),
    });
    expect(shape(en)).toEqual(shape(es));
  });

  it('las dos son grafos válidos y respetan los límites', () => {
    for (const lang of ['en', 'es'] as const) {
      const d = demoProject(lang);
      expect(parseProjectGraphInput(d)).toMatchObject({ ok: true });
      for (const m of d.messages!) expect(m.text.length).toBeLessThanOrEqual(LIMITS.message);
    }
  });

  it('el inglés está traducido entero: ningún texto queda igual al español ni con tildes', () => {
    const [en, es] = [texts('en'), texts('es')];
    const same = en.filter((t, i) => t !== '' && t === es[i] && !/^(WhatsApp|App Store)/.test(t));
    expect(same).toEqual([]);
    expect(en.filter((t) => /[áéíóúñ¿¡]/i.test(t))).toEqual([]);
  });

  it('las firmas de los mensajes van en el idioma de la demo', () => {
    expect(demoProject('es').messages!.every((m) => m.from!.startsWith('Equipo de '))).toBe(true);
    expect(demoProject('en').messages!.every((m) => / team$/.test(m.from!))).toBe(true);
  });
});

describe('el pulso de la demo (#74)', () => {
  it('nunca toca una tarea con un bloqueante abierto y nunca abre ni resuelve uno', () => {
    for (const lang of ['en', 'es'] as const)
      for (const seed of [1, 2, 3, 42]) {
        const s0 = initial(lang);
        const { end, steps } = run(s0, lang, seeded(seed));
        const held = new Set(s0.blockers.map((b) => b.nodeId));
        expect(steps.filter((st) => st.kind !== 'idle' && held.has(st.nodeId))).toEqual([]);
        expect(end.blockers).toEqual(s0.blockers);
        for (const id of held) expect(end.nodes.find((n) => n.id === id)!.status).toBe('blocked');
      }
  });

  it('avanza 8 a 18 % por latido, completa al llegar a 100 % con un mensaje de cierre', () => {
    const { steps } = run(initial('es'), 'es', seeded(7));
    const s = initial('es');
    let state = s;
    for (const step of steps) {
      const before = state.nodes.find((n) => step.kind !== 'idle' && n.id === step.nodeId)!;
      if (step.kind === 'advance') {
        expect(before.status).toBe('working');
        const d = step.progress - before.progress;
        expect(d).toBeGreaterThanOrEqual(0.08 - 1e-9);
        expect(d).toBeLessThanOrEqual(0.18 + 1e-9);
        expect(step.progress).toBeLessThan(1);
      }
      if (step.kind === 'complete') {
        expect(before.status).toBe('working');
        expect(before.progress + 0.18).toBeGreaterThanOrEqual(1);
        expect(step.message.text.length).toBeGreaterThan(0);
        expect(step.message.text.length).toBeLessThanOrEqual(LIMITS.message);
      }
      state = apply(state, step);
    }
    expect(steps.some((st) => st.kind === 'advance' && st.message !== null)).toBe(true);
  });

  it('arranca solo tareas cuyas dependencias están listas, y les pone su equipo', () => {
    for (const lang of ['en', 'es'] as const) {
      let state = initial(lang);
      for (const step of run(state, lang, seeded(5)).steps) {
        if (step.kind === 'start') {
          const ready = startable(state.nodes as never, state.edges).map((n) => n.id);
          expect(ready).toContain(step.nodeId);
          expect(step.team.length).toBeGreaterThan(0);
        }
        state = apply(state, step);
      }
    }
    const teams = (lang: DemoLang) => run(initial(lang), lang, seeded(5)).steps.flatMap((st) => (st.kind === 'start' ? [st.team] : []));
    expect(teams('en')).toContain('Build');
    expect(teams('es')).toContain('Construcción');
  });

  it('cuando ya no queda nada que avanzar, dice idle: lo que espera detrás de las 3 cosas sigue pendiente', () => {
    const { end, steps } = run(initial('en'), 'en', seeded(9));
    expect(steps.length).toBeGreaterThan(20);
    expect(steps.length).toBeLessThan(200);
    expect(end.nodes.filter((n) => n.status === 'working')).toEqual([]);
    const waiting = ['panel', 'prueba-pagos', 'tiendas', 'anuncio'];
    for (const id of waiting) expect(end.nodes.find((n) => n.id === id)!.status).toBe('pending');
    expect(demoPulse(end, 'en', seeded(1))).toEqual({ kind: 'idle' });
  });

  it('si el PM resuelve una cosa, esa tarea avanza y el trabajo que esperaba detrás arranca', () => {
    let s = initial('es');
    s = {
      ...s,
      blockers: s.blockers.map((b) => (b.nodeId === 'comision' ? { ...b, status: 'resolved' as const } : b)),
      nodes: s.nodes.map((n) => (n.id === 'comision' ? { ...n, status: 'working' as const, progress: 0 } : n)),
    };
    const { end, steps } = run(s, 'es', seeded(3));
    expect(end.nodes.find((n) => n.id === 'comision')!.status).toBe('done');
    expect(steps).toContainEqual(expect.objectContaining({ kind: 'start', nodeId: 'panel' }));
    expect(end.nodes.find((n) => n.id === 'panel')!.status).toBe('done');
  });

  it('los mensajes del pulso van en el idioma de la demo, firmados por el equipo, y ≤280', () => {
    for (const lang of ['en', 'es'] as const) {
      const msgs = run(initial(lang), lang, seeded(11)).steps.flatMap((st) =>
        st.kind === 'complete' ? [st.message] : st.kind === 'advance' && st.message ? [st.message] : [],
      );
      expect(msgs.length).toBeGreaterThan(5);
      for (const m of msgs) {
        expect(m.text.length).toBeLessThanOrEqual(LIMITS.message);
        if (lang === 'es') expect(m.from).toMatch(/^Equipo de /);
        else {
          expect(m.from).toMatch(/ team$/);
          expect(m.text).not.toMatch(/[áéíóúñ¿¡]/i);
        }
      }
      // no repite el mismo mensaje en la misma tarea
      const keys = msgs.map((m) => m.text);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('es puro: no muta el estado que recibe', () => {
    const s = initial('es');
    const copy = JSON.parse(JSON.stringify(s)) as PulseState;
    demoPulse(s, 'es', seeded(1));
    expect(s).toEqual(copy);
  });
});
