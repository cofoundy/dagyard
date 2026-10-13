// El borde de «ahora» (#107): qué se nombra con su hilo y qué se agrupa. Puro: nodos → dos listas.
//
// Un hilo con nombre por cada tarea abierta, con 13+ abiertas, vuelve a leerse como carriles (lo que André rechazó,
// intención §1 Mensaje 10). Se nombra solo lo que te espera y lo que cambió en la última hora, hasta `max`; el resto
// abierto queda en un grupo «+N más en curso» que se despliega (dagyard-design/design/arbol/handoff.md, abierto 1).

import type { SceneNode } from './contract';

export interface NowEdgeOptions {
  now: number;
  /** Hilos con nombre, como mucho. */
  max?: number;
  /** Lo que cambió hace menos que esto se nombra (ms). */
  recentMs?: number;
}

export interface NowEdge {
  /** Con hilo hasta «ahora» y su nombre: lo que te espera primero, después lo más reciente. */
  named: string[];
  /** Abiertas sin hilo, en el mismo orden: el grupo que se despliega. */
  grouped: string[];
}

export const NOW_EDGE_MAX = 6;
export const NOW_EDGE_RECENT = 60 * 60e3;

const open = (n: SceneNode) => n.status === 'working' || n.status === 'blocked';

export function nowEdge(nodes: readonly SceneNode[], o: NowEdgeOptions): NowEdge {
  const max = o.max ?? NOW_EDGE_MAX;
  const recentMs = o.recentMs ?? NOW_EDGE_RECENT;
  const touched = (n: SceneNode) => n.touched ?? n.born;
  const list = nodes
    .filter(open)
    .sort((a, b) => Number(b.status === 'blocked') - Number(a.status === 'blocked') || touched(b) - touched(a) || a.id.localeCompare(b.id, 'en', { numeric: true }));
  const named: string[] = [];
  const grouped: string[] = [];
  for (const n of list) {
    const lively = n.status === 'blocked' || o.now - touched(n) < recentMs;
    (lively && named.length < max ? named : grouped).push(n.id);
  }
  return { named, grouped };
}
