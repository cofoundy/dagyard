import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS, EXIT, run } from '../src/cli.js';
import { langFromEnv, withLang } from '../src/i18n.js';
import { formatSync, type SyncReport } from '../src/sync/sync.js';

/** `fetch` falso: `next` sin nada arrancable, lo demás 201 con el cuerpo de vuelta. */
const fakeFetch = (async (url: string, init?: RequestInit) => {
  const body = /\/next$/.test(String(url)) ? { node: null, goalLine: null } : { id: 'x', ...(init?.body ? JSON.parse(String(init.body)) : {}) };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

async function cli(argv: string[], locale: Record<string, string>) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    cwd: mkdtempSync(join(tmpdir(), 'dagyard-cwd-')),
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: {
      DAGYARD_URL: 'https://d.dev',
      DAGYARD_KEY: 'clave-de-prueba-123',
      DAGYARD_PROJECT: 'demo',
      DAGYARD_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dagyard-cfg-')),
      ...locale,
    },
    fetch: fakeFetch,
    sleep: async () => {},
    platform: 'linux',
  });
  return { code, stdout, stderr };
}

const EN = { LANG: 'en_US.UTF-8' };
const ES = { LANG: 'es_PE.UTF-8' };

describe('langFromEnv', () => {
  it.each([
    [{ LANG: 'es_PE.UTF-8' }, 'es'],
    [{ LANG: 'es' }, 'es'],
    [{ LANG: 'es-419' }, 'es'],
    [{ LANG: 'ES_es.utf8' }, 'es'],
    [{ LANG: 'en_US.UTF-8' }, 'en'],
    [{ LANG: 'C' }, 'en'],
    [{ LANG: 'POSIX' }, 'en'],
    [{ LANG: 'C.UTF-8' }, 'en'],
    [{ LANG: 'et_EE.UTF-8' }, 'en'],
    [{ LANG: '' }, 'en'],
    [{}, 'en'],
    [{ LANG: 'en_US.UTF-8', LC_ALL: 'es_PE.UTF-8' }, 'es'],
    [{ LANG: 'es_PE.UTF-8', LC_ALL: 'C' }, 'en'],
    [{ LANG: 'en_US.UTF-8', LC_MESSAGES: 'es_ES.UTF-8' }, 'es'],
    [{ LANG: 'es_PE.UTF-8', LC_MESSAGES: 'en_US.UTF-8', LC_ALL: 'es_PE.UTF-8' }, 'es'],
    [{ LANG: 'es_PE.UTF-8', LC_ALL: '', LC_MESSAGES: ' ' }, 'es'],
  ])('%j → %s', (env, want) => {
    expect(langFromEnv(env)).toBe(want);
  });
});

