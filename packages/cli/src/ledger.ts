/**
 * El ledger de la fábrica (`~/cofoundy/.coordination/factory/sites.jsonl`) → equipos de Dagyard (#75). Puro: sin
 * red ni disco, así lo usan `dagyard import-ledger` y los tests del Worker con el mismo código.
 *
 * Cada fila es un evento de un sitio: `requested` (con `issues`), `started`, `closed` (con `outcome`); el resto
 * (`bitacora_reserved`, `identified`…) no cambia el equipo. Las fechas son las del sitio.
 */
import { TEAM_LIMITS, isSlug, normalizeIso, slugify, type IsoDate, type Team } from '@dagyard/model';

export interface LedgerRow {
  site: string;
  event: string;
  ts: string;
  repo?: string;
  issues?: unknown[];
  outcome?: string;
}

/** Un equipo según el ledger: lo que `PUT /teams/:tid` recibe, sin el nombre (el ledger no lo trae). */
export interface LedgerTeam {
  id: string;
  nodeIds: string[];
  requestedAt: IsoDate | null;
  startedAt: IsoDate | null;
  closedAt: IsoDate | null;
  outcome: string | null;
}

/** El archivo como JSONL (el ledger real) o como un array JSON (una copia ya filtrada, p. ej. `design/tiempo/data/sites.json`). */
export function parseLedger(text: string): { rows: LedgerRow[]; invalid: number } {
  const trimmed = text.trim();
  let raw: unknown[];
  let invalid = 0;
  if (trimmed.startsWith('[')) {
    raw = JSON.parse(trimmed) as unknown[];
  } else {
    raw = [];
    for (const line of trimmed.split('\n')) {
      if (!line.trim()) continue;
      try {
        raw.push(JSON.parse(line));
      } catch {
        invalid++;
      }
    }
  }
  const rows: LedgerRow[] = [];
  for (const r of raw) {
    const o = r as Partial<LedgerRow> | null;
    if (!o || typeof o.site !== 'string' || typeof o.event !== 'string' || typeof o.ts !== 'string') {
      invalid++;
      continue;
    }
    rows.push(o as LedgerRow);
  }
  return { rows, invalid };
}

/**
 * Los equipos de un repo, en el orden en que arrancaron. Filas con otro `repo` no cuentan; las que no traen
 * `repo` solo cuentan si ninguna fila del archivo lo trae (una copia ya filtrada a un repo).
 *
 * Por sitio: `requestedAt` = el primer `requested`, `startedAt` = el primer `started`, `closedAt`/`outcome` = el
 * último `closed`; un `requested` o `started` después de cerrar lo reabre. `issues: ["75"]` → `gh-75`.
 */
export function teamsFromLedger(rows: readonly LedgerRow[], repo: string | null): { teams: LedgerTeam[]; skipped: number } {
  const anyRepo = rows.some((r) => typeof r.repo === 'string');
  const mine = rows
    .map((r, i) => ({ r, i, at: normalizeIso(r.ts) }))
    .filter(({ r, at }) => at !== null && (anyRepo ? r.repo === repo : true))
    .sort((a, b) => (a.at! < b.at! ? -1 : a.at! > b.at! ? 1 : a.i - b.i));
  const skipped = rows.length - mine.length;
  const byId = new Map<string, LedgerTeam>();
  for (const { r, at } of mine) {
    const id = isSlug(r.site) ? r.site : slugify(r.site);
    let t = byId.get(id);
    if (!t) byId.set(id, (t = { id, nodeIds: [], requestedAt: null, startedAt: null, closedAt: null, outcome: null }));
    const reopen = () => {
      t!.closedAt = null;
      t!.outcome = null;
    };
    if (r.event === 'requested') {
      t.requestedAt ??= at;
      if (t.closedAt) reopen();
      for (const issue of r.issues ?? []) {
        const n = String(issue).trim().replace(/^#/, '');
        const nid = `gh-${n}`;
        if (/^\d+$/.test(n) && !t.nodeIds.includes(nid) && t.nodeIds.length < TEAM_LIMITS.nodeIds) t.nodeIds.push(nid);
      }
    } else if (r.event === 'started') {
      t.startedAt ??= at;
      if (t.closedAt) reopen();
    } else if (r.event === 'closed') {
      t.closedAt = at;
      const outcome = typeof r.outcome === 'string' ? r.outcome.trim() : '';
      t.outcome = outcome ? [...outcome].slice(0, TEAM_LIMITS.outcome).join('') : null;
    }
  }
  const teams = [...byId.values()];
  const key = (t: LedgerTeam) => t.startedAt ?? t.requestedAt ?? '';
  // por llegada: cuándo arrancó (o se pidió, si nunca arrancó); estable a igualdad
  teams.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return { teams, skipped };
}

/**
 * Lo que hay que mandarle al servidor para que el equipo quede como dice el ledger, o null si ya está así. El ledger
 * manda en las fechas y el desenlace que conoce; lo que no conoce (null) no borra lo que el servidor ya tiene. Las
 * tareas se suman a las que el equipo ya lleva (un `dagyard start` pudo agregar otras).
 */
export function teamPatchFromLedger(l: LedgerTeam, current: Team | undefined): Partial<Omit<LedgerTeam, 'id'>> | null {
  if (!current) {
    const patch: Partial<Omit<LedgerTeam, 'id'>> = { nodeIds: l.nodeIds };
    for (const k of ['requestedAt', 'startedAt', 'closedAt', 'outcome'] as const) if (l[k] !== null) patch[k] = l[k];
    return patch;
  }
  const patch: Partial<Omit<LedgerTeam, 'id'>> = {};
  const extra = l.nodeIds.filter((id) => !current.nodeIds.includes(id));
  if (extra.length) patch.nodeIds = [...current.nodeIds, ...extra].slice(0, TEAM_LIMITS.nodeIds);
  if (patch.nodeIds && patch.nodeIds.length === current.nodeIds.length) delete patch.nodeIds;
  for (const k of ['requestedAt', 'startedAt', 'closedAt', 'outcome'] as const) if (l[k] !== null && l[k] !== current[k]) patch[k] = l[k];
  return Object.keys(patch).length ? patch : null;
}
