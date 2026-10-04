/**
 * La cola de GitHub para `dagyard sync`: la fuente (`gh api`, inyectable para tests) y los parsers puros
 * de títulos, referencias y opciones.
 */
import { execFile } from 'node:child_process';
import { LIMITS } from '@dagyard/model';
import { legibleTitle, oneLine } from '../tasks/parse.js';
import { t } from '../i18n.js';

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  /** `completed`, `not_planned`, `reopened` o null (issues viejos) */
  stateReason: string | null;
  /** `html_url` */
  url: string;
  labels: string[];
  /** el listado de issues de GitHub también trae los PRs (`pull_request`) */
  isPull: boolean;
}

export interface GhPull {
  number: number;
  title: string;
  body: string;
}

export interface GithubSource {
  /** Todos los issues (abiertos y cerrados) del repo, con PRs marcados; `label` filtra en GitHub. */
  issues(repo: string, opts: { label?: string }): Promise<GhIssue[]>;
  /** Los PRs abiertos del repo. */
  openPulls(repo: string): Promise<GhPull[]>;
}

/** `execFile` reducido a lo que hace falta: corre `file args` y devuelve el stdout. */
export type Exec = (file: string, args: string[]) => Promise<string>;

const defaultExec: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reject(new Error(t('gh (GitHub CLI) was not found: install it and run «gh auth login»', 'no encontré gh (GitHub CLI): instálalo y corre «gh auth login»')));
      }
      const cmd = `gh ${args.slice(0, 3).join(' ')}`;
      const why = oneLine(String(stderr || err.message), 500);
      reject(new Error(t(`${cmd} failed: ${why}`, `${cmd} falló: ${why}`)));
    });
  });

const ISSUE_JQ =
  '.[] | {number, title, body, state, state_reason, html_url, labels: [.labels[].name], pull_request: (.pull_request != null)}';
const PULL_JQ = '.[] | {number, title, body}';

/** La fuente real: `gh api --paginate` (una línea JSON por elemento gracias a `--jq`). */
export function ghCliSource(exec: Exec = defaultExec): GithubSource {
  const lines = async (path: string, jq: string): Promise<Array<Record<string, unknown>>> => {
    const out = await exec('gh', ['api', '--paginate', path, '--jq', jq]);
    return out
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  return {
    async issues(repo, opts) {
      const qs = new URLSearchParams({ state: 'all', per_page: '100' });
      if (opts.label) qs.set('labels', opts.label);
      const rows = await lines(`repos/${repo}/issues?${qs.toString().replace(/\+/g, '%20')}`, ISSUE_JQ);
      return rows.map((r) => ({
        number: Number(r.number),
        title: String(r.title ?? ''),
        body: typeof r.body === 'string' ? r.body : '',
        state: r.state === 'closed' ? 'closed' : 'open',
        stateReason: typeof r.state_reason === 'string' ? r.state_reason : null,
        url: String(r.html_url ?? ''),
        labels: Array.isArray(r.labels) ? r.labels.map(String) : [],
        isPull: r.pull_request === true,
      }));
    },
    async openPulls(repo) {
      const rows = await lines(`repos/${repo}/pulls?state=open&per_page=100`, PULL_JQ);
      return rows.map((r) => ({
        number: Number(r.number),
        title: String(r.title ?? ''),
        body: typeof r.body === 'string' ? r.body : '',
      }));
    },
  };
}

/* ------------------------------------------------------------------ parsers */

/** Prefijo tipo `cli: `, `feat(model): `, `epic: ` (una sola palabra antes de los dos puntos). */
const PREFIX = /^[\p{L}\p{N}_./-]+(?:\([^)]*\))?!?:\s+/u;

/** Título del issue en humano: sin el prefijo `algo: `, con la primera letra en mayúscula, ≤120. */
export function cleanTitle(raw: string): string {
  const line = oneLine(raw, 10_000);
  const bare = line.replace(PREFIX, '') || line;
  const capped = bare.replace(/\p{L}/u, (c) => c.toLocaleUpperCase('es'));
  return oneLine(capped, LIMITS.title);
}

