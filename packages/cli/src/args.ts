import { t } from './i18n.js';

/** Parser mínimo: `--k v`, `--k=v`, banderas booleanas declaradas, `--opt` repetible y `--` final. */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string[]>;
  bools: Set<string>;
  /** las opciones con valor en el orden en que llegaron (para emparejar `--from x --why "…"`, #90) */
  seq: Array<[key: string, value: string]>;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const ALIASES: Record<string, string> = { h: 'help', q: 'q', p: 'project' };

export function parseArgs(argv: string[], booleans: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { positionals: [], flags: {}, bools: new Set(), seq: [] };
  const isBool = (k: string) => booleans.includes(k) || k === 'help';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      out.positionals.push(...argv.slice(i + 1));
      break;
    }
    const m = /^--?([A-Za-z][\w-]*)(?:=(.*))?$/.exec(arg);
    if (!m || /^-\d/.test(arg)) {
      out.positionals.push(arg);
      continue;
    }
    const key = ALIASES[m[1]!] ?? m[1]!;
    if (isBool(key)) {
      if (m[2] !== undefined) throw new UsageError(t(`--${key} takes no value`, `--${key} no lleva valor`));
      out.bools.add(key);
      continue;
    }
    let value = m[2];
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new UsageError(t(`--${key} needs a value`, `a --${key} le falta el valor`));
    }
    (out.flags[key] ??= []).push(value);
    out.seq.push([key, value]);
  }
  return out;
}

export function flag(a: ParsedArgs, key: string): string | undefined {
  const v = a.flags[key];
  return v ? v[v.length - 1] : undefined;
}

export function assertKnownFlags(a: ParsedArgs, allowed: readonly string[]): void {
  for (const k of Object.keys(a.flags)) {
    if (!allowed.includes(k)) throw new UsageError(t(`unknown option: --${k}`, `opción desconocida: --${k}`));
  }
}
