// La migración D12 (#90) del proyecto «dagyard», sin dependencias de Node: la usan `migrate-d12.mjs` (con la clave
// de agente) y el test contra el Worker local. Solo agrega por la API granular (POST de nodos y aristas «nació de»),
// nunca borra ni reemplaza: lo que ya existe se salta, así la segunda corrida no escribe nada.

/**
 * @typedef {{ id: string, title: string, bornAt?: string }} GoalRow
 * @typedef {GoalRow & { quote: string, quoteBy?: string, from: string, why?: string }} RequestRow
 * @typedef {{ from: string, to: string, why?: string }} OriginRow
 * @typedef {{ project: string, goals: GoalRow[], requests: RequestRow[], origins: OriginRow[] }} D12Data
 * @typedef {{ goals: number, requests: number, origins: number, skipped: number, missing: string[], orphans: string[] }} D12Report
 */

/**
 * Corre la migración. `call(method, path, body?)` hace la petición ya autenticada y devuelve la `Response`.
 * Con `dryRun` solo lee: cuenta lo que crearía como si ya lo hubiera creado.
 * @param {(method: string, path: string, body?: unknown) => Promise<Response>} call
 * @param {D12Data} data
 * @param {{ project?: string, dryRun?: boolean }} [opts]
 * @returns {Promise<D12Report>}
 */
export async function migrateD12(call, data, opts = {}) {
  const pid = opts.project ?? data.project;
  const base = `/api/projects/${encodeURIComponent(pid)}`;
  const snap = await json(await call('GET', base), `GET ${base}`);
  const nodes = new Set(snap.nodes.map((/** @type {{ id: string }} */ n) => n.id));
  const born = new Set((snap.origins ?? []).map((/** @type {{ from: string, to: string }} */ o) => `${o.from}\u0000${o.to}`));
  /** @type {D12Report} */
  const report = { goals: 0, requests: 0, origins: 0, skipped: 0, missing: [], orphans: [] };
  const write = async (/** @type {string} */ path, /** @type {unknown} */ body) => {
    if (!opts.dryRun) await json(await call('POST', `${base}${path}`, body), `POST ${base}${path}`);
  };

  for (const g of data.goals) {
    if (nodes.has(g.id)) {
      report.skipped++;
      continue;
    }
    await write('/nodes', { id: g.id, title: g.title, kind: 'goal', ...(g.bornAt && { bornAt: g.bornAt }) });
    nodes.add(g.id);
    report.goals++;
  }

  // un pedido nace con su «nació de»; si ya existía, su origen va con los demás
  const origins = [...data.requests.map((r) => ({ from: r.from, to: r.id, why: r.why })), ...data.origins];
  for (const r of data.requests) {
    if (nodes.has(r.id)) {
      report.skipped++;
      continue;
    }
    if (!nodes.has(r.from)) {
      report.missing.push(r.from);
      continue;
    }
    const origin = { from: r.from, ...(r.why && { why: r.why }) };
    await write('/nodes', { id: r.id, title: r.title, kind: 'request', quote: r.quote, ...(r.quoteBy && { quoteBy: r.quoteBy }), ...(r.bornAt && { bornAt: r.bornAt }), origins: [origin] });
    nodes.add(r.id);
    born.add(`${r.from}\u0000${r.id}`);
    report.requests++;
  }

  for (const o of origins) {
    const key = `${o.from}\u0000${o.to}`;
    if (born.has(key)) {
      // el que acaba de nacer con su pedido no cuenta como saltado
      if (!data.requests.some((r) => r.id === o.to && r.from === o.from)) report.skipped++;
      continue;
    }
    const gone = [o.from, o.to].filter((id) => !nodes.has(id));
    if (gone.length) {
      for (const id of gone) if (!report.missing.includes(id)) report.missing.push(id);
      continue;
    }
    await write('/edges', { from: o.from, to: o.to, kind: 'origin', ...(o.why && { why: o.why }) });
    born.add(key);
    report.origins++;
  }

  // las tareas que siguen sin «nació de» (el §Verifica del spec espera 0)
  const withOrigin = new Set([...born].map((k) => k.split('\u0000')[1]));
  const kinds = new Map(snap.nodes.map((/** @type {{ id: string, kind?: string }} */ n) => [n.id, n.kind ?? 'task']));
  report.orphans = [...kinds].filter(([id, k]) => k === 'task' && !withOrigin.has(id)).map(([id]) => id);
  return report;
}

/** «Creé 1 objetivo, 10 pedidos y 53 orígenes; 0 ya estaban.» */
export function formatD12(/** @type {D12Report} */ r, dryRun = false) {
  const lines = [
    `${dryRun ? '(simulación, no escribí nada) Crearía' : 'Creé'} ${r.goals} objetivos, ${r.requests} pedidos y ${r.origins} orígenes; ${r.skipped} ya estaban.`,
  ];
  if (r.missing.length) lines.push(`No existen en el proyecto (salté lo que los usa): ${r.missing.join(', ')}`);
  if (r.orphans.length) lines.push(`Tareas que siguen sin «nació de» (${r.orphans.length}): ${r.orphans.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

/** @param {Response} res @param {string} what */
async function json(res, what) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
