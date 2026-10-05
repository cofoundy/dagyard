/**
 * El modelo de Dagyard. Contrato compartido por el Worker (apps/worker), la UI (apps/web)
 * y el CLI (packages/cli). La prosa del contrato vive en docs/api.md; si difieren, gana este archivo.
 */

/** Estado de una tarea. La UI los muestra como: Pendiente, En progreso, Te espera, Lista. */
export type NodeStatus = 'pending' | 'working' | 'blocked' | 'done';
export const NODE_STATUSES: readonly NodeStatus[] = ['pending', 'working', 'blocked', 'done'];

/** Qué le pide un agente al humano. La UI: Necesita tu decisión / revisión / un acceso. */
export type BlockerKind = 'decision' | 'review' | 'access';
export const BLOCKER_KINDS: readonly BlockerKind[] = ['decision', 'review', 'access'];

export type BlockerStatus = 'open' | 'resolved';

/**
 * Tipo de nodo (#90, D12). `goal`: un resultado vivo, raíz de los porqués. `request`: el pedido o la decisión de una
 * persona, con su cita. `task`: un dueño, una sesión, un `/goal`. `stream`: trabajo continuo que suelta tareas. Solo
 * una `task` arranca (`next`); `goal` y `stream` no se cierran como `done`.
 */
export type NodeKind = 'goal' | 'request' | 'task' | 'stream';
export const NODE_KINDS: readonly NodeKind[] = ['goal', 'request', 'task', 'stream'];
/** El de un nodo guardado antes de #90 (o de un servidor viejo). */
export const DEFAULT_KIND: NodeKind = 'task';

/** Motivo de cierre (#90): lista, reemplazada, descartada o «aprendimos». */
export type CloseAs = 'done' | 'replaced' | 'dropped' | 'learned';
export const CLOSE_AS: readonly CloseAs[] = ['done', 'replaced', 'dropped', 'learned'];

/** Las dos aristas (#90): «necesita» (`Edge`) y «nació de» (`Origin`). */
export type EdgeKind = 'requires' | 'origin';
export const EDGE_KINDS: readonly EdgeKind[] = ['requires', 'origin'];

/** Quién hizo una escritura: el dueño desde la UI o un agente con la API key. */
export type Role = 'owner' | 'agent';

/** Fecha ISO 8601 en UTC, p. ej. `2026-10-04T05:30:00.000Z`. */
export type IsoDate = string;

export interface Stage {
  /** slug estable, p. ej. `construccion` */
  id: string;
  /** nombre humano, p. ej. `Construcción` */
  name: string;
}

/**
 * Idioma de los datos de un proyecto (#77): en qué idioma escribe el CLI las etapas, misiones y opciones por
 * defecto. Lo fija el proyecto, no el entorno de quien lo toca. Los mensajes de consola siguen a `LANG`.
 */
export type Lang = 'en' | 'es';
export const LANGS: readonly Lang[] = ['en', 'es'];
/** El de un proyecto nuevo. */
export const DEFAULT_LANG: Lang = 'en';
/** Cómo se lee un proyecto guardado antes de que existiera el campo (`dagyard`, las demos). */
export const LEGACY_LANG: Lang = 'es';

/** El idioma de un proyecto; sin el campo (guardado antes de #77, o un servidor viejo), español. */
export function projectLang(p: { lang?: Lang | null }): Lang {
  return p.lang ?? LEGACY_LANG;
}

