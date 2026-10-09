// Estado vivo de un proyecto: snapshot inicial + eventos del servidor por el reducer puro.
// Sin React, para poder probarlo; la interfaz lo lee con useSyncExternalStore.

import { reduce, upsertBlocker } from './reduce';
import { UnauthorizedError, type Blocker, type DagEvent, type DagyardApi, type Resolution, type Snapshot } from './types';

export type StoreStatus = 'loading' | 'live' | 'reconnecting' | 'error';

export interface StoreState {
  snapshot: Snapshot | null;
  status: StoreStatus;
}

export interface StoreChange {
  prev: Snapshot;
  next: Snapshot;
  event: DagEvent;
}

export interface ProjectStoreOptions {
  /** Cada evento aplicado, con el antes y el después (para pulsos y avisos). */
  onChange?: (c: StoreChange) => void;
  /** La sesión venció: la interfaz vuelve a pedir la clave. */
  onUnauthorized?: () => void;
}

export class ProjectStore {
  private state: StoreState = { snapshot: null, status: 'loading' };
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly api: DagyardApi,
    readonly projectId: string,
    private readonly opts: ProjectStoreOptions = {},
  ) {}

  getState = (): StoreState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Carga el snapshot y abre el tiempo real desde su `seq`. También sirve para un resync. */
  start(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async resolve(blockerId: string, resolution: Resolution): Promise<Blocker> {
    const b = await this.api.resolveBlocker(blockerId, resolution);
    const s = this.state.snapshot;
    // La respuesta llega antes que el evento: se aplica ya, sin tocar el `seq`. El evento posterior es idempotente.
    if (s && !this.disposed) this.set({ snapshot: upsertBlocker(s, b) });
    return b;
  }

  /** «Enlazarlo»: el cambio llega por el tiempo real, como cualquier otro. */
  link(from: string, to: string, why?: string): Promise<void> {
    return this.api.linkOrigin(this.projectId, from, to, why);
  }

  /** «Dejarlo ir»: se cierra como descartada. */
  drop(nodeId: string, why?: string): Promise<void> {
    return this.api.dropNode(this.projectId, nodeId, why);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }

  private async load(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (!this.state.snapshot) this.set({ status: 'loading' });
    let snap: Snapshot;
    try {
      snap = await this.api.getSnapshot(this.projectId);
    } catch (e) {
      if (this.disposed) return;
      if (e instanceof UnauthorizedError) {
        this.opts.onUnauthorized?.();
        return;
      }
      this.set({ status: 'error' });
      throw e;
    }
    if (this.disposed) return;
    this.set({ snapshot: snap, status: this.state.status === 'live' ? 'live' : 'reconnecting' });
    this.unsubscribe = this.api.subscribe(this.projectId, snap.seq, {
      onEvent: (e) => this.apply(e),
      onStatus: (st) => this.set({ status: st }),
      onResync: () => void this.start().catch(() => {}),
    });
  }

  private apply(event: DagEvent): void {
    const prev = this.state.snapshot;
    if (!prev || this.disposed) return;
    const next = reduce(prev, event);
    if (next === prev) return;
    this.set({ snapshot: next });
    this.opts.onChange?.({ prev, next, event });
  }

  private set(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }
}
