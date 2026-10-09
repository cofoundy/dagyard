/**
 * `dagyard watch` (#121): quien orquesta escucha las preguntas y respuestas de un proyecto. Sigue el log de
 * eventos (`GET /api/projects/:p/events?since=`) y emite una línea por bloqueante abierto o respondido.
 */
import type { Blocker, DagEvent, ProjectSnapshot } from '@dagyard/model';
import { ApiRequestError, type DagyardClient } from './api.js';
import { t } from './i18n.js';
import { oneLine } from './tasks/parse.js';

/** Lo que el endpoint devuelve como máximo por página: una página llena se sigue sin esperar. */
export const EVENTS_PAGE = 500;
/** Esperas entre llamadas fallidas: crecen hasta 10 s, como las de `wait` (#94). */
export const WATCH_BACKOFF_MS = [1000, 2000, 5000, 10_000];
/** Fallos seguidos (≈1 min y medio con el backoff) tras los que el servidor «no responde» y `watch` sale. */
export const WATCH_GIVE_UP = 12;

/** Una línea de `--json`. `snapshot`: un bloqueante que ya estaba abierto al empezar (o tras un `resync`). */
export type WatchLine =
  | {
      type: 'blocker.opened' | 'blocker.resolved';
      seq: number;
      node: string;
      blocker: string;
      kind: Blocker['kind'];
      question: string;
      options: string[];
      choice?: string | null;
      note?: string | null;
      by?: string | null;
      at: string;
      snapshot?: true;
    }
  | { type: 'resync'; seq: number; since: number };

