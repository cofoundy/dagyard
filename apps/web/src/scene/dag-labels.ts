// La capa DOM de la escena: etiquetas, eje del tiempo y blancos táctiles (botones de verdad: Tab, Enter, lector de
// pantalla). Estilos propios (prefijo `sky-`) para no depender de la hoja de la interfaz; se inyectan una vez.

const STYLE_ID = 'dagyard-sky-style';

const CSS = `
.sky-root { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.sky-lbl { position: absolute; left: 0; top: 0; white-space: nowrap; font: 400 12px/1.2 "Geist", ui-sans-serif, system-ui, sans-serif;
  color: #b9b2a5; opacity: 0; will-change: transform, opacity; text-shadow: 0 0 6px #04060a, 0 0 2px #04060a, 0 0 1px #04060a; }
.sky-lbl.working { color: #9fd3ff; }
.sky-lbl.blocked { color: #ffb547; font-weight: 500; }
.sky-lbl.pending { color: #8494ad; }
.sky-lbl.goal { color: #f4eee2; font-weight: 500; letter-spacing: .02em; }
.sky-lbl.request { color: #d9e1ec; }
.sky-lbl.loose { color: #d9e1ec; }
.sky-lbl.ended { color: #6b7a93; text-decoration: line-through; text-decoration-color: rgba(107,122,147,.6); }
.sky-lbl.sel { color: #f4eee2; }
.sky-lbl .pre { color: #6b7a93; font-weight: 400; text-decoration: none; display: inline-block; }
.sky-tick, .sky-now, .sky-fold { position: absolute; left: 0; top: 0; white-space: nowrap; font: 400 12px/1 "Geist Mono", ui-monospace, monospace;
  letter-spacing: .06em; text-transform: uppercase; color: #6b7a93; opacity: 0; will-change: transform, opacity; }
.sky-now { color: #9fd3ff; font-weight: 500; letter-spacing: .1em; }
.sky-fold { letter-spacing: .12em; transform-origin: 0 0; }
.sky-hit { position: absolute; left: 0; top: 0; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50%; border: 0;
  background: transparent; padding: 0; cursor: pointer; pointer-events: auto; display: none; }
.sky-hit:focus-visible { outline: 1px solid #9fd3ff; outline-offset: 2px; }
@media (pointer: coarse) { .sky-hit { width: 40px; height: 40px; margin: -20px 0 0 -20px; } }
.sky-fallback { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; text-align: center;
  font: 13px/1.5 "Geist Mono", ui-monospace, monospace; color: #6b7a93; }
`;

export function injectStyles(doc: Document): () => void {
  if (doc.getElementById(STYLE_ID)) return () => {};
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
  return () => s.remove();
}

/** Mide texto con la fuente de las etiquetas; sin canvas (tests), una estimación por carácter. */
export function textMeter(doc: Document): (text: string, weight?: number) => number {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = doc.createElement('canvas').getContext('2d');
  } catch {
    ctx = null;
  }
  return (text, weight = 400) => {
    if (!ctx) return text.length * 6.4;
    ctx.font = `${weight} 12px Geist, ui-sans-serif, system-ui, sans-serif`;
    return ctx.measureText(text).width;
  };
}

/** Recorta con «…» para que quepa en `max` px (sin cortar un emoji por la mitad). */
export function fitText(text: string, max: number, measure: (s: string) => number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (measure(s) <= max) return s;
  const chars = Array.from(s);
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (measure(chars.slice(0, m).join('') + '…') <= max) lo = m;
    else hi = m - 1;
  }
  return chars.slice(0, Math.max(1, lo)).join('').trimEnd() + '…';
}

export function fallback(root: HTMLElement, text: string): HTMLElement {
  const d = root.ownerDocument.createElement('div');
  d.className = 'sky-fallback';
  d.textContent = text;
  root.appendChild(d);
  return d;
}
