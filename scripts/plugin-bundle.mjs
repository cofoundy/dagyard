#!/usr/bin/env node
// Los binarios de los plugins de Claude Code (#91): un plugin instalado desde git no corre build, así que el
// bundle del CLI y el del canal viven commiteados en el bin/ de su plugin.
//   node scripts/plugin-bundle.mjs           compila y copia
//   node scripts/plugin-bundle.mjs --check   compila y falla (exit 1) si lo commiteado difiere (CI)
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLES = [
  { pkg: '@dagyard/cli', from: 'packages/cli/dist/dagyard.mjs', to: 'packages/mod/bin/dagyard' },
  { pkg: '@dagyard/channel', from: 'packages/channel/dist/dagyard-channel.mjs', to: 'packages/channel/plugin/bin/dagyard-channel.mjs' },
];

const check = process.argv.includes('--check');
const read = (path) => {
  try {
    return readFileSync(join(ROOT, path));
  } catch {
    return null;
  }
};

const stale = [];
for (const b of BUNDLES) {
  execFileSync('pnpm', ['--filter', b.pkg, 'build'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  const built = read(b.from);
  if (!built) throw new Error(`${b.pkg}: el build no dejó ${b.from}`);
  if (check) {
    const committed = read(b.to);
    if (!committed || !committed.equals(built)) stale.push(b.to);
    continue;
  }
  mkdirSync(dirname(join(ROOT, b.to)), { recursive: true });
  copyFileSync(join(ROOT, b.from), join(ROOT, b.to));
  chmodSync(join(ROOT, b.to), 0o755);
  console.log(`${relative(ROOT, join(ROOT, b.to))} ← ${b.from} (${built.length} bytes)`);
}

if (stale.length) {
  console.error(`Desactualizado respecto del build: ${stale.join(', ')}\nCorre: node scripts/plugin-bundle.mjs y commitea.`);
  process.exit(1);
}
if (check) console.log('Los binarios de los plugins están al día.');
