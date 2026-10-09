// Todo lo que lee el PM pasa por aquí, y aquí solo hay claves del catálogo (`../i18n/messages.ts`, #73).
// Cada texto se lee en el momento de pintar (getters), así un cambio de idioma se ve sin recargar.

import type { BlockerKind, CloseAs, NodeStatus } from '../data/types';
import { isDefaultReviewOptions } from '../data/adapter';
import { fmtRelative, fmtTime, t, type MessageKey } from '../i18n';

/** Un objeto cuyos campos leen su clave del catálogo en el idioma actual cada vez que se consultan. */
function fromCatalog<K extends string>(keys: Record<K, MessageKey>): Readonly<Record<K, string>> {
  const out = {} as Record<K, string>;
  for (const [name, key] of Object.entries(keys) as Array<[K, MessageKey]>)
    Object.defineProperty(out, name, { get: () => t(key), enumerable: true });
  return out;
}

/** Clase visual por estado (los tokens del preview). */
export const STATUS_CLASS: Record<NodeStatus, 'done' | 'working' | 'blocked' | 'queued'> = {
  done: 'done',
  working: 'working',
  blocked: 'blocked',
  pending: 'queued',
};

/** Cómo se cerró una tarea (#90). */
export const CLOSE_TEXT = fromCatalog<CloseAs>({
  done: 'close.done',
  replaced: 'close.replaced',
  dropped: 'close.dropped',
  learned: 'close.learned',
});

/** Lo que no es una tarea común se nombra en la ficha: meta, pedido o trabajo continuo. */
export const KIND_TEXT = fromCatalog<'goal' | 'request' | 'stream'>({
  goal: 'kind.goal',
  request: 'kind.request',
  stream: 'kind.stream',
});

export const BLOCK_TEXT = fromCatalog<BlockerKind>({
  decision: 'block.decision',
  review: 'block.review',
  access: 'block.access',
});

/** Para avisos: «Modelo de comisiones necesita tu decisión». */
export const BLOCK_TOAST = fromCatalog<BlockerKind>({
  decision: 'blockToast.decision',
  review: 'blockToast.review',
  access: 'blockToast.access',
});

/** El verbo de una respuesta tuya: «Decidiste», «Revisaste», «Entregaste un acceso». */
export const ANSWER_VERB = fromCatalog<BlockerKind>({
  decision: 'answer.decision',
  review: 'answer.review',
  access: 'answer.access',
});