export interface WatchOptions {
  api: DagyardClient;
  project: string;
  /** `null`: empieza desde el snapshot, con los bloqueantes que ya están abiertos */
  since: number | null;
  intervalMs: number;
  /** se pone al día y sale (0) en vez de seguir escuchando */
  once: boolean;
  json: boolean;
  out: (s: string) => void;
  err: (s: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** guarda el cursor (el último seq visto) para reanudar */
  saveCursor?: (seq: number) => void;
}

export type WatchResult = 'ok' | 'unreachable';

const DOWN = Symbol('down');

/** Corre hasta que lo maten (o, con `once`, hasta ponerse al día). Un 4xx sale como error (lo lanza). */
export async function watch(o: WatchOptions): Promise<WatchResult> {
  let failures = 0;
  let since = o.since;
  const emit = (line: WatchLine) => o.out(o.json ? `${JSON.stringify(line)}\n` : `${formatLine(line)}\n`);

  /** Una llamada que aguanta caídas: reintenta con backoff y, tras `WATCH_GIVE_UP` fallos seguidos, se rinde. */
  async function call<T>(f: () => Promise<T>): Promise<T | typeof DOWN> {
    for (;;) {
      try {
        const r = await f();
        if (failures) o.err(t('dagyard: the server answers again\n', 'dagyard: el servidor volvió a responder\n'));
        failures = 0;
        return r;
      } catch (err) {
        if (!(err instanceof ApiRequestError) || !transient(err)) throw err;
        failures++;
        if (failures === 1) o.err(t(`dagyard: the server is not answering (${err.message}); retrying\n`, `dagyard: el servidor no responde (${err.message}); reintento\n`));
        if (failures >= WATCH_GIVE_UP) {
          const resume = since === null ? '' : ` --since ${since}`;
          o.err(
            t(
              `dagyard: the server did not answer ${failures} times in a row; I stop. Resume with «dagyard watch${resume}»\n`,
              `dagyard: el servidor no respondió ${failures} veces seguidas; me detengo. Reanuda con «dagyard watch${resume}»\n`,
            ),
          );
          return DOWN;
        }
        await o.sleep(WATCH_BACKOFF_MS[Math.min(failures - 1, WATCH_BACKOFF_MS.length - 1)]!);
      }
    }
  }

  /** El punto de partida (o de reanudación tras un `resync`): lo abierto ahora, y el seq del snapshot. */
  async function fromSnapshot(resyncFrom?: number): Promise<boolean> {
    const snap = await call(() => o.api.snapshot(o.project));
    if (snap === DOWN) return false;
    if (resyncFrom !== undefined) emit({ type: 'resync', seq: snap.seq, since: resyncFrom });
    for (const b of openBlockers(snap)) emit(blockerLine('blocker.opened', snap.seq, b, b.createdAt, true));
    since = snap.seq;
    o.saveCursor?.(since);
    return true;
  }

  if (since === null && !(await fromSnapshot())) return 'unreachable';
  o.err(t(`dagyard: listening to «${o.project}» after event #${since}\n`, `dagyard: escuchando «${o.project}» después del evento #${since}\n`));
  for (;;) {
    const from = since!;
    const page = await call(() => o.api.events(o.project, from));
    if (page === DOWN) return 'unreachable';
    if (page.resync) {
      // el log ya no llega hasta `since` (#74): lo perdido no se puede repetir, así que se avisa y se sigue desde el snapshot
      if (!(await fromSnapshot(from))) return 'unreachable';
      continue;
    }
    for (const ev of page.events) {
      if (ev.seq <= since!) continue;
      const line = eventLine(ev);
      if (line) emit(line);
      since = ev.seq;
    }
    if (since !== from) o.saveCursor?.(since!);
    if (page.events.length >= EVENTS_PAGE) continue;
    if (o.once) return 'ok';
    await o.sleep(o.intervalMs);
  }
}

/** Red caída, un 5xx o un 429: esperar puede arreglarlo. Un 4xx (key, proyecto) no. */
const transient = (err: ApiRequestError) => err.status === 0 || err.status >= 500 || err.status === 429;

function openBlockers(snap: ProjectSnapshot): Blocker[] {
  return snap.blockers.filter((b) => b.status === 'open').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function eventLine(ev: DagEvent): WatchLine | null {
  if (ev.type === 'blocker.opened' || ev.type === 'blocker.resolved') return blockerLine(ev.type, ev.seq, ev.payload.blocker, ev.at);
  return null;
}

function blockerLine(type: 'blocker.opened' | 'blocker.resolved', seq: number, b: Blocker, at: string, snapshot = false): WatchLine {
  const line: WatchLine = { type, seq, node: b.nodeId, blocker: b.id, kind: b.kind, question: b.question, options: b.options, at };
  if (type === 'blocker.resolved') {
    line.choice = b.resolution?.choice ?? null;
    line.note = b.resolution?.note ?? null;
    line.by = b.resolvedBy;
  }
  if (snapshot) line.snapshot = true;
  return line;
}

/** Una línea por evento, siempre una (la nota y la pregunta se aplanan): quien la lee puede ser un Monitor. */
export function formatLine(l: WatchLine): string {
  if (l.type === 'resync') {
    return t(
      `#${l.seq} resync: the server no longer has the events after #${l.since}; going on from the current state`,
      `#${l.seq} resync: el servidor ya no tiene los eventos después de #${l.since}; sigo desde el estado actual`,
    );
  }
  const q = `«${oneLine(l.question, 500)}»`;
  if (l.type === 'blocker.opened') {
    const opts = l.options.length ? ` [${l.options.join(' | ')}]` : '';
    const verb = l.snapshot ? t('still waiting', 'sigue esperando') : t('asks', 'pregunta');
    return `#${l.seq} ${l.node} ${verb} (${l.kind}): ${q}${opts} · ${l.blocker}`;
  }
  const answer =
    l.kind === 'access'
      ? t(`access saved (read it with «dagyard wait ${l.node} --blocker ${l.blocker}»)`, `acceso guardado (léelo con «dagyard wait ${l.node} --blocker ${l.blocker}»)`)
      : (l.choice ?? t('(no option)', '(sin opción)'));
  const note = l.note ? ` — ${t('note', 'nota')}: ${oneLine(l.note, 2000)}` : '';
  return `#${l.seq} ${l.node} ${t('answered', 'respondieron')} ${q}: ${answer}${note} · ${l.blocker}`;
}