export interface Project {
  /** slug, p. ej. `marketplace-reservas` */
  id: string;
  name: string;
  /** idioma de los datos que escribe el CLI (ver `Lang`) */
  lang: Lang;
  /** en orden */
  stages: Stage[];
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface DagNode {
  /** slug único dentro del proyecto */
  id: string;
  projectId: string;
  /** id de una etapa del proyecto */
  stage: string;
  /** título humano: «Pagos con tarjeta», nunca `T-402` */
  title: string;
  status: NodeStatus;
  /** 0..1 */
  progress: number;
  /** equipo o agente a cargo, p. ej. `Construcción`; null si nadie la tomó */
  team: string | null;
  /** misión de una línea que se le inyecta al agente como `/goal` */
  goal: string | null;
  /** informe en Basalt */
  reportUrl: string | null;
  /** detalle técnico: URL del issue o del PR. La UI lo muestra como «Detalle técnico ↗», sin jerga */
  link: string | null;
  /** primera vez que pasó a `working` (#75); null si nunca arrancó. Opcional: datos previos a #75 */
  startedAt?: IsoDate | null;
  /** cuándo pasó a `done` (#75); null si no está lista */
  doneAt?: IsoDate | null;
  /** id del `Team` (sitio de la fábrica) que la tomó (#75); null si no se sabe */
  teamId?: string | null;
  /*
   * #90: siempre presentes en un snapshot; opcionales en el tipo solo para leer servidores viejos (sin el campo, el
   * nodo es una `task` nacida en `createdAt`, abierta salvo que esté `done`).
   */
  /** tipo (ver `NodeKind`) */
  kind?: NodeKind;
  /** cuándo nació: el eje x del tiempo. Por defecto la hora de la escritura; nunca en el futuro */
  bornAt?: IsoDate;
  /** `request`: la cita literal de la persona. Los demás: null */
  quote?: string | null;
  /** `request`: quién lo dijo, p. ej. «André». Opcional */
  quoteBy?: string | null;
  /** motivo de cierre; null = abierto. Un nodo cerrado queda en `status: 'done'` */
  closedAs?: CloseAs | null;
  /** por qué se cerró; obligatorio para `replaced`, `dropped` y `learned` */
  closedReason?: string | null;
  /** id del nodo que lo reemplaza; solo con `replaced` */
  replacedBy?: string | null;
  /** cuándo se cerró */
  closedAt?: IsoDate | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/**
 * Un equipo de la fábrica: un sitio de `/factory` que arrancó, llevó unas tareas y cerró (#75).
 * Es lo que la vista en el tiempo dibuja como un carril. Sus fechas son las del sitio (no las de la
 * escritura), así la historia se puede traer después desde el ledger de la fábrica.
 */
export interface Team {
  /** slug del sitio, p. ej. `tiempo`; único por proyecto */
  id: string;
  projectId: string;
  /** nombre humano, p. ej. «Tiempo» */
  name: string;
  /** ids de los nodos que lleva, p. ej. `["gh-75"]` (pueden no existir todavía en el grafo) */
  nodeIds: string[];
  requestedAt: IsoDate | null;
  startedAt: IsoDate | null;
  closedAt: IsoDate | null;
  /** cómo cerró: `merged`, `pr-open`, `stopped`…; null si sigue abierto */
  outcome: string | null;
  updatedAt: IsoDate;
}

/** Dependencia («necesita»): `to` necesita que `from` esté cerrada. `from` nunca es un `goal` ni un `stream`. */
export interface Edge {
  projectId: string;
  from: string;
  to: string;
}

/** «Nació de» (#90): `to` nació de `from`, con su porqué. Nunca bloquea ni entra en `next`. */
export interface Origin {
  projectId: string;
  from: string;
  to: string;
  /** el porqué, ≤280; null si no se dijo */
  why: string | null;
  createdAt: IsoDate;
}

export interface BlockerResolution {
  /** decision/review: el texto de la opción elegida */
  choice: string | null;
  /** nota libre del humano (p. ej. qué cambiar en una revisión) */
  note: string | null;
  /** access: true si se guardó un valor. El valor NUNCA viaja en snapshots ni eventos. */
  hasValue: boolean;
}

export interface Blocker {
  /** `b_` + aleatorio */
  id: string;
  projectId: string;
  nodeId: string;
  kind: BlockerKind;
  /** la pregunta, en corto y en humano */
  question: string;
  /** decision/review: opciones (≥1). access: [] */
  options: string[];
  /** access: nombre del acceso, p. ej. «Clave de la pasarela de pagos». Otros: null */
  accessLabel: string | null;
  status: BlockerStatus;
  resolution: BlockerResolution | null;
  resolvedBy: Role | null;
  resolvedAt: IsoDate | null;
  createdAt: IsoDate;
}

/** Lo que devuelve `wait` a un agente: incluye el valor del acceso (solo con API key). */
export interface BlockerWaitResult {
  blocker: Blocker;
  /** solo `access` resuelto y solo para el rol `agent` */
  value: string | null;
}

export interface Message {
  /** `m_` + aleatorio */
  id: string;
  projectId: string;
  nodeId: string;
  /** quién escribe, p. ej. `Equipo de Diseño` */
  from: string;
  /** ≤280 caracteres: concisión por diseño */
  text: string;
  reportUrl: string | null;
  createdAt: IsoDate;
}

/* ------------------------------------------------------------------ eventos */

export type DagEvent =
  | EventBase<'project.replaced', { project: Project }>
  | EventBase<'project.updated', { project: Project }>
  | EventBase<'node.added', { node: DagNode }>
  | EventBase<'node.updated', { node: DagNode }>
  /** ya nada lo emite (#90: ningún camino borra un nodo); queda para reproducir logs viejos */
  | EventBase<'node.removed', { nodeId: string }>
  | EventBase<'edge.added', { edge: Edge }>
  | EventBase<'edge.removed', { edge: Edge }>
  | EventBase<'origin.added', { origin: Origin }>
  | EventBase<'origin.removed', { origin: Pick<Origin, 'projectId' | 'from' | 'to'> }>
  | EventBase<'blocker.opened', { blocker: Blocker }>
  | EventBase<'blocker.resolved', { blocker: Blocker }>
  | EventBase<'message.posted', { message: Message }>
  | EventBase<'team.updated', { team: Team }>;

export type DagEventType = DagEvent['type'];

interface EventBase<T extends string, P> {
  /** monotónico por proyecto, empieza en 1 */
  seq: number;
  projectId: string;
  type: T;
  actor: Role;
  at: IsoDate;
  payload: P;
}

/* ------------------------------------------------------------------ lecturas */

/** `GET /api/projects/:id` — todo lo que la UI necesita para pintar el grafo. */
export interface ProjectSnapshot {
  project: Project;
  nodes: DagNode[];
  /** «necesita» */
  edges: Edge[];
  /** «nació de» (#90). Opcional: servidores previos a #90 */
  origins?: Origin[];
  /** abiertos y resueltos, sin valores de acceso */
  blockers: Blocker[];
  /** los últimos 200, del más viejo al más nuevo */
  messages: Message[];
  /** los equipos de la fábrica (#75), por `startedAt`. Opcional: servidores previos a #75 */
  teams?: Team[];
  /** seq del último evento aplicado: la UI se suscribe al WebSocket con `?since=<seq>` */
  seq: number;
}

export interface ProjectCounts {
  total: number;
  pending: number;
  working: number;
  blocked: number;
  done: number;
}

/** `GET /api/projects` */
export interface ProjectSummary {
  id: string;
  name: string;
  stages: Stage[];
  counts: ProjectCounts;
  /** bloqueantes abiertos: lo que le toca al humano */
  openBlockers: number;
  updatedAt: IsoDate;
}

/** `GET /api/projects/:id/next` */
export interface NextResult {
  node: DagNode | null;
  /** lista para pegar: `/goal <misión>`; null si no hay nodo arrancable */
  goalLine: string | null;
}

/* ------------------------------------------------------------------ escrituras */

export interface StageInput {
  id?: string;
  name: string;
}

/** Un «nació de» al crear un nodo: el nodo del que nace y por qué. */
export interface OriginInput {
  from: string;
  why?: string | null;
}

export interface NodeInput {
  id?: string;
  /** si falta, la primera etapa del proyecto (#90) */
  stage?: string;
  title: string;
  /** default `task` (#90) */
  kind?: NodeKind;
  /** default la hora de la escritura; nunca en el futuro (#90) */
  bornAt?: IsoDate;
  /** `request`: obligatoria (#90) */
  quote?: string | null;
  quoteBy?: string | null;
  status?: NodeStatus;
  progress?: number;
  team?: string | null;
  goal?: string | null;
  reportUrl?: string | null;
  /** detalle técnico: URL del issue o del PR */
  link?: string | null;
  /** ids de los nodos de los que depende (aristas from → este nodo) */
  deps?: string[];
  /** de qué nodos nace (#90) */
  origins?: OriginInput[];
}

export type NodePatch = Partial<Omit<NodeInput, 'id' | 'deps' | 'origins' | 'bornAt'>>;

/** `POST /api/projects/:pid/nodes/:nid/close` (#90): cierra con motivo. */
export interface CloseInput {
  as: CloseAs;
  /** el porqué; obligatorio para `replaced`, `dropped` y `learned`. Para una `task` `done`, es evidencia */
  why?: string | null;
  /** `replaced`: el nodo que la reemplaza (obligatorio); prohibido con los demás */
  by?: string;
  /** el informe: evidencia de una `task` `done` */
  reportUrl?: string | null;
}

/** `POST /api/projects/:pid/edges` (#90): sin `kind`, «necesita». `why` solo con `origin`. */
export interface EdgeInput {
  from: string;
  to: string;
  kind?: EdgeKind;
  why?: string | null;
}

export interface BlockerInput {
  kind: BlockerKind;
  question: string;
  /** decision: ≥1. review: si falta, el servidor pone REVIEW_OPTIONS en el idioma del proyecto. access: [] */
  options?: string[];
  accessLabel?: string | null;
}

export interface ResolveInput {
  /** decision/review: índice (0..n-1) o el texto exacto de la opción */
  choice?: number | string;
  /** access: el valor (se guarda cifrado) */
  value?: string;
  note?: string | null;
}

export interface MessageInput {
  /** si falta, el servidor usa `Equipo de <team del nodo>` o `Agente` */
  from?: string;
  text: string;
  reportUrl?: string | null;
}

export interface ProjectInput {
  id?: string;
  name: string;
  /** default: DEFAULT_LANG */
  lang?: Lang;
  /** default: DEFAULT_STAGES */
  stages?: StageInput[];
}

/**
 * `PUT /api/projects/:id` — reemplaza el grafo entero de un proyecto (idempotente).
 * Lo usan la semilla de la demo y `dagyard import`.
 */
export interface ProjectGraphInput {
  name: string;
  /** nuevo: DEFAULT_LANG; existente: si falta, conserva el suyo */
  lang?: Lang;
  stages?: StageInput[];
  nodes: NodeInput[];
  blockers?: Array<BlockerInput & { nodeId: string }>;
  messages?: Array<MessageInput & { nodeId: string }>;
}

/* ------------------------------------------------------------------ errores */

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'conflict'
  | 'cycle'
  | 'internal'
  /** el servidor se está reiniciando (un deploy) y no escribió nada: reintentar con la misma `Idempotency-Key` es seguro */
  | 'unavailable'
  /** el servidor está sobrecargado: no reintentes enseguida, empeoraría */
  | 'overloaded'
  /** el servidor se reinició a mitad de la escritura y no sabe si quedó: revisa antes de repetirla */
  | 'uncertain';

export interface ApiError {
  error: { code: ErrorCode; message: string };
}

/* ------------------------------------------------------------------ constantes */

/**
 * Las etapas de un proyecto nuevo, por idioma. Los ids son los mismos en los dos (solo cambia el nombre, como en la
 * demo): un cliente que crea un proyecto sin `stages` y usa `construccion` funciona en cualquier idioma.
 */
export const DEFAULT_STAGES_BY_LANG: Record<Lang, readonly Stage[]> = {
  en: [
    { id: 'descubrimiento', name: 'Discovery' },
    { id: 'diseno', name: 'Design' },
    { id: 'construccion', name: 'Build' },
    { id: 'pruebas', name: 'Testing' },
    { id: 'lanzamiento', name: 'Launch' },
  ],
  es: [
    { id: 'descubrimiento', name: 'Descubrimiento' },
    { id: 'diseno', name: 'Diseño' },
    { id: 'construccion', name: 'Construcción' },
    { id: 'pruebas', name: 'Pruebas' },
    { id: 'lanzamiento', name: 'Lanzamiento' },
  ],
};

/** Las opciones de una revisión que no trae las suyas (`dagyard block --kind review` sin `--opt`). */
export const REVIEW_OPTIONS: Record<Lang, readonly string[]> = {
  en: ['Approve', 'Request changes'],
  es: ['Aprobar', 'Pedir cambios'],
};

/** Las españolas (los ids son los de los dos idiomas). */
export const DEFAULT_STAGES: readonly Stage[] = DEFAULT_STAGES_BY_LANG.es;

export function defaultStages(lang: Lang): readonly Stage[] {
  return DEFAULT_STAGES_BY_LANG[lang];
}

export const LIMITS = {
  slug: 64,
  title: 120,
  name: 80,
  goal: 500,
  question: 500,
  option: 120,
  options: 6,
  message: 280,
  url: 2048,
  accessValue: 4096,
  note: 1000,
  nodesPerProject: 500,
  /** #90 */
  quote: 1000,
  closedReason: 500,
  originWhy: 280,
} as const;

/** Etiquetas humanas para la UI (D10: nada de jerga). */
export const STATUS_LABEL: Record<NodeStatus, string> = {
  pending: 'Pendiente',
  working: 'En progreso',
  blocked: 'Te espera',
  done: 'Lista',
};

export const BLOCKER_LABEL: Record<BlockerKind, string> = {
  decision: 'Necesita tu decisión',
  review: 'Necesita tu revisión',
  access: 'Necesita un acceso',
};