/** «10:18 PM» o, si no es de hoy, «Sat 10:18 PM». */
export function clock(ms: number, now = Date.now()): string {
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  return fmtTime(ms, sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** «Nació 10:18 PM · hace 5 min». */
export function bornLine(ms: number, now = Date.now()): string {
  return t('card.born', { when: clock(ms, now), ago: fmtRelative(ms, now) });
}

/** «André lo pidió»; sin nombre, «Alguien lo pidió». */
export function askedBy(who: string | undefined): string {
  return who ? t('card.askedBy', { who }) : COPY.asked;
}

export function chainMore(n: number): string {
  return t('card.chainMore', { count: n });
}

/** «La lleva el Equipo de Diseño.» */
export function builtBy(team: string): string {
  return t('card.builtBy', { team });
}

export function findMore(shown: number, total: number): string {
  return t('find.more', { shown, total });
}

/** «hace un momento», «hace 5 min», «hace 2 h», «ayer», «3 oct» — en el idioma actual. */
export function ago(iso: string | undefined, now = Date.now()): string {
  return fmtRelative(iso, now);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Nombre del dueño de una tarea: «Equipo de Diseño» / «Design team». Si ya lo dice, tal cual. */
export function teamName(team: string | undefined): string | undefined {
  if (!team) return undefined;
  return /^equipo\b/i.test(team) || /\bteam$/i.test(team) ? team : t('team.name', { team });
}

/**
 * Los dos botones de una revisión. Si el pedido trae las opciones por defecto del servidor (o ninguna), se pintan en
 * el idioma de la interfaz; si el equipo escribió las suyas, van tal cual (lo que escribe un usuario no se traduce).
 */
export function reviewLabels(options: readonly string[]): [approve: string, changes: string] {
  const isDefault = !options.length || isDefaultReviewOptions(options);
  if (isDefault) return [COPY.approve, COPY.requestChanges];
  return [options[0] ?? COPY.approve, options[1] ?? COPY.requestChanges];
}

export const COPY = fromCatalog({
  entryTitle: 'entry.title',
  entryLead: 'entry.lead',
  entryLabel: 'entry.label',
  entryPlaceholder: 'entry.placeholder',
  entryCta: 'entry.cta',
  entryChecking: 'entry.checking',
  entryBad: 'entry.bad',
  entryEmpty: 'entry.empty',
  entryExpired: 'entry.expired',
  entryOffline: 'entry.offline',
  entryFine: 'entry.fine',
  langSwitch: 'lang.switch',
  loading: 'hud.loading',
  loadError: 'hud.loadError',
  retry: 'hud.retry',
  noProjects: 'hud.noProjects',
  reconnecting: 'hud.reconnecting',
  projectsTitle: 'hud.projects',
  logout: 'hud.logout',
  demoNote: 'hud.demoNote',
  skyLabel: 'hud.sky',
  close: 'card.close',
  needs: 'card.needs',
  notStarted: 'card.notStarted',
  waitsYou: 'card.waitsYou',
  report: 'card.report',
  reportBasalt: 'card.reportBasalt',
  technical: 'card.technical',
  open: 'card.open',
  yourAnswers: 'card.yourAnswers',
  messages: 'card.messages',
  sending: 'card.sending',
  send: 'card.send',
  cancel: 'card.cancel',
  approve: 'card.approve',
  requestChanges: 'card.requestChanges',
  changesLabel: 'card.changesLabel',
  changesPlaceholder: 'card.changesPlaceholder',
  sendChanges: 'card.sendChanges',
  unlock: 'card.unlock',
  access: 'card.access',
  accessPlaceholder: 'card.accessPlaceholder',
  accessMissing: 'card.accessMissing',
  accessFine: 'card.accessFine',
  sendError: 'card.sendError',
  alreadyResolved: 'card.alreadyResolved',
  agent: 'answer.agent',
  teamContinues: 'toast.teamContinues',
  isDone: 'toast.isDone',
  started: 'toast.started',
  added: 'toast.added',
  removed: 'toast.removed',
  // la vista DAG (#75)
  answer: 'hud.answer',
  how: 'foot.how',
  howShort: 'foot.howShort',
  replay: 'foot.replay',
  replayHint: 'foot.replayHint',
  legendNeeds: 'legend.needs',
  legendBorn: 'legend.born',
  findPlaceholder: 'find.placeholder',
  findLabel: 'find.label',
  findResults: 'find.results',
  findNone: 'find.none',
  forSec: 'card.for',
  forGoal: 'card.forGoal',
  toward: 'card.toward',
  forLoose: 'card.forLoose',
  forLooseLegacy: 'card.forLooseLegacy',
  linkTo: 'card.linkTo',
  letGo: 'card.letGo',
  letGoWhy: 'card.letGoWhy',
  loosePending: 'card.loosePending',
  forUnset: 'card.forUnset',
  forClosed: 'card.forClosed',
  whySec: 'card.why',
  asked: 'card.asked',
  bornFrom: 'card.bornFrom',
  inferred: 'card.inferred',
  noOrigin: 'card.noOrigin',
  root: 'card.root',
  closedSec: 'card.closed',
  bornHere: 'card.bornHere',
  chain: 'card.chain',
  offline: 'card.offline',
  replacedBy: 'close.replacedBy',
  // avisos fuera de la pantalla (#47)
  noticeTitle: 'notice.title',
  notifyMe: 'notice.notifyMe',
  notifyMeHint: 'notice.notifyMeHint',
});

/** «Pedro respondió» / «Pedro answered». */
export function answeredBy(who: string): string {
  return t('answer.by', { who });
}

const BASALT_HOST = 'basalt.cofoundy.ai';

/** «Informe en Basalt» solo si el enlace vive en Basalt; un PR, un issue o una URL inválida dicen «Informe» (#59). */
export function reportLabel(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return COPY.report;
  }
  return host === BASALT_HOST || host.endsWith(`.${BASALT_HOST}`) ? COPY.reportBasalt : COPY.report;
}
