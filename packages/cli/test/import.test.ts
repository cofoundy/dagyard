import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProjectGraphInput } from '@dagyard/model';
import { buildImport, MAX_STAGES, projectNameFromDir, readTasksDir, readTitles } from '../src/tasks/import.js';

const dir = (repo: string) => join(__dirname, 'fixtures', repo);
const node = (r: ReturnType<typeof buildImport>, id: string) => {
  const n = r.graph.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no hay nodo ${id}`);
  return n;
};

describe('buildImport', () => {
  it('basalt: ids slug, aristas solo entre tareas del directorio, etapas por profundidad', () => {
    const r = buildImport(readTasksDir(dir('basalt')), { dirName: 'basalt' });
    expect(r.projectId).toBe('basalt');
    expect(r.graph.name).toBe('Basalt');
    expect(r.stats.nodes).toBe(23);
    expect(r.stats.stageSource).toBe('depth');

    expect(node(r, 'l3').deps).toEqual(['l1', 'l2']);
    expect(node(r, 't-599').deps).toEqual(['t-600']);
    expect(node(r, 't-903').deps).toEqual(['t-902']);
    expect(node(r, 't-606-m1').deps).toEqual(['t-606-instrument']);
    expect(node(r, 't-704').deps).toEqual(['t-702', 't-703']);
    expect(node(r, 't-458').deps).toEqual([]); // «— (no esperás a T-440)»

    expect(node(r, 'l1').stage).toBe('para-empezar');
    expect(node(r, 'l3').stage).toBe('al-final');
    expect(r.graph.stages?.map((s) => s.name)).toEqual(['Para empezar', 'Al final']);
  });

  it('blocked que espera a otra tarea es Pendiente; done lleva progreso 1', () => {
    const r = buildImport(readTasksDir(dir('basalt')), { dirName: 'basalt' });
    expect(node(r, 't-606-m1').status).toBe('pending');
    expect(node(r, 't-641').status).toBe('done');
    expect(node(r, 't-641').progress).toBe(1);
  });

  it('cada nodo trae goal de una línea y ningún título visible muestra T-xxx', () => {
    for (const repo of ['basalt', 'gateway', 'pets']) {
      const r = buildImport(readTasksDir(dir(repo)), { dirName: repo });
      for (const n of r.graph.nodes) {
        expect(n.title).not.toMatch(/\bT-[A-Z0-9]/);
        expect(n.title.length).toBeGreaterThan(0);
        expect(n.goal).toBeTruthy();
        expect(n.goal).not.toContain('\n');
        expect(n.goal!.length).toBeLessThanOrEqual(500);
      }
    }
  });

  it('gateway: deps con comentario y con comillas', () => {
    const r = buildImport(readTasksDir(dir('gateway')), { dirName: 'acme-gateway' });
    expect(node(r, 't-027').deps).toEqual(['t-024', 't-025']);
    expect(node(r, 't-023').deps).toEqual(['t-022']);
    expect(r.graph.name).toBe('Acme gateway');
  });

  it('pets: blockedBy, ids desconocidos avisados y no inventados', () => {
    const r = buildImport(readTasksDir(dir('pets')), { dirName: 'pets' });
    expect(node(r, 't-sv-01').deps).toEqual(['t-a01', 't-a02']);
    expect(node(r, 't-sv-02').deps).toEqual(['t-sv-01']);
    expect(r.warnings.join('\n')).toContain('T-ZZ-99');
    expect(node(r, 'fix-seo').stage).toBe('para-empezar');
  });

  it('etapas por phase cuando todas la traen, en el orden de las etapas por defecto', () => {
    const files = [
      { file: 'a.md', text: '---\nid: A\nphase: verification\ndeps: [B]\n---\n# A — Probar' },
      { file: 'b.md', text: '---\nid: B\nphase: build\n---\n# B — Construir' },
    ];
    const r = buildImport(files, { dirName: 'x' });
    expect(r.stats.stageSource).toBe('phase');
    expect(r.graph.stages).toEqual([
      { id: 'construccion', name: 'Construcción' },
      { id: 'pruebas', name: 'Pruebas' },
    ]);
    expect(node(r, 'a').stage).toBe('pruebas');
  });

  it('rompe ciclos y lo avisa; ids repetidos no chocan', () => {
    const files = [
      { file: 'a.md', text: '---\nid: T-1\ndeps: [T-2]\n---\n# x' },
      { file: 'b.md', text: '---\nid: T-2\ndeps: [T-1]\n---\n# y' },
      { file: 'c.md', text: '---\nid: T-1\n---\n# z' },
    ];
    const r = buildImport(files, { dirName: 'x' });
    expect(r.stats.edges).toBe(1);
    expect(r.warnings.some((w) => w.startsWith('ciclo'))).toBe(true);
    expect(r.graph.nodes.map((n) => n.id)).toEqual(['t-1', 't-2', 't-1-2']);
  });

  it('status que pide a un humano queda Pendiente con un aviso aunque tenga deps pendientes', () => {
    const files = [
      { file: 'a.md', text: '---\nid: T-1\nstatus: ready\n---\n# Base' },
      { file: 'b.md', text: '---\nid: T-2\nstatus: blocked  # ESCALATION REQUIRED\ndeps: [T-1]\n---\n# Escalada' },
    ];
    const r = buildImport(files, {});
    expect(node(r, 't-2').status).toBe('pending');
    expect(r.warnings.some((w) => w.startsWith('«Escalada» pide algo a una persona; quedó Pendiente'))).toBe(true);
  });
});

// #35: una pregunta generada desde el archivo se reabre en cada --replace, choca con cerrarla (#33) y se
// duplica al renombrar. El import nunca manda «blocked» ni bloqueantes: avisa, y el agente pregunta en vivo
describe('el import no le pide nada al dueño por su cuenta', () => {
  const files = [
    { file: 'a.md', text: '---\nid: T-1\nstatus: ready\n---\n# Base' },
    { file: 'b.md', text: '---\nid: T-2\nstatus: blocked  # ESCALATION REQUIRED\ndeps: [T-1]\n---\n# Escalada' },
    { file: 'c.md', text: '---\nid: T-3\nstatus: blocked\n---\n# Suelta' },
    { file: 'd.md', text: '---\nid: T-4\nstatus: blocked\ndeps: [T-1]\n---\n# Espera a la base' },
  ];

  it('las tareas que piden algo a una persona quedan Pendiente, sin bloqueantes y con un aviso de PM', () => {
    const r = buildImport(files, {});
    expect(r.graph.nodes.map((n) => n.status)).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(r.graph.blockers).toBeUndefined();
    expect(r.stats.status.blocked).toBe(0);
    const asks = r.warnings.filter((w) => w.includes('pide algo a una persona'));
    expect(asks).toEqual([
      '«Escalada» pide algo a una persona; quedó Pendiente. Pregúntaselo en vivo con dagyard block',
      '«Suelta» pide algo a una persona; quedó Pendiente. Pregúntaselo en vivo con dagyard block',
    ]);
    const check = parseProjectGraphInput(r.graph);
    expect(check.ok ? 'ok' : check.message).toBe('ok');
  });

  it.each(['basalt', 'gateway', 'pets'])('%s: ninguna tarea blocked ni bloqueante', (repo) => {
    const r = buildImport(readTasksDir(dir(repo)), { dirName: repo });
    expect(r.graph.nodes.filter((n) => n.status === 'blocked')).toEqual([]);
    expect(r.graph.blockers).toBeUndefined();
  });
});

describe('contra el validador del modelo', () => {
  it.each(['basalt', 'gateway', 'pets'])('%s: el grafo pasa parseProjectGraphInput', (repo) => {
    const r = buildImport(readTasksDir(dir(repo)), { dirName: repo });
    const check = parseProjectGraphInput(r.graph);
    expect(check.ok ? 'ok' : check.message).toBe('ok');
  });

  it('una cadena de 20 niveles cabe en 12 etapas', () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      file: `t${i}.md`,
      text: `---\nid: T-${i}\ndeps: [${i ? `T-${i - 1}` : ''}]\n---\n# Paso ${i}`,
    }));
    const r = buildImport(files, { dirName: 'cadena' });
    expect(r.graph.stages).toHaveLength(MAX_STAGES);
    expect(r.graph.stages!.at(-1)!.name).toBe('Al final');
    expect(node(r, 't-19').stage).toBe('al-final');
    expect(new Set(r.graph.stages!.map((s) => s.name)).size).toBe(MAX_STAGES);
    expect(r.graph.stages!.map((s) => s.name).join(' ')).not.toMatch(/Etapa|\d/);
    expect(parseProjectGraphInput(r.graph).ok).toBe(true);
  });
});

