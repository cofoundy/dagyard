// Los textos del mod en inglés (por defecto) y en español (#73). El idioma sale del entorno del proceso,
// con el mismo criterio que el CLI (`packages/cli/src/i18n.ts`; el mod no lo importa: corre sin empaquetar).
// Lo que escribe una persona (títulos, preguntas, opciones) y lo que el mod manda al servidor no se traduce.

export type Lang = 'en' | 'es'

/**
 * POSIX: `LC_ALL` > `LC_MESSAGES` > `LANG`, y manda el primero no vacío. `es`, `es_PE.UTF-8`, `es-419` → 'es';
 * todo lo demás (incluidos `C`, `POSIX` y nada) → 'en'.
 */
export function langFromEnv(env: Record<string, string | null | undefined>): Lang {
  const raw = [env.LC_ALL, env.LC_MESSAGES, env.LANG].map(v => v?.trim() ?? '').find(v => v !== '') ?? ''
  return /^es(?:$|[_.@-])/i.test(raw) ? 'es' : 'en'
}

export type Kind = 'decision' | 'review' | 'access'

export type Strings = {
  commandDescription: string
  notLinked: (file: string) => string
  summary: (project: string, waiting: number, startable: number) => string
  noAnswer: (detail: string) => string
  noDetail: string
  missingKey: string
  menuDoesNotFit: (reason: string) => string
  /** toast de un bloqueante nuevo */
  needsYou: (title: string, kind: Kind, question: string) => string
  manyNew: (n: number) => string
  resolved: (title: string, option: string) => string
  took: (title: string) => string
  finish: (title: string) => string
  isDone: (title: string) => string
  offline: (base: string, detail: string) => string
  offlineMenu: (base: string, detail: string) => string
  loading: string
  retry: string
  progress: (done: number, total: number, now: string) => string
  waitingCount: (n: number) => string
  startableCount: (n: number) => string
  workingOn: string
  done: string
  release: string
  openSky: string
  other: (i: number, n: number) => string
  /** «Needs your decision» en la banda */
  waitingLabel: (kind: Kind) => string
  grantInSky: string
  seeAll: string
  readyToTake: string
  workOnThis: string
  working: string
  waitingSection: (n: number) => string
  nothingWaiting: string
  kindName: (kind: Kind) => string
  access: string
  whatWouldYouChange: string
  oneLine: string
  send: string
  cancel: string
  /** elegir una opción de una decisión o una revisión pide confirmar (#89) */
  confirmPick: (option: string) => string
  cannotUndo: string
  yesChoose: string
  startableSection: (n: number) => string
  nothingStartable: string
  showBand: string
  hideBand: string
}

const EN: Strings = {
  commandDescription: 'Opens the Dagyard menu: everything that needs you and everything ready to take',
  notLinked: file =>
    `This repo is not linked to a Dagyard project. Add ${file} at its root with {"project": "<id>"} (or DAGYARD_PROJECT) and open a new session.`,
  summary: (project, waiting, startable) => `${project}: ${waiting} need you, ${startable} ready to take.`,
  noAnswer: detail => `Dagyard did not respond (${detail})`,
  noDetail: 'no details',
  missingKey: 'the key is missing in ~/.config/dagyard',
  menuDoesNotFit: reason => `Dagyard: the menu does not fit here (${reason})`,
  needsYou: (title, kind, question) =>
    `«${title}» needs ${kind === 'decision' ? 'your decision' : kind === 'review' ? 'your review' : 'an access'}: ${question}`,
  manyNew: n => `${n} new things need you · /dagyard`,
  resolved: (title, option) => `«${title}»: ${option}. The team carries on.`,
  took: title => `You took «${title}». It now glows blue in the sky.`,
  finish: title => `Finish «${title}»`,
  isDone: title => `«${title}» is done.`,
  offline: (base, detail) => `◆ dagyard · no connection to ${base} (${detail}) · /dagyard retries`,
  offlineMenu: (base, detail) => `No connection to ${base} (${detail}).`,
  loading: 'loading…',
  retry: 'Retry',
  progress: (done, total, now) => ` · ${done} of ${total} done${now ? ` · now in ${now}` : ''}`,
  waitingCount: n => `${n} need you`,
  startableCount: n => `${n} ready to take`,
  workingOn: 'Working on ',
  done: 'Done',
  release: 'Release it',
  openSky: 'See the sky',
  other: (i, n) => `Next (${i}/${n})`,
  waitingLabel: kind => (kind === 'decision' ? 'Needs your decision' : kind === 'review' ? 'Needs your review' : 'Needs an access'),
  grantInSky: 'Grant it in the sky',
  seeAll: 'See all',
  readyToTake: 'Ready to take · ',
  workOnThis: 'Work on this',
  working: 'WORKING',
  waitingSection: n => `NEEDS YOU (${n})`,
  nothingWaiting: 'Nothing needs you.',
  kindName: kind => (kind === 'decision' ? 'Decision' : kind === 'review' ? 'Review' : 'Access'),
  access: 'access',
  whatWouldYouChange: 'What would you change: ',
  oneLine: 'in one line',
  send: 'send',
  cancel: 'Cancel',
  confirmPick: option => `Choose «${option}»?`,
  cannotUndo: 'It cannot be undone.',
  yesChoose: 'Yes, choose',
  startableSection: n => `READY TO TAKE (${n})`,
  nothingStartable: 'Nothing unblocked left to take.',
  showBand: 'Show the bar',
  hideBand: 'Hide the bar',
}