/** «desde #35», «(ver #12)», «tras #8»: referencias a otros issues, jerga para un PM. */
const REF_PHRASE = /\s*\(?\s*(?:(?:desde|tras|después de|según|por|ver|véase|see|since|after|from|per)\s+)?#\d+\s*\)?/giu;

/**
 * El título de una tarea nueva: `cleanTitle` sin las referencias a otros issues y luego `legibleTitle`
 * del import (D10, #21: sin rutas, sin paréntesis, sin MAYÚSCULAS enfáticas). Nunca vacío.
 */
export function issueNodeTitle(raw: string, n: number): string {
  const bare = cleanTitle(raw).replace(REF_PHRASE, ' ');
  const t = legibleTitle(oneLine(bare, 10_000) || raw);
  return t && t !== 'Tarea' ? t : `Issue ${n}`;
}

/** Lista `#3`, `#3 y #4`, `#3, #4 and #5`. */
const REF_LIST = String.raw`#\d+(?:\s*(?:,|\by\b|\be\b|\band\b|&)\s*#\d+)*`;

function refsAfter(text: string, phrases: string): number[] {
  const out: number[] = [];
  const re = new RegExp(String.raw`(?:^|[^\p{L}])(?:${phrases})\s*:?\s+(${REF_LIST})`, 'giu');
  for (const m of text.matchAll(re)) {
    for (const n of m[1]!.matchAll(/#(\d+)/g)) out.push(Number(n[1]));
  }
  return [...new Set(out)];
}

/** Lo que un PR dice que cierra: `closes|fixes|resolves|cierra|resuelve #n` (y sus variantes de GitHub). */
export function closingRefs(text: string): number[] {
  const out: number[] = [];
  const re = /(?:^|[^\p{L}])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|cierra|resuelve)\s*:?\s+#(\d+)/giu;
  for (const m of text.matchAll(re)) out.push(Number(m[1]));
  return [...new Set(out)];
}

/**
 * Del cuerpo de un issue: `partOf` = «Parte de #n» (este issue es una parte de la épica n),
 * `dependsOn` = «depende de #n», «blocked by #n», «bloqueado por #n», y `bornFrom` (#90) = «sale de la revisión de #n»,
 * «nace de #n» o «born from #n» (este issue nació de n: no es una dependencia).
 */
export function dependencyRefs(text: string): { partOf: number[]; dependsOn: number[]; bornFrom: number[] } {
  return {
    partOf: refsAfter(text, 'parte de|part of'),
    dependsOn: refsAfter(text, 'depende de|depends on|blocked by|bloquead[oa] por'),
    bornFrom: refsAfter(text, 'sale de la revisi[oó]n de|nace de|born from'),
  };
}

const OPTION_BOLD = /^\s*[-*]\s+\*\*\s*([A-Za-z0-9]{1,2})\s*(?:\(([^)]*)\))?\s*[:.)]?\s*\*\*\s*[:.)]?\s*(.*)$/;
const OPTION_PAREN = /^\s*[-*]\s+([A-Za-z0-9]{1,2})\)\s+(.+)$/;

/**
 * Opciones de una decisión desde el cuerpo: `- **A (…):** texto`, `- **A:** texto` o `- A) texto`.
 * Máximo `LIMITS.options`, cada una recortada a `LIMITS.option`, sin repetidas. Ninguna → `[]`.
 */
export function parseOptions(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    let letter: string;
    let note: string | undefined;
    let text: string;
    const bold = OPTION_BOLD.exec(line);
    const paren = bold ? null : OPTION_PAREN.exec(line);
    if (bold) [, letter, note, text] = bold as unknown as [string, string, string | undefined, string];
    else if (paren) [, letter, text] = paren as unknown as [string, string, string];
    else continue;
    const plain = text.replace(/\*\*|__|`/g, '').trim();
    const head = note?.trim() ? `${letter} (${note.trim()})` : letter;
    const option = oneLine(plain ? `${head}: ${plain}` : head, LIMITS.option);
    if (!out.includes(option)) out.push(option);
    if (out.length === LIMITS.options) break;
  }
  return out;
}
