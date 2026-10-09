// Idioma de la interfaz (#73): inglés o español. Orden: lo que el PM eligió (localStorage) >
// el idioma del navegador > inglés. Lo que escribe un usuario (títulos, mensajes) no pasa por aquí.

import { useSyncExternalStore } from 'react';
import { en, es, type Catalog, type Message, type MessageKey } from './messages';

export type Lang = 'en' | 'es';
export type { MessageKey } from './messages';

export const LANGS: readonly Lang[] = ['en', 'es'];
export const STORAGE_KEY = 'dagyard.lang';

const CATALOGS: Record<Lang, Catalog> = { en, es };
/** Locale para Intl: fechas y plurales con la forma de cada idioma. */
const LOCALES: Record<Lang, string> = { en: 'en-US', es: 'es-PE' };

/** Recorre la lista en orden: gana el primero que sea `es*` o `en*`; lo demás se salta. Vacía → 'en'. */
export function detectLang(languages: readonly string[]): Lang {
  for (const tag of languages) {
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (primary === 'es' || primary === 'en') return primary;
  }
  return 'en';
}

function isLang(value: unknown): value is Lang {
  return value === 'en' || value === 'es';
}

function readStored(): Lang | undefined {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isLang(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function writeStored(l: Lang): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, l);
  } catch {
    // modo privado o almacenamiento bloqueado: el idioma vale solo para esta visita
  }
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

function applyToDocument(l: Lang): void {
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}

let current: Lang = 'en';
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

/** Decide el idioma al arrancar: elección guardada > navegador > 'en'. Devuelve el elegido. */
export function initLang(): Lang {
  const next = readStored() ?? detectLang(browserLanguages());
  const changed = next !== current;
  current = next;
  applyToDocument(next);
  if (changed) notify();
  return next;
}

export function lang(): Lang {
  return current;
}

/** Cambia el idioma sin recargar: lo recuerda en este navegador y re-pinta a quien use `useLang`. */
export function setLang(l: Lang): void {
  writeStored(l);
  applyToDocument(l);
  if (l === current) return;
  current = l;
  notify();
}

/** Suscripción al cambio de idioma (fuera de React). Devuelve la función que la cancela. */
export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Hook: el componente se vuelve a pintar cuando cambia el idioma. */
export function useLang(): Lang {
  return useSyncExternalStore(onLangChange, lang, lang);
}

export function locale(l: Lang = current): string {
  return LOCALES[l];
}

export type Vars = Record<string, string | number>;

function pick(msg: Message, vars: Vars | undefined, l: Lang): string {
  if (typeof msg === 'string') return msg;
  const count = Number(vars?.count ?? 0);
  if (count === 0 && msg.zero !== undefined) return msg.zero;
  const form = new Intl.PluralRules(LOCALES[l]).select(count);
  return (form === 'one' ? msg.one : undefined) ?? msg.other;
}

/** Texto de la clave en el idioma actual, con `{variables}` reemplazadas. */
export function t(key: MessageKey, vars?: Vars, l: Lang = current): string {
  const text = pick(CATALOGS[l][key], vars, l);
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

type DateInput = string | number | Date;

function toTime(value: DateInput): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === 'number' ? value : Date.parse(value);
}

/** Fecha corta: «Oct 3» / «3 oct». '' si no es una fecha. */
export function fmtDate(value: DateInput | undefined, options?: Intl.DateTimeFormatOptions, l: Lang = current): string {
  if (value === undefined) return '';
  const time = toTime(value);
  if (Number.isNaN(time)) return '';
  const parts = new Intl.DateTimeFormat(LOCALES[l], options ?? { day: 'numeric', month: 'short' }).formatToParts(time);
  // es-PE abrevia con punto («oct.»); en la interfaz va sin él, como en el resto del panel
  return parts.map((p) => (p.type === 'month' ? p.value.replace(/\.$/, '') : p.value)).join('');
}

/** «just now», «5 min. ago», «2 hr. ago», «yesterday», «Oct 3» — y su par en español. '' si no es una fecha. */
export function fmtRelative(value: DateInput | undefined, now = Date.now(), l: Lang = current): string {
  if (value === undefined) return '';
  const time = toTime(value);
  if (Number.isNaN(time)) return '';
  const s = Math.max(0, (now - time) / 1000);
  if (s < 60) return t('time.justNow', undefined, l);
  const rtf = new Intl.RelativeTimeFormat(LOCALES[l], { numeric: 'auto', style: 'short' });
  if (s < 3600) return rtf.format(-Math.floor(s / 60), 'minute');
  if (s < 86_400) return rtf.format(-Math.floor(s / 3600), 'hour');
  if (s < 172_800) return rtf.format(-1, 'day');
  return fmtDate(time, undefined, l);
}

/** Hora o fecha con las opciones de Intl: «10:18 PM» / «22:18», «Sat» / «sáb». '' si no es una fecha. */
export function fmtTime(value: DateInput | undefined, options: Intl.DateTimeFormatOptions, l: Lang = current): string {
  if (value === undefined) return '';
  const time = toTime(value);
  if (Number.isNaN(time)) return '';
  return new Intl.DateTimeFormat(LOCALES[l], options)
    .formatToParts(time)
    .map((p) => (p.type === 'weekday' || p.type === 'month' ? p.value.replace(/\.$/, '') : p.value))
    .join('');
}

/** «less than a minute», «25 min», «2 h», «6 h 37 min», «3 days» — y su par en español. */
export function fmtDuration(ms: number, l: Lang = current): string {
  const m = Math.max(0, Math.round(ms / 60e3));
  if (m < 1) return t('dur.lessMin', undefined, l);
  if (m < 60) return t('dur.min', { m }, l);
  const h = Math.floor(m / 60), r = m % 60;
  if (h >= 48) return t('dur.days', { count: Math.round(h / 24) }, l);
  return r ? t('dur.hm', { h, m: r }, l) : t('dur.h', { h }, l);
}
