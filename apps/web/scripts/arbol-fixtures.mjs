// Genera los fixtures de la vista DAG (#75) a partir de datos reales, para `pnpm dev:fixture` y los tests:
//   src/data/fixtures/dagyard-oct4.json — el proyecto «dagyard» del 4 oct (design/arbol/data/bundle.js) con la forma que
//     tendrá después de #90: la meta, los pedidos de André con su cita y un «nació de» con su porqué para cada tarea,
//     tal como los escribe la migración (apps/worker/scripts/migrate-d12.data.json de sprint/modelo).
//   src/data/fixtures/estres.json — los datos hostiles del prototipo (design/arbol/shared/hostile.js): 3 días, títulos de
//     90 caracteres, emoji, RTL, markup, varias esperas y cabos sueltos.
// Uso (desde la raíz del repo): node apps/web/scripts/arbol-fixtures.mjs <ruta a migrate-d12.data.json>
//   p. ej. git show origin/sprint/modelo:apps/worker/scripts/migrate-d12.data.json > /tmp/d12.json
// Determinista: misma entrada, mismos archivos.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const out = join(here, '..', 'src', 'data', 'fixtures');
const d12Path = process.argv[2];
if (!d12Path) {
  console.error('Uso: node apps/web/scripts/arbol-fixtures.mjs <migrate-d12.data.json>');
  process.exit(2);
}

// los scripts del prototipo se cuelgan de `window`: se corren en un contexto aislado
const sandbox = {};
sandbox.window = sandbox;
for (const f of ['design/arbol/data/bundle.js', 'design/arbol/shared/lineage.js', 'design/arbol/shared/hostile.js'])
  vm.runInNewContext(readFileSync(join(repo, f), 'utf8'), sandbox, { filename: f });
const { DAGYARD_RAW: RAW, DagyardLineage: lineage, DagyardHostile: hostile } = sandbox;
const d12 = JSON.parse(readFileSync(d12Path, 'utf8'));

const iso = (ms) => new Date(ms).toISOString();

function blockerOf(b) {
  const r = b.resolution;
  const resolved = b.status === 'resolved';
  const summary = !resolved || !r ? undefined : b.kind === 'access' ? 'Acceso entregado' : r.choice ? `«${r.choice}»${r.note ? ` · ${r.note}` : ''}` : 'Decidido';
  return {
    id: b.id,
    nodeId: b.nodeId,
    kind: b.kind,
    question: b.question,
    options: b.kind === 'access' ? [] : b.options?.length ? b.options : b.kind === 'review' ? ['Aprobar', 'Pedir cambios'] : [],
    ...(b.kind === 'access' && b.accessLabel ? { label: b.accessLabel } : {}),
    ...(resolved ? { resolution: summary, resolvedBy: b.resolvedBy === 'agent' ? 'agent' : 'you', resolvedAt: b.resolvedAt ?? b.createdAt } : {}),
  };
}

const messageOf = (m) => ({ id: m.id, nodeId: m.nodeId, from: m.from, text: m.text, ...(m.reportUrl ? { reportUrl: m.reportUrl } : {}), at: m.createdAt });

function nodeOf(n, born) {
  return {
    id: n.id,
    stageId: n.stage,
    title: n.title,
    status: n.status,
    progress: n.progress ?? 0,
    ...(n.team ? { team: n.team } : {}),
    ...(n.reportUrl ? { reportUrl: n.reportUrl } : {}),
    ...(n.link ? { link: n.link } : {}),
    kind: 'task',
    bornAt: iso(born),
    ...(n.status === 'done' ? { closedAs: 'done' } : {}),
  };
}

/* ------------------------------------------------------------------ el proyecto real, ya migrado a #90 */