describe('etapas por profundidad con nombre humano (#21)', () => {
  const chain = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      file: `t${i}.md`,
      text: `---\nid: T-${i}\ndeps: [${i ? `T-${i - 1}` : ''}]\n---\n# Paso ${i}`,
    }));
  const names = (n: number) => buildImport(chain(n), {}).graph.stages!.map((s) => s.name);

  it('la primera es «Para empezar», la última «Al final», las del medio en orden', () => {
    expect(names(1)).toEqual(['Para empezar']);
    expect(names(2)).toEqual(['Para empezar', 'Al final']);
    expect(names(4)).toEqual(['Para empezar', 'Después', 'Luego', 'Al final']);
    expect(names(5)).toEqual(['Para empezar', 'Después', 'Luego', 'Más adelante', 'Al final']);
  });
});

/** Cabeceras sintéticas de una tienda ficticia, con las mismas formas que las de un repo de tareas real. */
const SAMPLE_TITLES: Array<[file: string, text: string, expected: string]> = [
  ['L1-shared-cart-backend.md', '# Task L1 — Shared-cart backend (CORNERSTONE, payment-sensitive)\n\n**Role owner:** backend · **blockedBy:** none', 'Shared-cart backend'],
  ['L2-settings-modal.md', '# Task L2 — Drawer-style preferences modal + /account migration', 'Drawer-style preferences modal + account migration'],
  ['T-314-A.md', '# T-314-A — La RAMA reservar-vs-pagar, en el canal que llega a todo cliente', 'La rama reservar-vs-pagar, en el canal que llega a todo cliente'],
  ['T-440.md', '# T-440 — `.shop/lib/emit-event.sh`: el emisor de eventos de pedido', 'El emisor de eventos de pedido'],
  ['T-441-1.md', '# T-441-1 — `restock.sh` + plantillas de aviso', 'Plantillas de aviso'],
  ['T-458.md', '# T-458 — `bus.py cost`: costo por tienda y por repartidor', 'Costo por tienda y por repartidor'],
  ['T-467.md', '# T-467 — `stock_check_failed` dice CUÁL producto fue (`detail.sku_decision`)', 'stock_check_failed dice cuál producto fue'],
  ['T-476.md', '# T-476 — `<ProductCard>` como contexto de variantes abiertas (opción B)', 'ProductCard como contexto de variantes abiertas'],
  ['T-501.md', '---\nid: T-501\ntitle: "mercadito coupons revoke <code> no revoca nada — un .slice(1) de más, en silencio y con exit 0"\n---', 'Mercadito coupons revoke code no revoca nada — un slice de más, en silencio y con exit 0'],
  ['T-505.md', `---\nid: T-505\ntitle: "checkout.sh afirma 'pago completo' sobre un cobro sin shipping/ — cierra la brecha entre lo que dice y lo que cobra"\n---`, "Checkout afirma 'pago completo' sobre un cobro sin shipping — cierra la brecha entre lo que dice y lo que cobra"],
  ['T-512.md', '# T-512 — cross-store move must not drop the wholesale price floor', 'Cross-store move must not drop the wholesale price floor'],
  ['T-515.md', '# T-515 — API move_product must check the DESTINATION (the web twin already does)', 'API move_product must check the destination'],
  ['T-606-instrument.md', '# T-606-instrument — el instrumento falsificable de M1 + M2, ROJO POR CONSTRUCCIÓN', 'El instrumento falsificable de M1 + M2, rojo por construcción'],
  ['T-606-M1.md', '# T-606-M1 — el control de precios negativos corre en el CORE, que es el único escritor del catálogo', 'El control de precios negativos corre en el core, que es el único escritor del catálogo'],
  ['T-624.md', '# T-624 — DETERMINISM — `derive-tax-table.test.ts` deja de escribir un artefacto versionado del árbol', 'Derive-tax-table deja de escribir un artefacto versionado del árbol'],
  ['T-625.md', '# T-625 — `tests/orders.test.ts` deja de destruir y recrear un fixture TRACKEADO', 'Orders deja de destruir y recrear un fixture trackeado'],
  ['T-627.md', '# T-627 — `shipping-envelope.test.ts` deja de usar un path FIJO bajo `REPO_ROOT`', 'Shipping-envelope deja de usar un path fijo bajo repo root'],
  ['T-646.md', '# T-646 — the `price()` decider becomes derived', 'The price decider becomes derived'],
  ['T-901.md', '# T-901 — `receipt.sh`: el recibo deja de poder mentir sobre QUÉ TOTAL cobró (#538)', 'El recibo deja de poder mentir sobre qué total cobró'],
  ['T-PG02.md', '# T-PG02 — el `paths-ignore` de `deploy.yml` es más grueso que el radio real (#561)', 'El paths-ignore de deploy es más grueso que el radio real'],
  ['T-674.md', '# T-674 — La premisa de #674 está REFUTADA; lo que queda vivo es el instrumento', 'La premisa está refutada; lo que queda vivo es el instrumento'],
  ['T-701.md', '---\nid: T-701\ntitle: "Migration 0015 — zones per-store scoping (store_id, zone_id, last_used_at, archived_at)"\n---', 'Zones per-store scoping'],
  ['T-702.md', '---\nid: T-702\ntitle: "lib/store-creation.ts — createStore (transactional, idempotent, id==slug)"\n---', 'Create store'],
  ['T-703.md', '---\nid: T-703\ntitle: "lib/catalog-seed.ts — seedStarterCatalogStatements (sample rows, never is_featured)"\n---', 'Seed starter catalog statements'],
  ['T-706.md', '---\nid: T-706\ntitle: "lib/zone-codes.ts — create/rename/pause/list (z_ code, hash-only, store-scoped)"\n---', 'Create, rename, pause y list'],
  ['T-708.md', '---\nid: T-708\ntitle: "Shipping UI — /store/zones page + ZonesPanel + nav tab + one-time preview"\n---', 'Shipping UI — zones page + ZonesPanel + nav tab + one-time preview'],
  ['T-710.md', '---\nid: T-710\ntitle: "Phase-9 live verify — courier self-signup zone-binding + address_verified decision (RF1)"\n---', 'Live verify — courier self-signup zone-binding + address_verified decision'],
  ['T-801.md', '# T-801 — CAT — Ordenar el catálogo por tienda + API store-resolution', 'Ordenar el catálogo por tienda + API store-resolution'],
  ['T-803.md', '# T-803 — RES — Reserved-list unify + store-create guard + purga duplicados /shop//admin', 'Reserved-list unify + store-create guard + purga duplicados'],
  ['T-804.md', '# T-804 — NAV-CORE — El primitivo único de navegación (la fundación)', 'El primitivo único de navegación'],
  ['T-805.md', '# T-805 — CHROME — ProductTopBar deja de parsear + menú canónico + Share/Save en un control', 'ProductTopBar deja de parsear + menú canónico + Share y Save en un control'],
  ['T-DP01.md', '# T-DP01 — P0.1 llave cliente×tienda (personalCartKey)', 'Llave cliente×tienda'],
  ['T-DP03.md', '# T-DP03 — P1.2 search filters endpoint (`/api/store/search`, builder cerrado)', 'Search filters endpoint'],
  [
    'T-665.md',
    '# T-665 — role: oracle\n\n**Issue:** #665 — la reserva de stock del carrito es CONDICIONAL ⇒ queda una ventana\nde sobreventa de UN round-trip a la base.\n\n## Lo que hay que decidir',
    'La reserva de stock del carrito es condicional',
  ],
  [
    'T-666.md',
    '# T-666 — role: census\n\n**Issue:** #666 — el conteo de variantes por talla de #657 (**≥144**) es una **cota inferior\nestructural**: `size_variants` crece en runtime con cada `move_product`.\n\n## Lo que hay que decidir',
    'El conteo de variantes por talla es una cota inferior estructural',
  ],
];