const ES: Strings = {
  commandDescription: 'Abre el menú de Dagyard: todo lo que te espera y lo que está para tomar',
  notLinked: file =>
    `Este repo no está enlazado a un proyecto de Dagyard. Agrega ${file} en su raíz con {"project": "<id>"} (o DAGYARD_PROJECT) y abre otra sesión.`,
  summary: (project, waiting, startable) => `${project}: ${waiting} te esperan, ${startable} para tomar.`,
  noAnswer: detail => `Dagyard no respondió (${detail})`,
  noDetail: 'sin detalle',
  missingKey: 'falta la clave en ~/.config/dagyard',
  menuDoesNotFit: reason => `Dagyard: el menú no cabe aquí (${reason})`,
  needsYou: (title, kind, question) =>
    `«${title}» espera ${kind === 'decision' ? 'tu decisión' : kind === 'review' ? 'tu revisión' : 'un acceso'}: ${question}`,
  manyNew: n => `${n} cosas nuevas te esperan · /dagyard`,
  resolved: (title, option) => `«${title}»: ${option}. El equipo sigue.`,
  took: title => `Tomaste «${title}». Ya brilla en azul en el cielo.`,
  finish: title => `Termina «${title}»`,
  isDone: title => `«${title}» está lista.`,
  offline: (base, detail) => `◆ dagyard · sin conexión con ${base} (${detail}) · /dagyard reintenta`,
  offlineMenu: (base, detail) => `Sin conexión con ${base} (${detail}).`,
  loading: 'cargando…',
  retry: 'Reintentar',
  progress: (done, total, now) => ` · ${done} de ${total} listas${now ? ` · ahora en ${now}` : ''}`,
  waitingCount: n => `${n} te esperan`,
  startableCount: n => `${n} para tomar`,
  workingOn: 'Trabajando en ',
  done: 'Hecha',
  release: 'Soltarla',
  openSky: 'Ver el cielo',
  other: (i, n) => `Otra (${i}/${n})`,
  waitingLabel: kind => (kind === 'decision' ? 'Te espera tu decisión' : kind === 'review' ? 'Te espera tu revisión' : 'Te espera un acceso'),
  grantInSky: 'Darlo en el cielo',
  seeAll: 'Ver todo',
  readyToTake: 'Para tomar · ',
  workOnThis: 'Trabajar en esto',
  working: 'TRABAJANDO',
  waitingSection: n => `TE ESPERAN (${n})`,
  nothingWaiting: 'Nada te espera.',
  kindName: kind => (kind === 'decision' ? 'Decisión' : kind === 'review' ? 'Revisión' : 'Acceso'),
  access: 'acceso',
  whatWouldYouChange: 'Qué cambiarías: ',
  oneLine: 'en una línea',
  send: 'enviar',
  cancel: 'Cancelar',
  confirmPick: option => `¿Eliges «${option}»?`,
  cannotUndo: 'No se puede deshacer.',
  yesChoose: 'Sí, elegir',
  startableSection: n => `PARA TOMAR (${n})`,
  nothingStartable: 'Nada desbloqueado sin tomar.',
  showBand: 'Mostrar la banda',
  hideBand: 'Ocultar la banda',
}

export function text(lang: Lang): Strings {
  return lang === 'es' ? ES : EN
}

/** La opción «Pedir cambios» de una revisión, en el idioma en que se haya escrito. */
export const REQUEST_CHANGES = /cambio|change/i