describe('el CLI habla el idioma del entorno (#73)', () => {
  it('--help: inglés con LANG=en_US, español con LANG=es_PE; los comandos son los mismos', async () => {
    const en = await cli(['--help'], EN);
    const es = await cli(['--help'], ES);
    expect(en.code).toBe(EXIT.ok);
    expect(es.code).toBe(EXIT.ok);
    expect(en.stdout).toContain('Usage: dagyard <command> [options]');
    expect(en.stdout).toContain('adds a node to the plan');
    expect(en.stdout).not.toMatch(/Comandos|agrega un nodo/);
    expect(es.stdout).toContain('Uso: dagyard <comando> [opciones]');
    expect(es.stdout).toContain('agrega un nodo al plan');
    const commands = (s: string) => s.split('\n').filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim().split(/\s{2,}/)[0]);
    expect(commands(en.stdout)).toEqual(commands(es.stdout));
  });

  it('ayuda de un comando y error de uso: mismo exit code en los dos idiomas', async () => {
    const en = await cli(['block', '--help'], EN);
    const es = await cli(['block', '--help'], ES);
    expect(en.stdout).toContain('Usage: dagyard block <node> --kind decision|review|access');
    expect(es.stdout).toContain('Uso: dagyard block <nodo> --kind decision|review|access');

    const badEn = await cli(['node', 'add'], EN);
    const badEs = await cli(['node', 'add'], ES);
    expect(badEn.code).toBe(EXIT.usage);
    expect(badEs.code).toBe(EXIT.usage);
    expect(badEn.stderr).toBe('dagyard: missing <node>\nSee «dagyard --help» or «dagyard <command> --help».\n');
    expect(badEs.stderr).toBe('dagyard: falta <nodo>\nUsa «dagyard --help» o «dagyard <comando> --help».\n');

    const flagEn = await cli(['start', 'x', '--nope', '1'], EN);
    expect(flagEn.stderr).toContain('unknown option: --nope');
    expect((await cli(['start', 'x', '--nope', '1'], ES)).stderr).toContain('opción desconocida: --nope');
  });

  it('el uso de cada comando lista toda opción que acepta, en los dos idiomas (#103: la skill lee --help como verdad)', () => {
    const missing: string[] = [];
    for (const [name, cmd] of Object.entries(COMMANDS)) {
      const opts = [...cmd.flags, ...(cmd.bools ?? [])].filter((f) => f !== 'project' && f !== 'url');
      cmd.usage.forEach((usage, i) => {
        for (const o of opts) if (!new RegExp(`--${o}\\b`).test(usage)) missing.push(`${name} [${i ? 'es' : 'en'}] --${o}`);
      });
    }
    expect(missing).toEqual([]);
  });

  it.each(['node add', 'goal add', 'request add'])('«%s --help» lista --report <url>', async (cmd) => {
    for (const locale of [EN, ES]) {
      const r = await cli([...cmd.split(' '), '--help'], locale);
      expect(r.code).toBe(EXIT.ok);
      expect(r.stdout.split('\n')[0]).toContain('[--report <url>]');
    }
  });

  it('next sin nada arrancable: el aviso cambia, el exit 3 y el JSON no', async () => {
    const en = await cli(['next'], EN);
    const es = await cli(['next'], ES);
    expect([en.code, es.code]).toEqual([EXIT.nothing, EXIT.nothing]);
    expect(en.stderr).toBe('dagyard: no task is ready to start in demo\n');
    expect(es.stderr).toBe('dagyard: no hay tareas arrancables en demo\n');
    const jsonEn = await cli(['next', '--json'], EN);
    const jsonEs = await cli(['next', '--json'], ES);
    expect(jsonEn.stdout).toBe(jsonEs.stdout);
    expect(jsonEn.code).toBe(jsonEs.code);
  });

  it('la salida para máquinas (ids, links) es idéntica', async () => {
    for (const argv of [['start', 'T-1'], ['open', 'T-1', '--print'], ['msg', 'T-1', 'Ya quedó el pago']]) {
      const en = await cli(argv, EN);
      const es = await cli(argv, ES);
      expect(en.stdout).toBe(es.stdout);
      expect(en.code).toBe(es.code);
    }
  });

  it('import --dry-run: el resumen cambia de idioma, el grafo del --json no', async () => {
    const from = join(import.meta.dirname, 'fixtures', 'pets');
    const en = await cli(['import', '--from', from, '--dry-run'], EN);
    const es = await cli(['import', '--from', from, '--dry-run'], ES);
    expect([en.code, es.code]).toEqual([EXIT.ok, EXIT.ok]);
    expect(en.stdout).toMatch(/^Project «Pets» \(pets\) — dry run, nothing was sent\n\d+ tasks · \d+ dependenc/);
    expect(en.stdout).toContain('Warnings (');
    expect(es.stdout).toMatch(/^Proyecto «Pets» \(pets\) — simulación, no se envió nada\n\d+ nodos · \d+ aristas/);
    const graph = async (locale: Record<string, string>) =>
      JSON.parse((await cli(['import', '--from', from, '--dry-run', '--json'], locale)).stdout).graph;
    expect(await graph(EN)).toEqual(await graph(ES));
  });

  it('LC_ALL gana a LANG, LC_MESSAGES también; vacío no cuenta', async () => {
    expect((await cli(['node', 'add'], { LANG: 'en_US.UTF-8', LC_ALL: 'es_PE.UTF-8' })).stderr).toContain('falta <nodo>');
    expect((await cli(['node', 'add'], { LANG: 'es_PE.UTF-8', LC_ALL: 'en_US.UTF-8' })).stderr).toContain('missing <node>');
    expect((await cli(['node', 'add'], { LANG: 'en_US.UTF-8', LC_MESSAGES: 'es_PE.UTF-8' })).stderr).toContain('falta <nodo>');
    expect((await cli(['node', 'add'], { LANG: 'es_PE.UTF-8', LC_ALL: '' })).stderr).toContain('falta <nodo>');
  });

  it('sin variables de idioma (o C/POSIX) → inglés', async () => {
    expect((await cli(['node', 'add'], {})).stderr).toContain('missing <node>');
    expect((await cli(['node', 'add'], { LANG: 'C' })).stderr).toContain('missing <node>');
    expect((await cli(['node', 'add'], { LC_ALL: 'POSIX', LANG: 'es_PE.UTF-8' })).stderr).toContain('missing <node>');
  });

  it('dos run a la vez con idiomas distintos no se mezclan', async () => {
    const [en, es] = await Promise.all([cli(['next'], EN), cli(['next'], ES)]);
    expect(en.stderr).toContain('no task is ready');
    expect(es.stderr).toContain('no hay tareas arrancables');
  });
});

describe('formatSync en los dos idiomas', () => {
  const report: SyncReport = {
    repo: 'cofoundy/dagyard',
    project: 'dagyard',
    dryRun: true,
    issues: 3,
    created: ['gh-1'],
    updated: ['gh-2'],
    unchanged: ['gh-3'],
    actions: [],
    warnings: ['x'],
  };

  it('inglés por defecto, español dentro de withLang es', () => {
    expect(formatSync(report)).toBe(
      'Synced 3 issues: 1 new · 1 updated · 1 unchanged\nThis was a dry run: nothing was sent to «dagyard».\nWarnings (1):\n  - x\n',
    );
    expect(withLang('es', () => formatSync(report))).toBe(
      'Sincronicé 3 issues: 1 nuevas · 1 actualizadas · 1 sin cambios\nFue una simulación: no se envió nada a «dagyard».\nAvisos (1):\n  - x\n',
    );
  });
});
