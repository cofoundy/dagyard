// Contrato entre la escena three.js (src/scene/**) y la interfaz React (src/ui/**).
// La escena no conoce la API ni React: recibe el DAG ya resuelto (data/dag.ts → toSceneGraph), emite picks y anima
// lo que se le pide. Una sola vista (#75): x = cuándo nació cada tarea; líneas «necesita» y «nació de».

import type { CloseAs, NodeKind, NodeStatus } from '../data/types';

export interface SceneNode {
  id: string;
  title: string;
  status: NodeStatus;
  kind: NodeKind;
  /** Cuándo nació (ms): su x. */
  born: number;
  /** Motivo de cierre (#90); null = abierta. */
  closedAs: CloseAs | null;
  /** Sin propósito: se marca con un anillo punteado. */
  loose: boolean;
  /** Primer origen: de su tallo brota (fila). */
  parent: string | null;
  /** Lo que nació de ella, del más viejo al más nuevo. */
  children: string[];
  /** Su último cambio (ms): estado, mensaje o respuesta. Sin él, su nacimiento. Decide qué se nombra en «ahora». */
  touched?: number;
}

/** `needs`: `to` necesita a `from`. `origin`: `to` nació de `from`. En los dos, el extremo brillante es `to`. */
export interface SceneEdge {
  from: string;
  to: string;
  kind: 'needs' | 'origin';
}

export interface SceneGraph {
  nodes: SceneNode[];
  edges: SceneEdge[];
  /** El presente del proyecto (ms): el borde derecho del eje, donde se nombra lo vivo. */
  now: number;
  /** Momentos con actividad (ms): no se pliegan como silencio. */
  activity?: number[];
}

/** Zonas de la pantalla que tapa el HUD; la vista general encuadra dentro de lo que queda. */
export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Lo que tapa la ficha abierta (px desde el borde derecho y desde abajo): el vuelo a una tarea la deja a la vista. */
export interface CardArea {
  right: number;
  bottom: number;
}

export type SceneMode = 'intro' | 'overview' | 'focus';

export interface SceneHandlers {
  /** Click, tap o Enter sobre una estrella (id) o click sobre el vacío (null). */
  onPick: (id: string | null) => void;
  /** Cambio de modo hecho por la escena (p. ej. fin del travelling de entrada). */
  onModeChange?: (mode: SceneMode) => void;
}

export type Pulse = 'done' | 'working' | 'blocked' | 'born' | 'message';

export interface Sky {
  /**
   * Reconciliación declarativa: lo nuevo nace (animación de nacimiento), lo que falta se apaga, las líneas nuevas se
   * dibujan y los cambios de estado transicionan de color. Idempotente.
   */
  setGraph(graph: SceneGraph): void;
  /** Onda sobre una estrella (eventos del servidor); `done` además manda luz por lo que la necesitaba. */
  pulse(nodeId: string, kind: Pulse): void;
  /** Vuelve a la vista general (la cámara regresa de donde estaba). */
  overview(): void;
  /** La cámara vuela a la tarea; lo que no es su vecindario se apaga. */
  focus(nodeId: string): void;
  /** Resalta una estrella sin abrirla (el resultado activo de «Buscar»); null lo quita. */
  mark(nodeId: string | null): void;
  /** Repite el travelling de entrada (el grafo crece de izquierda a derecha). */
  replay(): void;
  setSafeArea(area: SafeArea): void;
  setCardArea(area: CardArea): void;
  dispose(): void;
}

export interface CreateSkyOptions {
  canvas: HTMLCanvasElement;
  /** Capa DOM para etiquetas, eje y blancos táctiles (position:absolute, inset:0). */
  labels: HTMLElement;
  handlers: SceneHandlers;
  safeArea: SafeArea;
}

/** Implementación en src/scene/index.ts: `export function createSky(opts: CreateSkyOptions): Sky`. */
export type CreateSky = (opts: CreateSkyOptions) => Sky;
