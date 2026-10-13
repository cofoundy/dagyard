// Disposición del DAG (portada de dagyard-design/design/arbol/shared/tree-layout.js, concepto aprobado). Pura: tareas → px.
//
// x = cuándo nació la tarea. Escala lineal por tramos: lo nacido en los últimos ~40 min gana aire (recentBoost), un
//     silencio > foldAfter se pliega a foldW px con su rótulo, y los nacimientos a < sameMs comparten momento.
//     Novedad respecto del prototipo: dentro de un mismo momento, lo que nació de algo nacido en ese momento va una
//     columna más a la derecha (una generación). Si todo nació junto (un proyecto sembrado de una vez, como la demo),
//     las generaciones se estiran hasta llenar el ancho: el tiempo no dice nada y el orden de nacimiento sí.
// y = la rama. Cada tarea tiene un tallo de su estrella a su último hijo (o hasta «ahora» si sigue viva); los hijos
//     brotan del tallo y van a la fila libre más cercana; el último hijo de una tarea terminada sigue en su fila. Las
//     filas se reciclan y, con `prevRows`, lo que ya tenía fila la conserva (nacer algo no reordena el resto).

import type { NodeStatus } from '../data/types';

export interface LayoutTask {
  id: string;
  born: number;
  /** El primer origen («nació de»): de su tallo brota. */
  parent: string | null;
  /** Lo que nació de ella, del más viejo al más nuevo. */
  children: string[];
  status: NodeStatus;
  /** Su etiqueta se pinta siempre: se le reserva lugar en la fila. */
  labelled?: boolean;
  /** Su tallo llega hasta «ahora» (#107: solo lo que se nombra ahí). Sin el campo, lo que está en curso o te espera. */
  toNow?: boolean;
}

export interface DagLayoutOptions {
  width: number;
  now: number;
  padL?: number;
  padR?: number;
  /** Ancho de un silencio plegado (px). */
  foldW?: number;
  /** Un silencio más largo que esto se pliega (ms). */
  foldAfter?: number;
  /** Nacimientos más cercanos que esto comparten momento (ms). */
  sameMs?: number;
  /** Paso mínimo entre dos momentos con nacimientos (px). */
  minStep?: number;
  recentBoost?: number;
  recentTau?: number;
  /** Paso mínimo entre generaciones de un mismo momento (px). */
  genStep?: number;
  /** Paso máximo entre generaciones cuando se estiran para llenar el ancho (px). */
  maxGenStep?: number;
  nowGap?: number;
  curveW?: number;
  labelReserve?: number;
  maxPxPerMin?: number;
  /** Momentos con actividad (mensajes, respuestas): no se pliegan. */
  activity?: number[];
  prevRows?: Map<string, number> | null;
}

export interface Fold {
  x0: number;
  x1: number;
  from: number;
  to: number;
}

export interface DagLayout {
  x: Map<string, number>;
  row: Map<string, number>;
  /** Hasta dónde llega el tallo de cada tarea (px). */
  stemEnd: Map<string, number>;
  folds: Fold[];
  /** Tiempo → x (interpola dentro de un tramo; dentro de un pliegue, a su borde). */
  tx: (t: number) => number;
  width: number;
  /** Fila mínima y máxima. */
  rows: [number, number];
  nowX: number;
  pxPerMin: number;
  times: number[];
}

const DEFAULTS = {
  padL: 24,
  padR: 24,
  foldW: 44,
  foldAfter: 60 * 60e3,
  sameMs: 90e3,
  minStep: 9,
  recentBoost: 34,
  recentTau: 40 * 60e3,
  genStep: 26,
  maxGenStep: 220,
  /** Aire entre la última estrella y «ahora» (px): ahí se nombra lo vivo. */
  nowGap: 28,
  curveW: 26,
  labelReserve: 150,
  maxPxPerMin: 14,
};

const alive = (s: NodeStatus) => s === 'working' || s === 'blocked';

