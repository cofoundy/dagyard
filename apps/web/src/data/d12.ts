// Puente con el modelo del DAG (#90, docs/spec/modelo.md de sprint/modelo), aislado aquí hasta que entre a main.
// El cable de esta rama (`@dagyard/model`) todavía no tiene `kind`, `bornAt`, `origins` ni `closedAs`: este archivo los
// lee SI vienen (un servidor con #90) y, si no, deja que la vista los derive (data/dag.ts).
//
// Para enchufar #90: cuando `@dagyard/model` exporte `Origin` y los campos nuevos de `DagNode`, se reemplazan los
// `Partial<D12…>` de abajo por los tipos del paquete, `toEvent` maneja `origin.added|removed` en su `switch` y este
// archivo se borra. Nada más de la web cambia: la UI ya consume `./types`.

import type { CloseAs, DagEvent, DagNode, NodeKind, Origin } from './types';

/** Los campos de #90 en un nodo del cable, tal como los define el spec. */
interface D12Node {
  kind: NodeKind;
  bornAt: string;
  quote: string | null;
  quoteBy: string | null;
  closedAs: CloseAs | null;
  closedReason: string | null;
  replacedBy: string | null;
  closedAt: string | null;
  createdAt: string;
}

interface D12Origin {
  from: string;
  to: string;
  why: string | null;
}

const KINDS: readonly NodeKind[] = ['goal', 'request', 'task', 'stream'];
const CLOSES: readonly CloseAs[] = ['done', 'replaced', 'dropped', 'learned'];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const iso = (v: unknown): string | undefined => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : undefined);

/** Lo de #90 que trae un nodo del cable; en un servidor viejo, solo `bornAt` (= su `createdAt`). */
export function readD12Node(wire: object): Partial<DagNode> {
  const n = wire as Partial<D12Node>;
  const out: Partial<DagNode> = {};
  if (n.kind && KINDS.includes(n.kind)) out.kind = n.kind;
  const born = iso(n.bornAt) ?? iso(n.createdAt);
  if (born) out.bornAt = born;
  const quote = str(n.quote);
  if (quote) out.quote = quote;
  const quoteBy = str(n.quoteBy);
  if (quoteBy) out.quoteBy = quoteBy;
  if (n.closedAs && CLOSES.includes(n.closedAs)) out.closedAs = n.closedAs;
  const reason = str(n.closedReason);
  if (reason) out.closedReason = reason;
  const by = str(n.replacedBy);
  if (by) out.replacedBy = by;
  const closedAt = iso(n.closedAt);
  if (closedAt) out.closedAt = closedAt;
  return out;
}

function toOrigin(o: Partial<D12Origin>): Origin | null {
  if (typeof o.from !== 'string' || typeof o.to !== 'string' || !o.from || !o.to) return null;
  const why = str(o.why);
  return why ? { from: o.from, to: o.to, why } : { from: o.from, to: o.to };
}

/** Los orígenes del snapshot, o `undefined` si el servidor todavía no habla #90 (la vista los deriva). */
export function readOrigins(wireSnapshot: object): Origin[] | undefined {
  const list = (wireSnapshot as { origins?: unknown }).origins;
  if (!Array.isArray(list)) return undefined;
  return list.map((o) => toOrigin(o as Partial<D12Origin>)).filter((o): o is Origin => !!o);
}

/**
 * Un evento de #90 que el cable de esta rama no conoce. `undefined` = no es de #90 (sigue el `switch` de siempre);
 * `null` = es de #90 pero no se puede leer (la UI recarga el snapshot).
 */
export function readD12Event(e: { type: string; seq: number; payload?: unknown }): DagEvent | null | undefined {
  if (e.type !== 'origin.added' && e.type !== 'origin.removed') return undefined;
  const o = toOrigin(((e.payload ?? {}) as { origin?: Partial<D12Origin> }).origin ?? {});
  if (!o) return null;
  return e.type === 'origin.added' ? { seq: e.seq, type: 'origin.added', origin: o } : { seq: e.seq, type: 'origin.removed', origin: { from: o.from, to: o.to } };
}