{
  const P = RAW.project;
  const model = lineage.derive(RAW);
  const stage0 = P.project.stages[0].id;
  const nodes = P.nodes.map((n) => nodeOf(n, model.byId.get(n.id)?.born ?? Date.parse(n.createdAt)));
  for (const g of d12.goals) nodes.push({ id: g.id, stageId: stage0, title: g.title, status: 'working', progress: 0, kind: 'goal', bornAt: g.bornAt });
  for (const r of d12.requests)
    nodes.push({ id: r.id, stageId: stage0, title: r.title, status: 'pending', progress: 0, kind: 'request', bornAt: r.bornAt, quote: r.quote, ...(r.quoteBy ? { quoteBy: r.quoteBy } : {}) });
  const ids = new Set(nodes.map((n) => n.id));
  const origins = [];
  const skipped = [];
  for (const o of [...d12.requests.map((r) => ({ from: r.from, to: r.id, why: r.why })), ...d12.origins]) {
    if (!ids.has(o.from) || !ids.has(o.to)) {
      skipped.push(`${o.from}→${o.to}`);
      continue;
    }
    origins.push({ from: o.from, to: o.to, ...(o.why ? { why: o.why } : {}) });
  }
  const snap = {
    asOf: P.project.updatedAt,
    project: { id: P.project.id, name: P.project.name },
    stages: P.project.stages,
    nodes,
    edges: P.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ from: e.from, to: e.to })),
    origins,
    blockers: P.blockers.map(blockerOf),
    messages: P.messages.map(messageOf),
    seq: 0,
  };
  write('dagyard-oct4.json', snap);
  const orphan = nodes.filter((n) => n.kind !== 'goal' && !origins.some((o) => o.to === n.id)).map((n) => n.id);
  console.log(`dagyard-oct4: ${nodes.length} nodos, ${origins.length} orígenes, ${snap.edges.length} dependencias; sin origen: ${orphan.join(', ') || 'ninguno'}; omitidos: ${skipped.join(', ') || 'ninguno'}`);
}

/* ------------------------------------------------------------------ datos hostiles (sin metas: el cabo suelto es el de antes de #90) */

{
  const raw = hostile.hostileRaw();
  const P = raw.project;
  const model = lineage.derive(raw);
  const WHY = {
    review: 'Salió de una revisión',
    found: 'Apareció mientras se trabajaba en esto',
    followup: 'Un paso que siguió',
    planned: 'Parte del plan',
    decision: 'Una decisión que tomar',
  };
  const nodes = P.nodes.map((n) => {
    const m = model.byId.get(n.id);
    const base = nodeOf(n, m?.born ?? Date.parse(n.createdAt));
    if (m?.why?.kind === 'asked' && m.why.quote) return { ...base, kind: 'request', quote: m.why.quote, quoteBy: 'André' };
    return base;
  });
  const ids = new Set(nodes.map((n) => n.id));
  const origins = [];
  for (const n of P.nodes) {
    const m = model.byId.get(n.id);
    for (const from of m?.origins ?? []) if (ids.has(from)) origins.push({ from, to: n.id, ...(WHY[m.why?.kind] ? { why: WHY[m.why.kind] } : {}) });
  }
  const snap = {
    asOf: iso(model.now),
    project: { id: 'estres', name: 'Prueba de estrés: tres días de fábrica' },
    stages: P.project?.stages ?? [{ id: 'construccion', name: 'Construcción' }],
    nodes: nodes.map((n) => ({ ...n, stageId: n.stageId ?? 'construccion' })),
    edges: (P.edges ?? []).filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ from: e.from, to: e.to })),
    origins,
    blockers: (P.blockers ?? []).map(blockerOf),
    messages: (P.messages ?? []).map(messageOf),
    seq: 0,
  };
  write('estres.json', snap);
  console.log(`estres: ${nodes.length} nodos, ${origins.length} orígenes, ${snap.blockers.filter((b) => !b.resolvedAt).length} esperas`);
}

/** Como el servidor: una tarea con un pedido abierto está «te espera». */
function waitingFromBlockers(snap) {
  const open = new Set(snap.blockers.filter((b) => !b.resolvedAt).map((b) => b.nodeId));
  for (const n of snap.nodes) if (open.has(n.id) && n.status !== 'done') n.status = 'blocked';
  return snap;
}

function write(name, data) {
  waitingFromBlockers(data);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, name), JSON.stringify(data, null, 1) + '\n');
}