export function layoutDag(tasks: readonly LayoutTask[], o: DagLayoutOptions): DagLayout {
  const opt = { ...DEFAULTS, ...o };
  const now = opt.now;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const list = tasks.slice().sort((a, b) => a.born - b.born || a.id.localeCompare(b.id, 'en', { numeric: true }));
  if (!list.length) {
    return { x: new Map(), row: new Map(), stemEnd: new Map(), folds: [], tx: () => opt.padL, width: opt.width, rows: [0, 0], nowX: opt.padL, pxPerMin: 0, times: [now] };
  }

  // ---------- momentos y generaciones ----------
  const births = new Set(list.map((n) => n.born));
  const act = (opt.activity ?? []).filter((t) => t > list[0]!.born && t < now);
  const times = [...new Set([...births, now, ...act])].sort((a, b) => a - b);
  // momento (índice del primer tiempo del grupo) de cada tiempo: los que caen a < sameMs del anterior se juntan
  const moment: number[] = [0];
  for (let i = 1; i < times.length; i++) moment.push(times[i]! - times[i - 1]! < opt.sameMs ? moment[i - 1]! : i);
  const momentOfTime = new Map(times.map((t, i) => [t, moment[i]!]));
  const gen = new Map<string, number>();
  for (const n of list) {
    const p = n.parent ? byId.get(n.parent) : undefined;
    const same = p && momentOfTime.get(p.born) === momentOfTime.get(n.born) && p.born <= n.born;
    gen.set(n.id, same ? (gen.get(p.id) ?? 0) + 1 : 0);
  }
  const maxGen = new Map<number, number>();
  for (const n of list) {
    const m = momentOfTime.get(n.born)!;
    maxGen.set(m, Math.max(maxGen.get(m) ?? 0, gen.get(n.id)!));
  }

  // ---------- tiempo → x ----------
  const avail = Math.max(120, opt.width - opt.padL - opt.padR - opt.nowGap);
  const place = (k: number, g: number) => {
    const xs = [0];
    const folds: { from: number; to: number }[] = [];
    for (let i = 1; i < times.length; i++) {
      const gap = times[i]! - times[i - 1]!;
      // las generaciones del momento anterior ocupan su ancho antes de seguir
      const spill = moment[i] !== moment[i - 1] ? (maxGen.get(moment[i - 1]!) ?? 0) * g : 0;
      if (gap > opt.foldAfter) {
        folds.push({ from: times[i - 1]!, to: times[i]! });
        xs.push(xs[i - 1]! + spill + opt.foldW);
      } else if (moment[i] === moment[i - 1]) xs.push(xs[i - 1]!);
      else {
        const step = births.has(times[i]!) ? opt.minStep + opt.recentBoost * Math.exp(-(now - times[i]!) / opt.recentTau) : 0;
        xs.push(xs[i - 1]! + spill + Math.max(step, (gap / 60e3) * k));
      }
    }
    const last = times.length - 1;
    const end = xs[last]! + (maxGen.get(moment[last]!) ?? 0) * g;
    return { xs, folds, end };
  };
  const fit = (lo: number, hi: number, f: (v: number) => number) => {
    if (f(hi) <= avail) return hi;
    for (let it = 0; it < 40 && hi - lo > 1e-4; it++) {
      const mid = (lo + hi) / 2;
      if (f(mid) > avail) hi = mid;
      else lo = mid;
    }
    return lo;
  };
  const k = fit(0, opt.maxPxPerMin, (v) => place(v, opt.genStep).end);
  // si el tiempo ya no estira (todo nació junto o casi), estiran las generaciones
  const g = k >= opt.maxPxPerMin - 1e-6 ? fit(opt.genStep, opt.maxGenStep, (v) => place(k, v).end) : opt.genStep;
  const { xs, folds } = place(k, g);
  const xAt = new Map(times.map((t, i) => [t, opt.padL + xs[i]!]));
  const tx = (t: number): number => {
    if (t <= times[0]!) return opt.padL;
    for (let i = 1; i < times.length; i++) {
      if (t <= times[i]!) {
        const a = times[i - 1]!, b = times[i]!, xa = opt.padL + xs[i - 1]!, xb = opt.padL + xs[i]!;
        if (b - a > opt.foldAfter) return t - a < 30 * 60e3 ? xa + Math.min(opt.foldW * 0.3, ((t - a) / 60e3) * k) : xb;
        return xa + ((t - a) / (b - a || 1)) * (xb - xa);
      }
    }
    return opt.padL + xs[xs.length - 1]!;
  };
  const X = new Map(list.map((n) => [n.id, xAt.get(n.born)! + gen.get(n.id)! * g]));
  // un hijo nunca cae en la columna de su origen (nacieron casi juntos en momentos distintos): se abre a la derecha
  for (const n of list) {
    const p = n.parent ? X.get(n.parent) : undefined;
    if (p !== undefined && X.get(n.id)! < p + opt.genStep * 0.6 && byId.get(n.parent!)!.born <= n.born) X.set(n.id, p + opt.genStep);
  }
  const nowX = Math.max(tx(now), Math.max(...X.values()) + opt.nowGap);

  // ---------- tallos ----------
  const stemEnd = new Map<string, number>();
  for (const n of list) {
    let end = Math.max(X.get(n.id)!, ...n.children.filter((c) => X.has(c)).map((c) => X.get(c)!));
    if (n.toNow ?? alive(n.status)) end = Math.max(end, nowX);
    stemEnd.set(n.id, end);
  }

  // ---------- filas ----------
  const rows = new Map<number, { a: number; b: number; id: string }[]>();
  const hits = (r: number, a: number, b: number, except?: string) => (rows.get(r) ?? []).filter((iv) => iv.id !== except && a < iv.b + 6 && b > iv.a - 6);
  const take = (r: number, a: number, b: number, id: string) => (rows.get(r) ?? rows.set(r, []).get(r)!).push({ a, b, id });
  const R = new Map<string, number>();
  for (const n of list) {
    const x = X.get(n.id)!;
    const end = stemEnd.get(n.id)! + (n.labelled ? opt.labelReserve : 0);
    const p = n.parent ? byId.get(n.parent) : undefined;
    let row: number | null = null;
    const prev = opt.prevRows?.get(n.id);
    if (prev !== undefined && hits(prev, x - 4, end).length === 0) row = prev;
    if (row === null && p && R.has(p.id)) {
      const pr = R.get(p.id)!;
      const last = p.children[p.children.length - 1] === n.id && p.status === 'done' && x > X.get(p.id)! + 0.5;
      if (last && hits(pr, x, end, p.id).length === 0) row = pr;
      const a = Math.max(X.get(p.id)! + 2, x - opt.curveW);
      for (let d = 1; d < 400 && row === null; d++) for (const r of [pr + d, pr - d]) if (row === null && hits(r, a, end).length === 0) row = r;
    } else if (row === null) {
      for (let d = 0; d < 400 && row === null; d++) for (const r of d ? [d, -d] : [0]) if (row === null && hits(r, x - 4, end).length === 0) row = r;
    }
    const r = row ?? 0;
    R.set(n.id, r);
    take(r, x - 4, end, n.id);
  }
  const rowVals = [...R.values()];
  const maxX = Math.max(nowX, ...X.values());
  return {
    x: X,
    row: R,
    stemEnd,
    folds: folds.map((f) => ({ x0: xAt.get(f.from)!, x1: xAt.get(f.to)!, from: f.from, to: f.to })),
    tx,
    width: Math.max(opt.padL + xs[xs.length - 1]! + opt.padR, maxX + opt.padR),
    rows: [Math.min(...rowVals), Math.max(...rowVals)],
    nowX,
    pxPerMin: k,
    times,
  };
}

/** Marcas legibles del eje: cada 15/30/60/120/240 min según el espacio, fuera de los pliegues. */
export function timeTicks(L: DagLayout, minGapPx = 64): { t: number; x: number }[] {
  const steps = [15, 30, 60, 120, 240, 720, 1440].map((m) => m * 60e3);
  const t0 = L.times[0]!, t1 = L.times[L.times.length - 1]!;
  let out: { t: number; x: number }[] = [];
  for (const st of steps) {
    out = [];
    let last = -1e9, ok = true;
    for (let t = Math.ceil(t0 / st) * st; t <= t1; t += st) {
      if (L.folds.some((f) => t > f.from && t < f.to)) continue;
      const x = L.tx(t);
      if (x - last < minGapPx) {
        ok = false;
        break;
      }
      out.push({ t, x });
      last = x;
    }
    if (ok) return out;
  }
  return out;
}