describe('títulos legibles para un PM (#21)', () => {
  it.each(SAMPLE_TITLES)('%s', (file, text, expected) => {
    expect(buildImport([{ file, text }], {}).graph.nodes[0]!.title).toBe(expected);
  });

  it('sin rutas ni archivos, sin paréntesis, sin MAYÚSCULAS enfáticas, sin «Etapa N», nunca vacío', () => {
    const files = [
      ...['basalt', 'gateway', 'pets'].flatMap((repo) => readTasksDir(dir(repo))),
      ...SAMPLE_TITLES.map(([file, text]) => ({ file, text })),
    ];
    const r = buildImport(files, {});
    for (const n of r.graph.nodes) {
      expect(n.title.trim()).not.toBe('');
      expect(n.title).not.toMatch(/\//);
      expect(n.title).not.toMatch(/[()]/);
      expect(n.title).not.toMatch(/\.(?:ts|tsx|js|jsx|mjs|cjs|sh|py|ya?ml|json|sql|toml|md)\b/);
      expect(n.title).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/);
      expect(n.title).not.toMatch(/^role:/i);
      expect(n.title).not.toMatch(/(CORNERSTONE|ROJO|CUÁL|DESTINATION|TRACKEADO)/);
    }
    for (const s of r.graph.stages ?? []) expect(s.name).not.toMatch(/Etapa/);
  });
});

