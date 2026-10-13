#!/usr/bin/env node
// El repo es solo código (#127): un plugin de Claude Code se instala con un clon `--depth 1`, así que lo que pesa
// es el árbol, y tiene que bajar en segundos. Falla (exit 1) si el árbol de HEAD pasa de MAX_BYTES o si entra una
// imagen fuera de docs/media/. Las capturas de QA van al issue o a Basalt; el diseño, a cofoundy/dagyard-design.
//   node scripts/repo-weight.mjs              mide el árbol de HEAD (CI)
//   node scripts/repo-weight.mjs <ref>        mide el árbol de otro commit
import { execFileSync } from 'node:child_process';

const MAX_BYTES = 8 * 1024 * 1024;
const MEDIA = 'docs/media/';
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|heic|psd|mp4|webm|mov|mkv)$/i;
// lo que la app sirve tal cual; agregar aquí es una decisión con su porqué, no un escape
const ALLOWED = new Map([['apps/web/public/favicon.svg', 'el ícono de la pestaña']]);

const ref = process.argv[2] ?? 'HEAD';
const out = execFileSync('git', ['ls-tree', '-r', '-l', '-z', ref], { encoding: 'utf8', maxBuffer: 1 << 28 });
let total = 0;
const files = [];
for (const entry of out.split('\0')) {
  if (!entry) continue;
  const [meta, path] = entry.split('\t');
  const size = Number(meta.trim().split(/\s+/)[3]);
  if (Number.isFinite(size)) total += size; // los submódulos no tienen tamaño
  files.push({ path, size: Number.isFinite(size) ? size : 0 });
}

const mb = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;
const problems = [];
if (total > MAX_BYTES) {
  const top = [...files].sort((a, b) => b.size - a.size).slice(0, 10);
  problems.push(`el árbol pesa ${mb(total)} (máximo ${mb(MAX_BYTES)}). Lo más grande:\n${top.map((f) => `  ${mb(f.size)}  ${f.path}`).join('\n')}`);
}
const stray = files.filter((f) => IMAGE.test(f.path) && !f.path.startsWith(MEDIA) && !ALLOWED.has(f.path));
if (stray.length) {
  problems.push(`imágenes fuera de ${MEDIA} (las capturas van al issue o a Basalt; el diseño, a cofoundy/dagyard-design):\n${stray.slice(0, 20).map((f) => `  ${f.path}`).join('\n')}${stray.length > 20 ? `\n  … y ${stray.length - 20} más` : ''}`);
}

if (problems.length) {
  console.error(`repo-weight: ${problems.join('\n\n')}`);
  process.exit(1);
}
console.log(`repo-weight: ${mb(total)} en ${files.length} archivos (máximo ${mb(MAX_BYTES)}), ninguna imagen fuera de ${MEDIA}`);
