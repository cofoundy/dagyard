// Modelo de la UI, espejo de docs/spec/v0.md §«Modelo de datos mínimo».
// Cuando nucleo publique packages/model + docs/api.md, el único archivo que cambia es data/adapter.ts:
// la UI y la escena siguen consumiendo estos tipos.

export type NodeStatus = 'pending' | 'working' | 'blocked' | 'done';
export type BlockerKind = 'decision' | 'review' | 'access';
/** #90 (docs/spec/modelo.md de sprint/modelo): qué es un nodo. Sin el campo (servidor viejo), `task`. */
export type NodeKind = 'goal' | 'request' | 'task' | 'stream';
/** #90: con qué motivo se cerró. Un nodo cerrado queda `done`; `closedAs` dice cuál. */
export type CloseAs = 'done' | 'replaced' | 'dropped' | 'learned';

export interface ProjectSummary {
  id: string;
  name: string;
}

export interface Stage {
  id: string;
  name: string;
}

export interface DagNode {
  id: string;
  /** La vista DAG no lo lee; queda porque el cable lo exige hasta #90 (`stage` opcional). */
  stageId: string;
  title: string;
  status: NodeStatus;
  /** 0-1 */
  progress: number;
  /** Equipo o agente responsable, en lenguaje humano («Diseño»). */
  team?: string;
  goal?: string;
  reportUrl?: string;
  /** Detalle técnico (issue o PR). La ficha lo ofrece como «Detalle técnico», sin mostrar la URL. */
  link?: string;
  /*
   * #90. Todos opcionales: un servidor anterior no los manda y la vista los deriva (data/dag.ts).
   */
  kind?: NodeKind;
  /** Cuándo nació (ISO): el eje x. `bornAt` de #90 o, en un servidor viejo, el `createdAt` del nodo. */
  bornAt?: string;
  /** `request`: las palabras literales de la persona (datos: no se traducen). */
  quote?: string;
  quoteBy?: string;
  closedAs?: CloseAs;
  closedReason?: string;
  replacedBy?: string;
  closedAt?: string;
}

/** «Nació de» (#90): `to` nació de `from`, con su porqué. Nunca bloquea. */
export interface Origin {
  from: string;
  to: string;
  /** El porqué, tal como lo escribió quien la creó. */
  why?: string;
}

export interface Edge {
  from: string;
  to: string;
}

export type Resolution =
  | { kind: 'decision'; option: string }
  | { kind: 'review'; verdict: 'approve' | 'changes'; comment?: string }
  | { kind: 'access'; value: string };

export interface Blocker {
  id: string;
  nodeId: string;
  kind: BlockerKind;
  question: string;
  options: string[];
  /** Etiqueta humana del acceso pedido («Clave de la pasarela de pagos»). Solo `access`. */
  label?: string;
  /** Resumen legible de la resolución; nunca el valor de un acceso. */
  resolution?: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

export interface Message {
  id: string;
  nodeId: string;
  from: string;
  /** ≤280 caracteres */
  text: string;
  reportUrl?: string;
  at: string;
}

export interface Snapshot {
  project: ProjectSummary;
  stages: Stage[];
  nodes: DagNode[];
  edges: Edge[];
  /**
   * «Nació de» (#90). `undefined` = el servidor todavía no los conoce y la vista los deriva de las dependencias;
   * `[]` = los conoce y no hay ninguno.
   */
  origins?: Origin[];
  blockers: Blocker[];
  messages: Message[];
  /** Último `seq` de evento incluido en el snapshot; el WS reanuda desde aquí. */
  seq: number;
}

export type DagEvent =
  | { seq: number; type: 'node.added'; node: DagNode }
  | { seq: number; type: 'node.updated'; node: Partial<DagNode> & { id: string } }
  | { seq: number; type: 'node.removed'; nodeId: string }
  | { seq: number; type: 'edge.added'; edge: Edge }
  | { seq: number; type: 'edge.removed'; edge: Edge }
  | { seq: number; type: 'origin.added'; origin: Origin }
  | { seq: number; type: 'origin.removed'; origin: Pick<Origin, 'from' | 'to'> }
  | { seq: number; type: 'blocker.opened'; blocker: Blocker }
  | { seq: number; type: 'blocker.resolved'; blocker: Blocker }
  | { seq: number; type: 'message.posted'; message: Message };

export interface DagyardApi {
  /** Valida el token: lanza `UnauthorizedError` si no sirve. */
  listProjects(): Promise<ProjectSummary[]>;
  getSnapshot(projectId: string): Promise<Snapshot>;
  resolveBlocker(blockerId: string, resolution: Resolution): Promise<Blocker>;
  /** Devuelve la función para cerrar la suscripción. */
  subscribe(
    projectId: string,
    sinceSeq: number,
    handlers: {
      onEvent: (e: DagEvent) => void;
      onStatus?: (s: 'live' | 'reconnecting') => void;
      /** El servidor pide volver a cargar el snapshot (frame `resync` o proyecto reemplazado por un import). */
      onResync?: () => void;
    },
  ): () => void;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'UnauthorizedError';
  }
}