describe('projectNameFromDir', () => {
  it('sube de .cofoundy/tasks al nombre del repo', () => {
    expect(projectNameFromDir('/x/products/basalt/.cofoundy/tasks')).toBe('basalt');
    expect(projectNameFromDir('/x/tareas')).toBe('tareas');
  });
});

describe('buildImport con titles (#30)', () => {
  const files = () => readTasksDir(dir('basalt'));

  it('los títulos dados reemplazan a los sacados de la tarea; las demás quedan igual', () => {
    const plain = buildImport(files(), { dirName: 'basalt' });
    const r = buildImport(files(), {
      dirName: 'basalt',
      titles: { l1: 'Cada cliente con su propio espacio', 'T-599': '  Avisos\nmás claros  ' },
    });
    expect(node(r, 'l1').title).toBe('Cada cliente con su propio espacio');
    expect(node(r, 't-599').title).toBe('Avisos más claros'); // id de la tarea vale; espacios colapsados
    expect(node(r, 'l2').title).toBe(node(plain, 'l2').title);
    expect(node(r, 'l1').goal).toContain('Cada cliente con su propio espacio');
    expect(r.stats.titled).toBe(2);
    expect(plain.stats.titled).toBeUndefined();
    expect(r.warnings).toEqual(plain.warnings);
    expect(parseProjectGraphInput(r.graph).ok).toBe(true);
  });

  it('ids desconocidos, títulos vacíos, no-texto o largos solo avisan y no abortan', () => {
    const plain = buildImport(files(), { dirName: 'basalt' });
    const r = buildImport(files(), {
      dirName: 'basalt',
      titles: { 'no-existe': 'Algo', l1: 'x'.repeat(121), l2: '   ', l3: 42, 't-599': 'Avisos más claros' },
    });
    expect(node(r, 'l1').title).toBe(node(plain, 'l1').title);
    expect(node(r, 'l2').title).toBe(node(plain, 'l2').title);
    expect(node(r, 'l3').title).toBe(node(plain, 'l3').title);
    expect(node(r, 't-599').title).toBe('Avisos más claros');
    expect(r.stats.titled).toBe(1);
    const extra = r.warnings.filter((w) => w.startsWith('--titles'));
    expect(extra).toHaveLength(4);
    expect(extra.join('\n')).toContain('«no-existe»');
    expect(extra.join('\n')).toContain('121 caracteres (máximo 120)');
    expect(parseProjectGraphInput(r.graph).ok).toBe(true);
  });

  it('120 caracteres exactos (con tildes) entra; dos claves a la misma tarea avisan y gana la última', () => {
    const exact = 'á'.repeat(120);
    const r = buildImport(files(), { dirName: 'basalt', titles: { l1: exact, 'T-599': 'Uno', 't-599': 'Dos' } });
    expect(node(r, 'l1').title).toBe(exact);
    expect(node(r, 't-599').title).toBe('Dos');
    expect(r.warnings.some((w) => w.includes('misma tarea'))).toBe(true);
  });
});

describe('readTitles', () => {
  it('acepta JSON en línea o un archivo, y rechaza lo que no es un objeto', () => {
    expect(readTitles('{"l1":"Hola"}')).toEqual({ l1: 'Hola' });
    const f = join(mkdtempSync(join(tmpdir(), 'dagyard-titles-')), 't.json');
    writeFileSync(f, '{"l2":"Chau"}');
    expect(readTitles(f)).toEqual({ l2: 'Chau' });
    expect(() => readTitles('{l1:')).toThrow(/JSON/);
    expect(() => readTitles(join(tmpdir(), 'no-existe-dagyard.json'))).toThrow(/ni un archivo/);
    writeFileSync(f, '["a"]');
    expect(() => readTitles(f)).toThrow(/objeto/);
  });
});
