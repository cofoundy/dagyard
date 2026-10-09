// Prototipo de orientación (#109) — SOLO en la rama design/orientacion y solo con `pnpm dev:fixture`: nunca entra a un
// build de producción (Vite reemplaza VITE_FIXTURE en tiempo de build). `?variant=a` = la vista de hoy; `?variant=b` =
// la brújula (★). La barra de abajo cambia de variante (← →) y de datos (real del 9 oct · te espera · hostiles · vacío).

import { useEffect } from 'react';

export type Variant = 'a' | 'b';

const ON = !!import.meta.env.VITE_FIXTURE;

export function readVariant(): Variant {
  if (!ON) return 'a';
  return new URLSearchParams(location.search).get('variant') === 'a' ? 'a' : 'b';
}

const VARIANTS: Array<{ id: Variant; name: string; star?: boolean }> = [
  { id: 'b', name: 'B — Brújula', star: true },
  { id: 'a', name: 'A — Hoy (antes)' },
];

const DATA: Array<{ p: string; name: string; sample: boolean }> = [
  { p: 'dagyard-hoy', name: 'real (9 oct)', sample: false },
  { p: 'dagyard-espera', name: 'te espera', sample: true },
  { p: 'estres', name: 'hostiles', sample: true },
  { p: 'vacio', name: 'vacío', sample: true },
];

function go(change: Record<string, string>) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(change)) q.set(k, v);
  q.delete('n');
  location.search = q.toString();
}

export function ProtoBar() {
  const v = readVariant();
  const p = new URLSearchParams(location.search).get('p') ?? 'dagyard-hoy';
  const i = VARIANTS.findIndex((x) => x.id === v);
  const cur = VARIANTS[i]!;
  const step = (d: number) => go({ variant: VARIANTS[(i + d + VARIANTS.length) % VARIANTS.length]!.id });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (e.key === 'ArrowLeft' && e.altKey) step(-1);
      if (e.key === 'ArrowRight' && e.altKey) step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!ON) return null;
  const sample = DATA.find((d) => d.p === p)?.sample ?? true;
  return (
    <div className="proto-bar" role="toolbar" aria-label="Prototipo">
      <span className="tag">{sample ? 'PROTOTIPO · datos de ejemplo' : 'PROTOTIPO · datos reales'}</span>
      <button type="button" onClick={() => step(-1)} aria-label="Variante anterior">‹</button>
      <b>
        {cur.name}
        {cur.star && <em> ★ recomendado</em>}
      </b>
      <button type="button" onClick={() => step(1)} aria-label="Variante siguiente">›</button>
      <span className="sep" />
      <span className="lbl">datos:</span>
      {DATA.map((d) => (
        <button key={d.p} type="button" className={d.p === p ? 'on' : ''} onClick={() => go({ p: d.p })}>
          {d.name}
        </button>
      ))}
    </div>
  );
}
