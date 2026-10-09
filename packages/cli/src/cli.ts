import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { ApiRequestError, DagyardClient } from './api.js';
import { assertKnownFlags, flag, parseArgs, UsageError, type ParsedArgs } from './args.js';
import { loadConfig, loadKey } from './config.js';
import { langFromEnv, plural, t, withLang } from './i18n.js';
import type { BlockerInput, BlockerKind, BlockerWaitResult, CloseAs, CloseInput, DagNode, Lang, NodeInput, NodeKind, NodePatch, NodePatchInput, NodeStatus, OriginInput, Team, TeamPatch } from '@dagyard/model';
import { BLOCKER_KINDS, CLOSE_AS, DEFAULT_LANG, LANGS, LIMITS, NODE_KINDS, NODE_STATUSES, TEAM_LIMITS, isSlug, normalizeIso, parseProjectGraphInput, projectLang, slugify } from '@dagyard/model';
import { parseLedger, teamPatchFromLedger, teamsFromLedger, type LedgerTeam } from './ledger.js';
import { buildImport, importProjectId, projectNameFromDir, readTasksDir, readTitles, type ImportResult } from './tasks/import.js';
import { oneLine } from './tasks/parse.js';
import { ghCliSource, type GithubSource } from './sync/github.js';
import { formatSync, syncGithub } from './sync/sync.js';

export const VERSION = '0.1.0';

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** de dónde se busca `.dagyard.json` (default `process.cwd()`) */
  cwd?: string;
  /** la cola de GitHub de `sync` (default: `gh api`) */
  github?: GithubSource;
  /** abre un link en el navegador (default: `open <link>`); `dagyard open` lo llama solo en macOS */
  open?: (link: string) => Promise<void>;
  /** el sistema (default `process.platform`) */
  platform?: NodeJS.Platform;
}

/** Exit codes: 0 ok · 1 error de la API o de red · 2 `wait` venció · 3 `next` sin nada arrancable · 64 uso. */
export const EXIT = { ok: 0, api: 1, timeout: 2, nothing: 3, usage: 64 } as const;

interface Ctx {
  io: Io;
  args: ParsedArgs;
}

/** Un texto de la ayuda en los dos idiomas; `tx` elige al imprimir. */
type Text = readonly [en: string, es: string];
const tx = (text: Text) => t(text[0], text[1]);

interface Command {
  usage: Text;
  summary: Text;
  help: Text;
  flags: readonly string[];
  bools?: readonly string[];
  run: (ctx: Ctx) => Promise<number>;
}

const GLOBAL_FLAGS = ['project', 'url'] as const;

const HELP_GLOBAL: Text = [
  `Common options (before or after the command):
  -p, --project <p>   project (or DAGYARD_PROJECT, .dagyard.json or ~/.config/dagyard/project)
  --url <url>         server (or DAGYARD_URL, .dagyard.json or ~/.config/dagyard/url)
  -h, --help          this help
.dagyard.json = {"project": "…", "url": "…"}, the first one found walking up from the current folder (never
past the repo root or $HOME); it is committed. Its url gets the key only if it is https and trusted (the
preview, dagyard.run, the one in DAGYARD_URL or ~/.config/dagyard/url, or a line of ~/.config/dagyard/trusted-urls).
The API key comes only from DAGYARD_KEY or ~/.config/dagyard/agent-key; it is never printed.
Messages are in English; with LANG=es (or LC_ALL / LC_MESSAGES) they are in Spanish.`,
  `Opciones comunes (antes o después del comando):
  -p, --project <p>   proyecto (o DAGYARD_PROJECT, .dagyard.json o ~/.config/dagyard/project)
  --url <url>         servidor (o DAGYARD_URL, .dagyard.json o ~/.config/dagyard/url)
  -h, --help          esta ayuda
.dagyard.json = {"project": "…", "url": "…"}, el primero subiendo desde la carpeta actual (sin pasar de la
raíz del repo ni de $HOME); se commitea. Su url recibe la key solo si es https y de confianza (la preview,
dagyard.run, la de DAGYARD_URL o ~/.config/dagyard/url, o una línea de ~/.config/dagyard/trusted-urls).
La API key sale solo de DAGYARD_KEY o ~/.config/dagyard/agent-key; nunca se imprime.
Los mensajes salen en inglés; con LANG=es (o LC_ALL / LC_MESSAGES), en español.`,
];

const IF_ABSENT_HELP: Text = [
  `With --if-absent, one that already exists is not an error: it prints «<id> exists», writes nothing and exits 0.
Any other conflict still fails (exit 1).`,
  `Con --if-absent, si ya existe no es un error: imprime «<id> exists», no escribe nada y sale 0. Cualquier otro
conflicto sigue fallando (exit 1).`,
];

const EXISTS = Symbol('exists');

/**
 * «Agregar si no existe» (#110): con `--if-absent`, el 409 que el servidor marca `reason: 'exists'` es `EXISTS`
 * en vez de un error. Los demás 409 (un bloqueante abierto, el tope de un equipo…) siguen siendo errores.
 */
async function ifAbsent<T>(args: ParsedArgs, write: () => Promise<T>): Promise<T | typeof EXISTS> {
  try {
    return await write();
  } catch (err) {
    if (args.bools.has('if-absent') && err instanceof ApiRequestError && err.status === 409 && err.reason === 'exists') return EXISTS;
    throw err;
  }
}

/**
 * `node add` y sus atajos `goal add` / `request add` (#90): con `kind` fijo, el atajo no acepta `--kind` (y un goal no
 * lleva cita). Imprime solo el id.
 */
function addNodeCommand(fixed?: NodeKind): Command {
  const kindFlag = fixed ? [] : ['kind'];
  const quoteFlags = fixed === 'goal' ? [] : ['quote', 'author'];
  const opts = fixed === 'goal' ? '' : fixed === 'request' ? ' --quote "…" [--author "…"]' : ' [--kind goal|request|task|stream] [--quote "…"] [--author "…"]';
  const cmd = fixed ? `${fixed} add` : 'node add';
  return {
    usage: [
      `dagyard ${cmd} <node> --title "…"${opts} [--from <node> [--why "…"]]… [--stage <stage>] [--goal "…"] [--team "…"] [--dep <node>]… [--status <status>] [--report <url>] [--link <url>] [--if-absent]`,
      `dagyard ${cmd} <nodo> --title "…"${opts} [--from <nodo> [--why "…"]]… [--stage <etapa>] [--goal "…"] [--team "…"] [--dep <nodo>]… [--status <estado>] [--report <url>] [--link <url>] [--if-absent]`,
    ],
    summary:
      fixed === 'goal'
        ? ['adds a goal: a living outcome, the root of the whys', 'agrega un objetivo: un resultado vivo, raíz de los porqués']
        : fixed === 'request'
          ? ["adds a person's request or decision, with their exact words", 'agrega el pedido o la decisión de una persona, con su cita']
          : ['adds a node to the plan (a task by default)', 'agrega un nodo al plan (una tarea por defecto)'],
    help: [
      `<node> is a short id (T-314-A is stored as t-314-a). Repeat --dep or separate it with commas.
Kinds: task (one owner, one session, one /goal; the only one that starts), goal (a living outcome; it starts
In progress and never closes as done), request (a person's request, --quote is their exact words, --author who said
it), stream (ongoing work that spawns tasks). ${fixed ? `This is node add --kind ${fixed}.` : ''}
--from <node> says which node this one was born from (repeat it); the --why right after it says why. Born-from is not
a dependency: it never blocks. --dep is a dependency: this node needs <dep> closed.
Without --stage it goes to the project's first stage. Statuses: pending, working, done (blocked is set by dagyard
block). --report attaches its report (Basalt or the PR); --link is the technical detail (the issue or PR URL).
Prints only the id. ${IF_ABSENT_HELP[0]}`,
      `<nodo> es un id corto (T-314-A se guarda como t-314-a). --dep se repite o va separado por comas.
Tipos: task (un dueño, una sesión, un /goal; la única que arranca), goal (un resultado vivo; nace En progreso y nunca
se cierra como lista), request (el pedido de una persona: --quote es su cita literal, --author quién lo dijo), stream
(trabajo continuo que suelta tareas). ${fixed ? `Es node add --kind ${fixed}.` : ''}
--from <nodo> dice de qué nodo nació este (se repite); el --why que va justo después dice por qué. Nacer de no es
depender: nunca bloquea. --dep sí es una dependencia: este nodo necesita <dep> cerrado.
Sin --stage va a la primera etapa del proyecto. Estados: pending, working, done (blocked lo pone dagyard block).
--report cuelga su informe (Basalt o el PR); --link es el detalle técnico (URL del issue o del PR). Imprime
solo el id. ${IF_ABSENT_HELP[1]}`,
    ],
    flags: ['title', 'stage', 'goal', 'team', 'dep', 'status', 'report', 'link', 'from', 'why', ...kindFlag, ...quoteFlags, ...GLOBAL_FLAGS],
    bools: ['if-absent'],
    async run({ io, args }) {
      const [id] = need(args, [['node', 'nodo']]);
      const input: NodeInput = {
        id: nodeId(id),
        title: required(args, 'title', LIMITS.title),
        deps: (args.flags.dep ?? []).flatMap((d) => d.split(',')).map((d) => d.trim()).filter(Boolean).map(nodeId),
      };
      const kind = fixed ?? kindArg(args);
      if (kind) input.kind = kind;
      const stage = flag(args, 'stage');
      if (stage !== undefined) input.stage = slugify(stage);
      const quote = optional(args, 'quote', LIMITS.quote);
      const author = optional(args, 'author', LIMITS.name);
      if (kind === 'request' && !quote) throw new UsageError(t('a request needs --quote: the exact words of the person', 'un request necesita --quote: la cita literal de la persona'));
      if (kind !== 'request' && (quote !== undefined || author !== undefined)) throw new UsageError(t('--quote and --author are only for a request', '--quote y --author son solo para un request'));
      if (quote) input.quote = quote;
      if (author) input.quoteBy = author;
      const origins = originsArg(args);
      if (origins.length) input.origins = origins;
      const goal = optional(args, 'goal', LIMITS.goal);
      if (goal !== undefined) input.goal = goal;
      const team = optional(args, 'team', LIMITS.name);
      if (team !== undefined) input.team = team;
      const status = flag(args, 'status');
      if (status !== undefined) input.status = statusArg(status);
      const report = optional(args, 'report', LIMITS.url);
      if (report !== undefined) input.reportUrl = report;
      const link = linkArg(args);
      if (link !== undefined) input.link = link;
      const node = await ifAbsent(args, () => client(io, args).addNode(project(io, args), input));
      io.stdout(node === EXISTS ? `${input.id} exists\n` : `${node?.id ?? input.id}\n`);
      return EXIT.ok;
    },
  };
}

export const COMMANDS: Record<string, Command> = {
  'node add': addNodeCommand(),
  'goal add': addNodeCommand('goal'),
  'request add': addNodeCommand('request'),
  'node update': {
    usage: [
      'dagyard node update <node> [--title "…"] [--stage <stage>] [--goal "…"] [--team "…"] [--status <status>] [--progress <p>] [--report <url>] [--link <url>]',
      'dagyard node update <nodo> [--title "…"] [--stage <etapa>] [--goal "…"] [--team "…"] [--status <estado>] [--progress <p>] [--report <url>] [--link <url>]',
    ],
    summary: ['changes fields of a task', 'cambia campos de una tarea'],
    help: [
      '--progress takes 0..1 or a percentage (40%). --link: the issue or PR URL (the technical-detail link).',
      '--progress acepta 0..1 o un porcentaje (40%). --link: URL del issue o del PR («Detalle técnico ↗»).',
    ],
    flags: ['title', 'stage', 'goal', 'team', 'status', 'progress', 'report', 'link', ...GLOBAL_FLAGS],
    async run({ io, args }) {
      const [id] = need(args, [['node', 'nodo']]);
      const patch: NodePatch = {};
      const title = optional(args, 'title', LIMITS.title);
      if (title !== undefined) patch.title = title;
      const stage = flag(args, 'stage');
      if (stage !== undefined) patch.stage = slugify(stage);
      const goal = optional(args, 'goal', LIMITS.goal);
      if (goal !== undefined) patch.goal = goal;
      const team = optional(args, 'team', LIMITS.name);
      if (team !== undefined) patch.team = team;
      const status = flag(args, 'status');
      if (status !== undefined) patch.status = statusArg(status);
      const progress = flag(args, 'progress');
      if (progress !== undefined) patch.progress = progressArg(progress);
      const report = optional(args, 'report', LIMITS.url);
      if (report !== undefined) patch.reportUrl = report;
      const link = linkArg(args);
      if (link !== undefined) patch.link = link;
      if (Object.keys(patch).length === 0) throw new UsageError(t('nothing to change', 'no hay nada que cambiar'));
      await client(io, args).updateNode(project(io, args), nodeId(id), patch);
      io.stdout(`${nodeId(id)}\n`);
      return EXIT.ok;
    },
  },
  'node start': {
    usage: ['dagyard node start <node> [--team "…"] [--site <site>]', 'dagyard node start <nodo> [--team "…"] [--site <sitio>]'],
    summary: ['marks a task In progress', 'marca una tarea En progreso'],
    help: [
      `Shortcut: dagyard start <node>. --site (or $COFOUNDY_AGENT) is the factory site that takes it: the server
adds the task to that team, and creates the team if it does not exist yet.`,
      `Atajo: dagyard start <nodo>. --site (o $COFOUNDY_AGENT) es el sitio de la fábrica que la toma: el servidor
suma la tarea a ese equipo, y crea el equipo si todavía no existe.`,
    ],
    flags: ['team', 'site', ...GLOBAL_FLAGS],
    async run({ io, args }) {
      const [id] = need(args, [['node', 'nodo']]);
      const patch: NodePatchInput = { status: 'working' };
      const team = optional(args, 'team', LIMITS.name);
      if (team !== undefined) patch.team = team;
      const site = optional(args, 'site') || io.env.COFOUNDY_AGENT?.trim();
      if (site) patch.teamId = siteId(site);
      await client(io, args).updateNode(project(io, args), nodeId(id), patch);
      io.stdout(`${nodeId(id)}\n`);
      return EXIT.ok;
    },
  },
  'node progress': {
    usage: ['dagyard node progress <node> <p>', 'dagyard node progress <nodo> <p>'],
    summary: ['reports progress (0..1 or 40%)', 'reporta avance (0..1 o 40%)'],
    help: ['Shortcut: dagyard progress <node> <p>.', 'Atajo: dagyard progress <nodo> <p>.'],
    flags: [...GLOBAL_FLAGS],
    async run({ io, args }) {
      const [id, p] = need(args, [['node', 'nodo'], ['progress', 'avance']]);
      await client(io, args).updateNode(project(io, args), nodeId(id), { progress: progressArg(p) });
      io.stdout(`${nodeId(id)}\n`);
      return EXIT.ok;
    },
  },
  'node done': {
    usage: ['dagyard node done <node> [--report <url>]', 'dagyard node done <nodo> [--report <url>]'],
    summary: ['marks a task Done', 'marca una tarea Lista'],
    help: [
      "--report attaches the task's Basalt report. Shortcut: dagyard done <node>.",
      '--report cuelga el informe de Basalt de la tarea. Atajo: dagyard done <nodo>.',
    ],
    flags: ['report', ...GLOBAL_FLAGS],
    async run({ io, args }) {
      const [id] = need(args, [['node', 'nodo']]);
      const patch: NodePatch = { status: 'done' }; // el servidor fija progress = 1
      const report = optional(args, 'report', LIMITS.url);
      if (report !== undefined) patch.reportUrl = report;
      await client(io, args).updateNode(project(io, args), nodeId(id), patch);
      io.stdout(`${nodeId(id)}\n`);
      return EXIT.ok;
    },
  },
  'node close': {
    usage: ['dagyard node close <node> --as done|replaced|dropped|learned [--why "…"] [--by <node>] [--report <url>]', 'dagyard node close <nodo> --as done|replaced|dropped|learned [--why "…"] [--by <nodo>] [--report <url>]'],
    summary: ['closes a node with its reason: done, replaced, dropped or learned', 'cierra un nodo con su motivo: lista, reemplazada, descartada o aprendimos'],
    help: [
      `--why says why; it is required for replaced, dropped and learned. A task closed as done needs evidence: --why
(what got done) or --report (or the report it already had). --by is the node that replaces it (only with replaced).
A goal or a stream never closes as done. To split a node, close it as replaced by one part and add the others with
--from <node>; to merge two, close one as replaced by the other. Closing leaves the node in the plan, in plain sight.
Prints only the id.`,
      `--why dice por qué; es obligatorio para replaced, dropped y learned. Una tarea cerrada como done necesita
evidencia: --why (qué quedó) o --report (o el informe que ya tenía). --by es el nodo que la reemplaza (solo con
replaced). Un goal o un stream nunca se cierra como done. Para partir un nodo, ciérralo como replaced por una parte
y agrega las demás con --from <nodo>; para unir dos, cierra uno como replaced por el otro. Cerrar deja el nodo en el
plan, a la vista. Imprime solo el id.`,
    ],
    flags: ['as', 'why', 'by', 'report', ...GLOBAL_FLAGS],
    async run({ io, args }) {
      const [id] = need(args, [['node', 'nodo']]);
      const as = required(args, 'as') as CloseAs;
      const reasons = CLOSE_AS.join(', ');
      if (!CLOSE_AS.includes(as)) throw new UsageError(t(`--as must be ${reasons}`, `--as debe ser ${reasons}`));
      const input: CloseInput = { as };
      const why = optional(args, 'why', LIMITS.closedReason);
      if (why) input.why = why;
      const by = flag(args, 'by');
      if (as === 'replaced' && !by) throw new UsageError(t('replaced needs --by <node>: the one that replaces it', 'replaced necesita --by <nodo>: el que la reemplaza'));
      if (as !== 'replaced' && by !== undefined) throw new UsageError(t('--by is only for --as replaced', '--by es solo para --as replaced'));
      if (by) input.by = nodeId(by);
      if (as !== 'done' && !why) throw new UsageError(t(`closing as ${as} needs --why`, `cerrar como ${as} necesita --why`));
      const report = optional(args, 'report', LIMITS.url);
      if (report !== undefined) input.reportUrl = report;
      await client(io, args).closeNode(project(io, args), nodeId(id), input);
      io.stdout(`${nodeId(id)}\n`);
      return EXIT.ok;
    },
  },
  'edge add': {
    usage: ['dagyard edge add <from> <to> [--kind origin --why "…"] [--if-absent]', 'dagyard edge add <de> <a> [--kind origin --why "…"] [--if-absent]'],
    summary: ['adds a dependency: <to> needs <from> to be closed', 'agrega una dependencia: <a> necesita que <de> esté cerrada'],
    help: [
      `With --kind origin it is not a dependency but a born-from: <to> was born from <from> (--why says why). It never
blocks. The server rejects either kind if it closes a loop, and a dependency on a goal or a stream (they never close).
Prints «<from> → <to>» (or ⇢ for a born-from). With --if-absent, an edge that already exists is not an error: it
prints «<from> → <to> exists», writes nothing and exits 0. Any other conflict still fails (exit 1).`,
      `Con --kind origin no es una dependencia sino un «nació de»: <a> nació de <de> (--why dice por qué). Nunca
bloquea. El servidor rechaza cualquiera de las dos si arma un ciclo, y una dependencia de un goal o un stream (nunca se
cierran). Imprime «<de> → <a>» (o ⇢ si es un «nació de»). Con --if-absent, si la arista ya existe no es un error:
imprime «<de> → <a> exists», no escribe nada y sale 0. Cualquier otro conflicto sigue fallando (exit 1).`,
    ],
    flags: ['kind', 'why', ...GLOBAL_FLAGS],
    bools: ['if-absent'],
    async run({ io, args }) {
      const [from, to] = need(args, [['from', 'de'], ['to', 'a']]);
      const kind = flag(args, 'kind');
      if (kind !== undefined && kind !== 'origin' && kind !== 'requires') throw new UsageError(t('--kind must be origin (or requires)', '--kind debe ser origin (o requires)'));
      const why = optional(args, 'why', LIMITS.originWhy);
      if (why !== undefined && kind !== 'origin') throw new UsageError(t('--why goes with --kind origin', '--why va con --kind origin'));
      const edge = await ifAbsent(args, () =>
        client(io, args).addEdge(project(io, args), nodeId(from), nodeId(to), kind === 'origin' ? { kind: 'origin', ...(why ? { why } : {}) } : {}),
      );
      io.stdout(`${nodeId(from)} ${kind === 'origin' ? '⇢' : '→'} ${nodeId(to)}${edge === EXISTS ? ' exists' : ''}\n`);
      return EXIT.ok;
    },
  },
  block: {
    usage: [
      'dagyard block <node> --kind decision|review|access --q "…" [--opt "…"]… [--label "…"] [--json]',
      'dagyard block <nodo> --kind decision|review|access --q "…" [--opt "…"]… [--label "…"] [--json]',
    ],
    summary: ['asks a person for a decision, a review or an access', 'le pide al humano una decisión, una revisión o un acceso'],
    help: [
      `decision: --opt at least once (at most ${LIMITS.options}).
review: without --opt it offers «Approve» and «Request changes» (in a Spanish project, «Aprobar» and «Pedir cambios»).
access: --label names the access (e.g. «Payment gateway key»).
Prints the blocker id, to pass to dagyard wait --blocker.`,
      `decision: --opt al menos una vez (máximo ${LIMITS.options}).
review: sin --opt ofrece «Approve» y «Request changes» (en un proyecto en español, «Aprobar» y «Pedir cambios»).
access: --label nombra el acceso (p. ej. «Clave de la pasarela de pagos»).
Imprime el id del bloqueante, para pasarlo a dagyard wait --blocker.`,
    ],
    flags: ['kind', 'q', 'opt', 'label', ...GLOBAL_FLAGS],
    bools: ['json'],
    async run({ io, args }) {
      const [id] = need(args, [['node', 'nodo']]);
      const kind = required(args, 'kind') as BlockerKind;
      const kinds = BLOCKER_KINDS.join(', ');
      if (!BLOCKER_KINDS.includes(kind)) throw new UsageError(t(`--kind must be ${kinds}`, `--kind debe ser ${kinds}`));
      const input: BlockerInput = { kind, question: required(args, 'q', LIMITS.question) };
      const opts = (args.flags.opt ?? []).map((o) => o.trim()).filter(Boolean);
      for (const o of opts) {
        if (o.length > LIMITS.option) throw new UsageError(t(`each --opt is at most ${LIMITS.option} characters`, `cada --opt va hasta ${LIMITS.option} caracteres`));
      }
      if (opts.length > LIMITS.options) throw new UsageError(t(`at most ${LIMITS.options} options`, `máximo ${LIMITS.options} opciones`));
      if (kind === 'access') {
        if (opts.length) throw new UsageError(t('access takes no --opt; use --label', 'access no lleva --opt; usa --label'));
        input.options = [];
        input.accessLabel = required(args, 'label', LIMITS.name);
      } else {
        if (flag(args, 'label') !== undefined) throw new UsageError(t('--label is only for access', '--label es solo para access'));
        if (!opts.length && kind !== 'review') throw new UsageError(t('decision needs at least one --opt', 'decision necesita al menos un --opt'));
        // una revisión sin --opt no manda opciones: el Worker pone las del idioma del proyecto (#77)
        if (opts.length) input.options = opts;
      }
      const blocker = await client(io, args).openBlocker(project(io, args), nodeId(id), input);
      io.stdout(args.bools.has('json') ? `${JSON.stringify(blocker)}\n` : `${blocker.id}\n`);
      return EXIT.ok;
    },
  },
  wait: {
    usage: ['dagyard wait <node> [--blocker <id>] [--timeout <sec>] [--json]', 'dagyard wait <nodo> [--blocker <id>] [--timeout <seg>] [--json]'],
    summary: ['waits for the person to answer and prints the answer', 'espera a que el humano resuelva y devuelve la resolución'],
    help: [
      `Without --blocker it waits on the node's latest open blocker (or prints the latest answered one).
First line: the chosen option (or the access value). If there is a note, «note: …» follows.
Without --timeout it waits forever. Exit 2 when it runs out.`,
      `Sin --blocker espera el último bloqueante abierto del nodo (o devuelve el último resuelto).
Primera línea: la opción elegida (o el valor del acceso). Si hay nota, sigue «nota: …».
Sin --timeout espera para siempre. Exit 2 si vence.`,
    ],
    flags: ['blocker', 'timeout', ...GLOBAL_FLAGS],
    bools: ['json'],
    async run({ io, args }) {
      const [id] = need(args, [['node', 'nodo']]);
      const timeoutRaw = flag(args, 'timeout');
      const timeout = timeoutRaw === undefined ? 0 : Number(timeoutRaw);
      if (!Number.isFinite(timeout) || timeout < 0) throw new UsageError(t('--timeout is in seconds (≥0)', '--timeout va en segundos (≥0)'));
      const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const api = client(io, args);
      const proj = project(io, args);
      const blockerId = flag(args, 'blocker') ?? (await blockerOf(api, proj, nodeId(id)));
      const deadline = timeout > 0 ? Date.now() + timeout * 1000 : Infinity;
      let failures = 0;
      for (;;) {
        const left = Math.ceil((deadline - Date.now()) / 1000);
        if (left <= 0) {
          io.stderr(t(`dagyard: nobody answered the blocker on ${nodeId(id)} within ${timeout} s\n`, `dagyard: nadie resolvió el bloqueante de ${nodeId(id)} en ${timeout} s\n`));
          return EXIT.timeout;
        }
        let result: BlockerWaitResult | null;
        try {
          result = await api.waitOnce(proj, blockerId, Math.min(25, left));
          failures = 0;
        } catch (err) {
          if (err instanceof ApiRequestError && waitTransient(err)) {
            // un long-poll suelto que falla no corta la espera (#94): backoff corto, nunca más allá del plazo
            const backoff = WAIT_BACKOFF_MS[Math.min(failures++, WAIT_BACKOFF_MS.length - 1)]!;
            await sleep(Math.max(0, Math.min(backoff, deadline - Date.now())));
            continue;
          }
          throw err;
        }
        if (result) {
          io.stdout(args.bools.has('json') ? `${JSON.stringify(result)}\n` : formatResolution(result));
          return EXIT.ok;
        }
      }
    },
  },
  msg: {
    usage: ['dagyard msg <node> "…" [--report <url>] [--from "…"]', 'dagyard msg <nodo> "…" [--report <url>] [--from "…"]'],
    summary: [`writes a short note to the PM (≤${LIMITS.message} characters)`, `le escribe al PM en corto (≤${LIMITS.message} caracteres)`],
    help: ['By default the server fills in --from (the team name).', '--from por defecto lo pone el servidor («Equipo de <equipo>»).'],
    flags: ['report', 'from', ...GLOBAL_FLAGS],
    async run({ io, args }) {
      const [id] = need(args, [['node', 'nodo'], ['text', 'texto']]);
      const text = args.positionals.slice(1).join(' ').trim();
      if (!text) throw new UsageError(t('the message is empty', 'el mensaje está vacío'));
      if ([...text].length > LIMITS.message) {
        const len = [...text].length;
        throw new UsageError(t(`the message has ${len} characters; the limit is ${LIMITS.message}`, `el mensaje tiene ${len} caracteres; el máximo es ${LIMITS.message}`));
      }
      const input: { text: string; from?: string; reportUrl?: string } = { text };
      const from = optional(args, 'from', LIMITS.name);
      if (from !== undefined) input.from = from;
      const report = optional(args, 'report', LIMITS.url);
      if (report !== undefined) input.reportUrl = report;
      const message = await client(io, args).postMessage(project(io, args), nodeId(id), input);
      io.stdout(`${message?.id ?? 'ok'}\n`);
      return EXIT.ok;
    },
  },
  next: {
    usage: ['dagyard next [--project <p>] [--json]', 'dagyard next [--project <p>] [--json]'],
    summary: ['the next task ready to start, with its /goal line ready to paste', 'la siguiente tarea arrancable, con su línea /goal lista para pegar'],
    help: [
      `Prints a single line: /goal <mission>; the task's link in the sky goes separately, on stderr
(«in the sky: …»), so the output pastes as is. --json carries it in «link». Exit 3 when nothing is ready to start.`,
      `Imprime una sola línea: /goal <misión>; el link de la tarea en el cielo va aparte, por stderr
(«en el cielo: …»), así la salida se pega tal cual. --json lo trae en «link». Exit 3 si no hay nada arrancable.`,
    ],
    flags: [...GLOBAL_FLAGS],
    bools: ['json'],
    async run({ io, args }) {
      need(args, []);
      const proj = project(io, args);
      const srv = server(io, args);
      const res = await client(io, args, srv).next(proj);
      const link = res.node ? skyLink(srv.url, proj, res.node.id) : null;
      if (args.bools.has('json')) {
        io.stdout(`${JSON.stringify({ ...res, link })}\n`);
        return res.goalLine ? EXIT.ok : EXIT.nothing;
      }
      if (!res.goalLine) {
        io.stderr(t(`dagyard: no task is ready to start in ${proj}\n`, `dagyard: no hay tareas arrancables en ${proj}\n`));
        return EXIT.nothing;
      }
      io.stdout(`${goalLine(res.goalLine)}\n`);
      if (link) io.stderr(t(`in the sky: ${link}\n`, `en el cielo: ${link}\n`));
      return EXIT.ok;
    },
  },
  open: {
    usage: ['dagyard open [<task>] [--print]', 'dagyard open [<tarea>] [--print]'],
    summary: ['the sky link to the project or to a task; on macOS it opens it', 'el link del cielo al proyecto o a una tarea; en macOS lo abre'],
    help: [
      `Without <task>, the project; with <task>, the sky flies to it and opens its card.
Prints the link (safe to send to anyone: the key is never in it) and on macOS opens it in the browser.
--print only prints it. It does not use the API key or call the server.`,
      `Sin <tarea>, el proyecto; con <tarea>, el cielo vuela a ella y abre su ficha.
Imprime el link (se puede mandar a quien sea: la clave nunca va en él) y en macOS lo abre en el navegador.
--print solo lo imprime. No usa la API key ni llama al servidor.`,
    ],
    flags: [...GLOBAL_FLAGS],
    bools: ['print'],
    async run({ io, args }) {
      if (args.positionals.length > 1) throw new UsageError(extra(args.positionals[1]!));
      const [task] = args.positionals;
      const link = skyLink(server(io, args).url, project(io, args), task === undefined ? undefined : nodeId(task));
      io.stdout(`${link}\n`);
      if (!args.bools.has('print') && (io.platform ?? process.platform) === 'darwin') {
        try {
          await (io.open ?? openInBrowser)(link);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          io.stderr(t(`dagyard: could not open the browser (${why}); copy the link\n`, `dagyard: no pude abrir el navegador (${why}); copia el link\n`));
        }
      }
      return EXIT.ok;
    },
  },
  import: {
    usage: [
      'dagyard import --from <path to .cofoundy/tasks> [--project <p>] [--name "…"] [--lang en|es] [--titles <json>] [--replace] [--dry-run] [--json]',
      'dagyard import --from <ruta a .cofoundy/tasks> [--project <p>] [--name "…"] [--lang en|es] [--titles <json>] [--replace] [--dry-run] [--json]',
    ],
    summary: ["creates a new project from the orchestrator's tasks", 'crea un proyecto nuevo desde las tareas del orchestrator'],
    help: [
      `deps and blockedBy become dependencies; status is normalized to ${NODE_STATUSES.join(', ')}.
Stages: phase if every task has one; otherwise by depth («Getting started», «Next», «Then», … «Finally»).
Stages and missions go in the project's language: --lang for a new one (default en); --replace keeps the
existing project's language unless you pass --lang.
If the project already exists it is not overwritten (the server decides on create): pick another with --project
or pass --replace to replace it. With the agent key, replacing keeps the owner's questions and answers and the
server rejects it (409) if the new graph drops a task that has any; with the owner token, --replace deletes them
and recreates them from the files.
--titles sets PM-friendly titles: a JSON object { "node id": "title" }, inline or the path to a .json file.
They replace the ones taken from the tasks; unknown ids or titles over ${LIMITS.title} characters only warn.
--dry-run only counts, sends nothing and needs no server (with --replace it reads the project's language if it can).`,
      `deps y blockedBy se vuelven dependencias; status se normaliza a ${NODE_STATUSES.join(', ')}.
Etapas: phase si todas las tareas lo traen; si no, por profundidad («Para empezar», «Después», «Luego», … «Al final»
en un proyecto en español). Etapas y misiones van en el idioma del proyecto: --lang para uno nuevo (default en);
--replace conserva el del proyecto existente salvo que pases --lang.
Si el proyecto ya existe no lo pisa (el servidor lo decide al crear): elige otro con --project o pasa
--replace para reemplazarlo. Con la clave de agente, el reemplazo conserva las preguntas y respuestas
del dueño y el servidor lo rechaza (409) si el grafo nuevo quita una tarea que tiene alguna; con el token
del dueño, --replace las borra y las recrea desde el archivo.
--titles pone los títulos en lenguaje de PM: un objeto JSON { "id de nodo": "título" }, en línea o la ruta a un
archivo .json. Reemplazan a los que se sacan de las tareas; ids desconocidos o títulos de más de ${LIMITS.title}
caracteres solo avisan.
--dry-run solo cuenta, no envía nada y no necesita servidor (con --replace lee el idioma del proyecto si puede).`,
    ],
    flags: ['from', 'name', 'lang', 'titles', ...GLOBAL_FLAGS],
    bools: ['dry-run', 'json', 'replace'],
    async run({ io, args }) {
      need(args, []);
      const from = required(args, 'from');
      const langFlag = flag(args, 'lang');
      if (langFlag !== undefined && !LANGS.includes(langFlag as Lang)) {
        throw new UsageError(t(`--lang is ${LANGS.join(' or ')}: «${langFlag}»`, `--lang va ${LANGS.join(' o ')}: «${langFlag}»`));
      }
      let files;
      try {
        files = readTasksDir(from);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new UsageError(t(`could not read ${from}: ${why}`, `no pude leer ${from}: ${why}`));
      }
      if (!files.length) throw new UsageError(t(`no tasks (*.md) in ${from}`, `no hay tareas (*.md) en ${from}`));
      const name = flag(args, 'name');
      const titlesRaw = flag(args, 'titles');
      let titles;
      try {
        titles = titlesRaw === undefined ? undefined : readTitles(titlesRaw);
      } catch (err) {
        throw new UsageError(`--titles: ${err instanceof Error ? err.message : String(err)}`);
      }
      const where = { dirName: projectNameFromDir(from), ...(flag(args, 'project') ? { projectId: flag(args, 'project')! } : {}) };
      const dry = args.bools.has('dry-run');
      const replace = args.bools.has('replace');
      // idioma de los datos (#77): --lang; si no, el del proyecto que se reemplaza; si no, el de uno nuevo
      let dataLang = (langFlag as Lang | undefined) ?? DEFAULT_LANG;
      let langNote: string | null = null;
      if (langFlag === undefined && replace) {
        try {
          dataLang = (await existingProjectLang(client(io, args), importProjectId(where))) ?? DEFAULT_LANG;
        } catch (err) {
          if (!dry) throw err;
          const why = err instanceof Error ? err.message : String(err);
          langNote = t(`could not read the project's language (${why}); the preview uses English`, `no pude leer el idioma del proyecto (${why}); la simulación va en inglés`);
        }
      }
      const result = buildImport(files, { ...where, ...(name ? { name } : {}), ...(titles ? { titles } : {}), projectLang: dataLang });
      if (langNote) result.warnings.unshift(langNote);
      const check = parseProjectGraphInput(result.graph);
      if (!check.ok) throw new Error(t(`the imported graph fails the model's validation: ${check.message}`, `el grafo importado no pasa la validación del modelo: ${check.message}`));
      if (!dry) {
        // sin --replace, el «¿ya existe?» lo decide el servidor en la misma escritura: dos imports a la vez no se pisan
        try {
          await client(io, args).putProject(result.projectId, result.graph, { exclusive: !replace });
        } catch (err) {
          if (replace || !(err instanceof ApiRequestError) || err.status !== 409) throw err;
          throw new ApiRequestError(
            409,
            'conflict',
            t(
              `the project «${result.projectId}» already exists and I will not overwrite it; use --project <other> to create a new one or --replace to replace it`,
              `el proyecto «${result.projectId}» ya existe y no lo piso; usa --project <otro> para crear uno nuevo o --replace para reemplazarlo`,
            ),
          );
        }
      }
      io.stdout(args.bools.has('json') ? `${JSON.stringify(result, null, 2)}\n` : formatImport(result, dry, replace));
      return EXIT.ok;
    },
  },
  'team start': {
    usage: [
      'dagyard team start <site> [--name "…"] [--issues 45,46] [--at <iso date>]',
      'dagyard team start <sitio> [--name "…"] [--issues 45,46] [--at <fecha iso>]',
    ],
    summary: ['a factory site starts: its team appears on the timeline', 'arranca un sitio de la fábrica: su equipo aparece en la línea de tiempo'],
    help: [
      `<site> is the site's slug (the one in the factory ledger). --name is its human name («Timeline»); without it
the server derives one from the slug. --issues adds gh-<n> tasks to the team (repeat it or use commas).
The start time is now (or --at); starting it again keeps the first one and reopens it if it was closed.`,
      `<sitio> es el slug del sitio (el del ledger de la fábrica). --name es su nombre humano («Tiempo»); sin él
el servidor lo saca del slug. --issues suma tareas gh-<n> al equipo (se repite o va con comas).
La hora de arranque es ahora (o --at); volver a arrancarlo conserva la primera y lo reabre si estaba cerrado.`,
    ],
    flags: ['name', 'issues', 'at', ...GLOBAL_FLAGS],
    async run({ io, args }) {
      const [raw] = need(args, [['site', 'sitio']]);
      const tid = siteId(raw);
      const proj = project(io, args);
      const api = client(io, args);
      const at = atArg(args);
      const issues = issuesArg(args);
      const current = await currentTeam(api, proj, tid);
      const patch: TeamPatch = {};
      const name = optional(args, 'name', LIMITS.name);
      if (name) patch.name = name;
      // se suman en el servidor, sobre la lista vigente: otro escritor entre la lectura y esta escritura no se pierde
      const add = issues.filter((nid) => !current?.nodeIds.includes(nid));
      if (add.length) patch.addNodeIds = add;
      if (at || !current?.startedAt) patch.startedAt = at ?? new Date().toISOString();
      if (current?.closedAt) {
        patch.closedAt = null;
        patch.outcome = null;
      }
      const team = await api.putTeam(proj, tid, patch);
      io.stdout(`${team?.id ?? tid}\n`);
      return EXIT.ok;
    },
  },
  'team close': {
    usage: [
      'dagyard team close <site> --outcome <merged|pr-open|stopped> [--at <iso date>]',
      'dagyard team close <sitio> --outcome <merged|pr-open|stopped> [--at <fecha iso>]',
    ],
    summary: ['a factory site closes, with how it ended', 'cierra un sitio de la fábrica, con cómo terminó'],
    help: [
      `--outcome is how it ended: merged, pr-open or stopped (or a short note). The close time is now (or --at);
closing it again with the same outcome changes nothing.`,
      `--outcome es cómo terminó: merged, pr-open o stopped (o una nota corta). La hora de cierre es ahora (o --at);
volver a cerrarlo con el mismo desenlace no cambia nada.`,
    ],
    flags: ['outcome', 'at', ...GLOBAL_FLAGS],
    async run({ io, args }) {
      const [raw] = need(args, [['site', 'sitio']]);
      const tid = siteId(raw);
      const outcome = required(args, 'outcome', TEAM_LIMITS.outcome);
      const at = atArg(args);
      const proj = project(io, args);
      const api = client(io, args);
      const current = await currentTeam(api, proj, tid);
      const patch: TeamPatch = { outcome };
      if (at) patch.closedAt = at;
      else if (!(current?.closedAt && current.outcome === outcome)) patch.closedAt = new Date().toISOString();
      const team = await api.putTeam(proj, tid, patch);
      io.stdout(`${team?.id ?? tid}\n`);
      return EXIT.ok;
    },
  },
  'import-ledger': {
    usage: [
      'dagyard import-ledger [<sites.jsonl>] [--repo <repo>] [--dry-run] [--json]',
      'dagyard import-ledger [<sites.jsonl>] [--repo <repo>] [--dry-run] [--json]',
    ],
    summary: ["brings the factory's history in as teams, with its dates", 'trae la historia de la fábrica como equipos, con sus fechas'],
    help: [
      `By default it reads ~/cofoundy/.coordination/factory/sites.jsonl (JSONL, or a JSON array) and keeps the rows of
--repo (by default the repo of the current folder, from its origin remote). Each site becomes a team: requested,
started and closed with the site's own dates, its issues as gh-<n> tasks. The ledger wins on the dates it knows and
never erases what it does not know. Idempotent: running it again sends nothing. --dry-run reads but writes nothing.`,
      `Por defecto lee ~/cofoundy/.coordination/factory/sites.jsonl (JSONL, o un array JSON) y se queda con las filas de
--repo (por defecto el repo de la carpeta actual, por su remoto origin). Cada sitio es un equipo: pedido, arrancado
y cerrado con las fechas del sitio, sus issues como tareas gh-<n>. El ledger manda en las fechas que conoce y nunca
borra lo que no conoce. Idempotente: correrlo otra vez no manda nada. --dry-run lee pero no escribe nada.`,
    ],
    flags: ['repo', ...GLOBAL_FLAGS],
    bools: ['dry-run', 'json'],
    async run({ io, args }) {
      if (args.positionals.length > 1) throw new UsageError(extra(args.positionals[1]!));
      const file = args.positionals[0] ?? join(io.env.HOME || homedir(), 'cofoundy', '.coordination', 'factory', 'sites.jsonl');
      let parsed;
      try {
        parsed = parseLedger(readFileSync(file, 'utf8'));
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new UsageError(t(`could not read the ledger ${file}: ${why}`, `no pude leer el ledger ${file}: ${why}`));
      }
      const needsRepo = parsed.rows.some((r) => typeof r.repo === 'string');
      const repo = optional(args, 'repo') || (needsRepo ? repoOf(io.cwd ?? process.cwd()) : null);
      if (needsRepo && !repo) {
        throw new UsageError(t('missing --repo: I could not tell the repo of the current folder', 'falta --repo: no pude saber el repo de la carpeta actual'));
      }
      const { teams, skipped } = teamsFromLedger(parsed.rows, repo);
      const proj = project(io, args);
      const api = client(io, args);
      const snap = await api.snapshot(proj);
      const current = new Map((snap.teams ?? []).map((tm) => [tm.id, tm]));
      const plan = teams.map((l): { id: string; action: LedgerAction; patch: TeamPatch | null; error?: string } => {
        const patch: TeamPatch | null = teamPatchFromLedger(l, current.get(l.id));
        const isNew = !current.has(l.id);
        const name = isNew ? nameFromTasks(l, snap.nodes) : undefined;
        if (patch && name) patch.name = name;
        const action: LedgerAction = isNew ? 'created' : patch ? 'updated' : 'unchanged';
        return { id: l.id, action, patch };
      });
      const dry = args.bools.has('dry-run');
      // un equipo que el servidor rechaza no corta el resto: se reporta al final y el exit es 1
      if (!dry)
        for (const p of plan) {
          if (!p.patch) continue;
          try {
            await api.putTeam(proj, p.id, p.patch);
          } catch (err) {
            if (!(err instanceof ApiRequestError)) throw err;
            p.action = 'failed';
            p.error = `${err.code}: ${err.message}`;
          }
        }
      const report = { file, repo, project: proj, dryRun: dry, skipped, invalid: parsed.invalid, teams: plan };
      io.stdout(args.bools.has('json') ? `${JSON.stringify(report, null, 2)}\n` : formatLedger(report));
      const failed = plan.filter((p) => p.action === 'failed');
      for (const p of failed) io.stderr(`dagyard: ${p.id}: ${p.error}\n`);
      return failed.length ? EXIT.api : EXIT.ok;
    },
  },
  sync: {
    usage: [
      'dagyard sync --github <owner/repo> [--label <l>] [--stage <stage>] [--all] [--dry-run] [--json]',
      'dagyard sync --github <owner/repo> [--label <l>] [--stage <etapa>] [--all] [--dry-run] [--json]',
    ],
    summary: ['creates or updates the gh-<n> tasks from GitHub issues', 'crea o actualiza las tareas gh-<n> desde los issues de GitHub'],
    help: [
      `Uses gh (GitHub CLI), signed in. It never replaces the graph: it only adds and moves forward, every change live.
New task = open issue (with --all also the closed ones, already Done), in --stage, or the build stage (Build /
Construcción), or the first stage, with the link to the issue. --stage takes the id or the name, in either language,
and sync never creates a stage. A decision with no options in the body offers Yes / No in the project's language.
On an existing task it never changes title, stage, team or mission; the link, only if it
has none. Status only moves forward: closed → Done; open with an open PR that says «closes #n» → In progress.
«Part of #n» → task n needs this one; «depends on #n», «blocked by #n» or «bloqueado por #n» → this one needs n.
The founder-input label opens a decision with the options from the body (- **A:** …, - A) …), only if the task
has no decision yet (open or answered). The epic label creates no task.
--dry-run reads but writes nothing.`,
      `Usa gh (GitHub CLI) autenticado. Nunca reemplaza el grafo: solo agrega y avanza, cada cambio en vivo.
Tarea nueva = issue abierto (con --all también los cerrados, ya Listos), en --stage, o la de construcción (Build /
Construcción), o la primera etapa, con el enlace al issue. --stage acepta el id o el nombre, en cualquiera de los dos
idiomas, y sync nunca crea una etapa. Una decisión sin opciones en el cuerpo ofrece Sí / No en el idioma del proyecto.
A una tarea que ya existe nunca le cambia título, etapa, equipo ni misión; el enlace, solo si
no tiene. El estado solo avanza: cerrado → Lista; abierto con un PR abierto que dice «closes #n» → En progreso.
«Parte de #n» → la tarea n necesita esta; «depende de #n», «blocked by #n» o «bloqueado por #n» → esta necesita la n.
La etiqueta founder-input abre una decisión con las opciones del cuerpo (- **A:** …, - A) …), solo si la tarea
no tiene ya una decisión (abierta o respondida). La etiqueta epic no crea tarea.
--dry-run lee pero no escribe nada.`,
    ],
    flags: ['github', 'label', 'stage', ...GLOBAL_FLAGS],
    bools: ['all', 'dry-run', 'json'],
    async run({ io, args }) {
      need(args, []);
      const repo = required(args, 'github');
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some((seg) => seg === '.' || seg.includes('..'))) {
        throw new UsageError(t(`--github goes as owner/repo: «${repo}»`, `--github va como owner/repo: «${repo}»`));
      }
      const label = optional(args, 'label');
      const stage = optional(args, 'stage');
      const report = await syncGithub(client(io, args), io.github ?? ghCliSource(), project(io, args), {
        repo,
        ...(label ? { label } : {}),
        ...(stage ? { stage } : {}),
        all: args.bools.has('all'),
        dryRun: args.bools.has('dry-run'),
      });
      io.stdout(args.bools.has('json') ? `${JSON.stringify(report, null, 2)}\n` : formatSync(report));
      return EXIT.ok;
    },
  },
};

const SHORTCUTS: Record<string, string> = { start: 'node start', progress: 'node progress', done: 'node done' };

export async function run(argv: string[], io: Io): Promise<number> {
  return withLang(langFromEnv(io.env), () => runIn(argv, io));
}

async function runIn(argv: string[], io: Io): Promise<number> {
  let key: string | null = null;
  try {
    key = loadKey(io.env);
    const lead = leadingGlobals(argv);
    argv = lead.rest;
    const [first, second] = argv;
    if (!first || first === 'help' || first === '--help' || first === '-h') {
      io.stdout(globalHelp());
      return EXIT.ok;
    }
    if (first === '--version' || first === '-v' || first === 'version') {
      io.stdout(`${VERSION}\n`);
      return EXIT.ok;
    }
    let name: string;
    let rest: string[];
    if (first === 'node' || first === 'edge' || first === 'team' || first === 'goal' || first === 'request') {
      if (!second || second.startsWith('-')) {
        io.stdout(groupHelp(first));
        return second && !['--help', '-h'].includes(second) ? EXIT.usage : EXIT.ok;
      }
      name = `${first} ${second}`;
      rest = argv.slice(2);
    } else {
      name = SHORTCUTS[first] ?? first;
      rest = argv.slice(1);
    }
    const cmd = COMMANDS[name];
    if (!cmd) throw new UsageError(t(`unknown command «${name}»`, `no conozco el comando «${name}»`));
    // las globales de antes del comando van primero: si se repiten después, gana la de después
    const args = parseArgs([...lead.globals, ...rest], cmd.bools ?? []);
    if (args.bools.has('help')) {
      io.stdout(commandHelp(cmd));
      return EXIT.ok;
    }
    assertKnownFlags(args, cmd.flags);
    for (const b of args.bools) {
      if (b !== 'help' && !(cmd.bools ?? []).includes(b)) throw new UsageError(t(`unknown option: --${b}`, `opción desconocida: --${b}`));
    }
    return await cmd.run({ io, args });
  } catch (err) {
    const redact = (s: string) => (key ? s.split(key).join('***') : s);
    if (err instanceof UsageError) {
      const hint = t('See «dagyard --help» or «dagyard <command> --help».', 'Usa «dagyard --help» o «dagyard <comando> --help».');
      io.stderr(redact(`dagyard: ${err.message}\n${hint}\n`));
      return EXIT.usage;
    }
    if (err instanceof ApiRequestError) {
      io.stderr(redact(`dagyard: ${err.code}: ${err.message}\n`));
      return EXIT.api;
    }
    io.stderr(redact(`dagyard: ${err instanceof Error ? err.message : String(err)}\n`));
    return EXIT.api;
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * `dagyard --project p --url u node start x`: las opciones globales que van antes del comando
 * (el kickoff de la fábrica las pone ahí). Se separan para que el comando las reciba como suyas.
 */
function leadingGlobals(argv: string[]): { globals: string[]; rest: string[] } {
  const globals: string[] = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const m = /^(?:--(project|url)|-(p))(=.*)?$/.exec(argv[i]!);
    if (!m) break;
    globals.push(argv[i]!);
    if (m[3] !== undefined) continue;
    const value = argv[i + 1];
    const opt = m[1] ?? 'project';
    if (value === undefined) throw new UsageError(t(`--${opt} needs a value`, `a --${opt} le falta el valor`));
    globals.push(value);
    i++;
  }
  return { globals, rest: argv.slice(i) };
}

/** `skipRepoUrl`: la url de `.dagyard.json` no hace falta (vino `--url`, o solo se pide el proyecto). */
function config(io: Io, skipRepoUrl: boolean) {
  return loadConfig(io.env, io.cwd ?? process.cwd(), { warn: io.stderr, skipRepoUrl });
}

/** El servidor y la key; la key puede faltar (`open` no la usa), el servidor no. */
function server(io: Io, args: ParsedArgs): { url: string; key: string | null } {
  const urlFlag = flag(args, 'url');
  const cfg = config(io, urlFlag !== undefined);
  const url = urlFlag ?? cfg.url;
  if (!url) {
    throw new UsageError(
      t('missing server: --url, DAGYARD_URL, .dagyard.json or ~/.config/dagyard/url', 'falta el servidor: --url, DAGYARD_URL, .dagyard.json o ~/.config/dagyard/url'),
    );
  }
  return { url, key: cfg.key };
}

function client(io: Io, args: ParsedArgs, srv = server(io, args)): DagyardClient {
  if (!srv.key) throw new UsageError(t('missing API key: DAGYARD_KEY or ~/.config/dagyard/agent-key', 'falta la API key: DAGYARD_KEY o ~/.config/dagyard/agent-key'));
  return new DagyardClient({ baseUrl: srv.url, key: srv.key, ...(io.fetch ? { fetch: io.fetch } : {}), ...(io.sleep ? { sleep: io.sleep } : {}) });
}

/** `open <link>` de macOS; falla si el comando no existe o sale con error. */
function openInBrowser(link: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('open', [link], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(t(`open exited with ${code}`, `open salió con ${code}`)))));
  });
}

function project(io: Io, args: ParsedArgs): string {
  const p = flag(args, 'project') ?? config(io, true).project;
  if (!p) {
    throw new UsageError(
      t(
        'missing project: --project, DAGYARD_PROJECT, .dagyard.json or ~/.config/dagyard/project',
        'falta el proyecto: --project, DAGYARD_PROJECT, .dagyard.json o ~/.config/dagyard/project',
      ),
    );
  }
  return slugify(p);
}

/** Los posicionales obligatorios, en orden (los que se piden siempre existen); cada nombre en inglés y español. */
function need(args: ParsedArgs, names: Text[]): [string, string] {
  const missing = names.slice(args.positionals.length);
  if (missing.length) {
    const name = tx(missing[0]!);
    throw new UsageError(t(`missing <${name}>`, `falta <${name}>`));
  }
  if (names.length === 0 && args.positionals.length) throw new UsageError(extra(args.positionals[0]!));
  return args.positionals as [string, string];
}

/** El slug de un sitio (`$COFOUNDY_AGENT`, el del ledger). */
function siteId(raw: string): string {
  const v = raw.trim();
  if (isSlug(v)) return v;
  if (!/[a-z0-9]/i.test(raw.normalize('NFD'))) throw new UsageError(t(`«${raw}» is not a usable site id`, `«${raw}» no sirve como id de sitio`));
  return slugify(raw.trim());
}

/** `--at`: una fecha ISO 8601 con hora y zona, normalizada. */
function atArg(args: ParsedArgs): string | undefined {
  const raw = optional(args, 'at');
  if (raw === undefined) return undefined;
  const at = normalizeIso(raw);
  if (!at) throw new UsageError(t(`--at is an ISO 8601 date with time and zone (2026-10-04T05:35:20Z): «${raw}»`, `--at va como fecha ISO 8601 con hora y zona (2026-10-04T05:35:20Z): «${raw}»`));
  return at;
}

/** `--issues 45,46` (o repetido; `#45` y `gh-45` también valen) → `["gh-45", "gh-46"]`. */
function issuesArg(args: ParsedArgs): string[] {
  const out: string[] = [];
  for (const part of (args.flags.issues ?? []).flatMap((v) => v.split(','))) {
    const n = part.trim().replace(/^(?:gh-|#)/i, '');
    if (!n) continue;
    if (!/^\d+$/.test(n)) throw new UsageError(t(`--issues takes issue numbers: «${part.trim()}»`, `--issues lleva números de issue: «${part.trim()}»`));
    if (!out.includes(`gh-${n}`)) out.push(`gh-${n}`);
  }
  return out;
}

async function currentTeam(api: DagyardClient, proj: string, tid: string): Promise<Team | undefined> {
  return (await api.snapshot(proj)).teams?.find((tm) => tm.id === tid);
}

/** El repo de una carpeta: el nombre del remoto origin (`cofoundy/dagyard.git` → `dagyard`); si no hay, el de la carpeta raíz. */
export function repoOf(cwd: string): string | null {
  const git = (...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const m = /([^/:]+?)(?:\.git)?\/?$/.exec(git('remote', 'get-url', 'origin'));
    if (m) return m[1]!;
  } catch {
    // sin remoto origin: probamos con la raíz
  }
  try {
    return basename(git('rev-parse', '--show-toplevel')) || null;
  } catch {
    return null;
  }
}

/** El nombre humano de un equipo nuevo: el `team` que llevan sus tareas (si no es la fábrica); si no, lo pone el servidor. */
function nameFromTasks(l: LedgerTeam, nodes: readonly DagNode[]): string | undefined {
  for (const id of l.nodeIds) {
    const team = nodes.find((n) => n.id === id)?.team?.trim();
    if (team && !/^(f[áa]brica|factory)$/i.test(team)) return team;
  }
  return undefined;
}

type LedgerAction = 'created' | 'updated' | 'unchanged' | 'failed';

function formatLedger(r: { repo: string | null; project: string; dryRun: boolean; invalid: number; teams: Array<{ id: string; action: LedgerAction; patch: TeamPatch | null }> }): string {
  const count = (a: LedgerAction) => r.teams.filter((x) => x.action === a).length;
  const head = r.dryRun ? t('(dry run, nothing sent) ', '(simulación, no envié nada) ') : '';
  const of = r.repo ? t(` of ${r.repo}`, ` de ${r.repo}`) : '';
  const lines = [
    head +
      t(
        `${plural(r.teams.length, ['team', 'teams'], ['equipo', 'equipos'])} in the ledger${of} → ${r.project}: ${count('created')} new, ${count('updated')} updated, ${count('unchanged')} unchanged`,
        `${plural(r.teams.length, ['team', 'teams'], ['equipo', 'equipos'])} en el ledger${of} → ${r.project}: ${count('created')} nuevos, ${count('updated')} actualizados, ${count('unchanged')} sin cambios`,
      ),
  ];
  for (const x of r.teams) {
    if (x.action === 'created') lines.push(`  + ${x.id}${x.patch?.name ? ` «${x.patch.name}»` : ''}`);
    else if (x.action === 'updated') lines.push(`  ~ ${x.id} (${Object.keys(x.patch ?? {}).join(', ')})`);
  }
  for (const x of r.teams) if (x.action === 'failed') lines.push(`  ! ${x.id}`);
  if (count('failed')) lines.push(t(`  ${count('failed')} rejected by the server (see stderr)`, `  ${count('failed')} rechazados por el servidor (mira stderr)`));
  if (r.invalid) lines.push(t(`  ${r.invalid} unreadable rows skipped`, `  ${r.invalid} filas ilegibles ignoradas`));
  return `${lines.join('\n')}\n`;
}

function extra(arg: string): string {
  return t(`unexpected «${arg}»`, `sobra «${arg}»`);
}

function nodeId(raw: string): string {
  if (!/[a-z0-9]/i.test(raw.normalize('NFD'))) throw new UsageError(t(`«${raw}» is not a usable node id`, `«${raw}» no sirve como id de nodo`));
  return slugify(raw);
}

/** El último bloqueante abierto del nodo; si no hay, el último resuelto. */
/** Esperas de `wait` entre long-polls fallidos (#94): crecen hasta 10 s y vuelven a 1 s tras una vuelta buena. */
export const WAIT_BACKOFF_MS = [1000, 2000, 5000, 10_000];

/**
 * ¿Un long-poll fallido merece otra vuelta? Sí ante la red, cualquier 5xx (`internal`, `unavailable`,
 * `overloaded`, el borde) o un 429: el bloqueante sigue ahí. Un 4xx (`not_found`, `unauthorized`,
 * `forbidden`, una petición mal hecha) no cambia por esperar, así que corta.
 */
const waitTransient = (err: ApiRequestError) => err.status === 0 || err.status >= 500 || err.status === 429;

async function blockerOf(api: DagyardClient, proj: string, node: string): Promise<string> {
  const mine = (await api.snapshot(proj)).blockers
    .filter((b) => b.nodeId === node)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const pick = mine.filter((b) => b.status === 'open').pop() ?? mine.pop();
  if (!pick) throw new UsageError(t(`${node} has no blockers; open one with «dagyard block ${node} …»`, `${node} no tiene bloqueantes; ábrelo con «dagyard block ${node} …»`));
  return pick.id;
}

function required(args: ParsedArgs, key: string, max?: number): string {
  const v = optional(args, key, max);
  if (v === undefined || v === '') throw new UsageError(t(`missing --${key}`, `falta --${key}`));
  return v;
}

function optional(args: ParsedArgs, key: string, max?: number): string | undefined {
  const v = flag(args, key)?.trim();
  if (v !== undefined && max !== undefined && [...v].length > max) {
    throw new UsageError(t(`--${key} is at most ${max} characters`, `--${key} va hasta ${max} caracteres`));
  }
  return v;
}

function linkArg(args: ParsedArgs): string | undefined {
  const link = optional(args, 'link', LIMITS.url);
  if (link !== undefined && !/^https?:\/\/\S+$/i.test(link)) {
    throw new UsageError(t(`--link must be an http(s) URL (the issue or PR one): «${link}»`, `--link debe ser una URL http(s) (la del issue o del PR): «${link}»`));
  }
  return link;
}

function kindArg(args: ParsedArgs): NodeKind | undefined {
  const k = flag(args, 'kind');
  if (k === undefined) return undefined;
  const kinds = NODE_KINDS.join(', ');
  if (!NODE_KINDS.includes(k as NodeKind)) throw new UsageError(t(`--kind must be ${kinds}`, `--kind debe ser ${kinds}`));
  return k as NodeKind;
}

/** `--from <nodo> [--why "…"]`, repetible: cada `--why` va con el `--from` que tiene justo antes (#90). */
function originsArg(args: ParsedArgs): OriginInput[] {
  const out: OriginInput[] = [];
  for (const [k, v] of args.seq) {
    if (k === 'from') {
      out.push({ from: nodeId(v) });
      continue;
    }
    if (k !== 'why') continue;
    const last = out[out.length - 1];
    if (!last || last.why !== undefined) throw new UsageError(t('each --why goes right after its --from', 'cada --why va justo después de su --from'));
    const why = v.trim();
    if ([...why].length > LIMITS.originWhy) throw new UsageError(t(`--why is at most ${LIMITS.originWhy} characters`, `--why va hasta ${LIMITS.originWhy} caracteres`));
    if (why) last.why = why;
  }
  return out;
}

function statusArg(s: string): NodeStatus {
  if (s === 'blocked') throw new UsageError(t('blocked is not set by hand: «dagyard block» sets it', 'blocked no se pone a mano: lo pone «dagyard block»'));
  if (!NODE_STATUSES.includes(s as NodeStatus)) throw new UsageError(t(`--status must be ${MANUAL_STATUSES}`, `--status debe ser ${MANUAL_STATUSES}`));
  return s as NodeStatus;
}

const MANUAL_STATUSES = NODE_STATUSES.filter((s) => s !== 'blocked').join(', ');

export function progressArg(raw: string): number {
  const pct = raw.trim().endsWith('%');
  let n = Number(raw.trim().replace(/%$/, ''));
  if (!Number.isFinite(n)) throw new UsageError(t(`invalid progress: «${raw}»`, `avance inválido: «${raw}»`));
  if (pct || n > 1) n /= 100;
  if (n < 0 || n > 1) throw new UsageError(t(`progress goes from 0 to 1 (or 0% to 100%): «${raw}»`, `el avance va de 0 a 1 (o de 0% a 100%): «${raw}»`));
  return Math.round(n * 1000) / 1000;
}

/**
 * El link del cielo: `<url>/?p=<proyecto>` y, con tarea, `&n=<tarea>` (la web abre el proyecto, vuela a la
 * tarea y abre su ficha). Nunca lleva la clave.
 */
export function skyLink(base: string, projectId: string, node?: string): string {
  const p = `?p=${encodeURIComponent(projectId)}`;
  return `${base.replace(/\/+$/, '')}/${p}${node ? `&n=${encodeURIComponent(node)}` : ''}`;
}

/** Una sola línea física que empieza con `/goal `. */
export function goalLine(raw: string): string {
  const line = oneLine(raw, 10_000);
  return line.startsWith('/goal ') ? line : `/goal ${line.replace(/^\/goal\b\s*/, '')}`;
}

function formatResolution(r: BlockerWaitResult): string {
  const res = r.blocker.resolution;
  const first = r.blocker.kind === 'access' ? (r.value ?? '') : (res?.choice ?? '');
  return `${first}\n${res?.note ? `${t('note', 'nota')}: ${oneLine(res.note, 10_000)}\n` : ''}`;
}

/** El idioma del proyecto que se va a reemplazar; null si no existe (será uno nuevo). */
async function existingProjectLang(api: DagyardClient, pid: string): Promise<Lang | null> {
  try {
    return projectLang((await api.snapshot(pid)).project);
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

function formatImport(r: ImportResult, dry: boolean, replace: boolean): string {
  const s = r.stats;
  const how = s.stageSource === 'phase' ? t('by phase', 'por fase') : t('by depth', 'por profundidad');
  const done = replace ? t(' — replaced', ' — reemplazado') : t(' — imported', ' — importado');
  const st = s.status;
  const lines = [
    t(
      `Project «${r.graph.name}» (${r.projectId})${dry ? ' — dry run, nothing was sent' : done}`,
      `Proyecto «${r.graph.name}» (${r.projectId})${dry ? ' — simulación, no se envió nada' : done}`,
    ),
    [
      plural(s.nodes, ['task', 'tasks'], ['nodo', 'nodos']),
      plural(s.edges, ['dependency', 'dependencies'], ['arista', 'aristas']),
      `${plural(s.stages.length, ['stage', 'stages'], ['etapa', 'etapas'])} (${how})`,
    ].join(' · '),
    ...s.stages.map((stage) => `  ${stage.name}: ${stage.nodes}`),
    // desde #35 el import nunca manda `blocked`: «te esperan» siempre daba 0 (#38); se cuentan los avisos
    [
      t(
        `Status: ${st.pending} pending · ${st.working} in progress · ${st.done} done`,
        `Estados: ${st.pending} pendientes · ${st.working} en progreso · ${st.done} listas`,
      ),
      ...(s.asksHuman
        ? [
            s.asksHuman === 1
              ? t('1 asks a person for something', '1 pide algo a una persona')
              : t(`${s.asksHuman} ask a person for something`, `${s.asksHuman} piden algo a una persona`),
          ]
        : []),
    ].join(' · '),
  ];
  if (s.titled !== undefined) lines.push(t(`Titles from --titles: ${s.titled} of ${s.nodes}`, `Títulos de --titles: ${s.titled} de ${s.nodes}`));
  if (r.warnings.length) {
    lines.push(t(`Warnings (${r.warnings.length}):`, `Avisos (${r.warnings.length}):`), ...r.warnings.map((w) => `  - ${w}`));
  }
  return `${lines.join('\n')}\n`;
}

function globalHelp(): string {
  const rows = Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(14)} ${tx(c.summary)}`);
  return t(
    `dagyard ${VERSION} — the factory's plan as a live DAG

Usage: dagyard <command> [options]

Commands:
${rows.join('\n')}
  start | progress | done   shortcuts for node start | node progress | node done

${tx(HELP_GLOBAL)}
`,
    `dagyard ${VERSION} — el plan de la fábrica como un DAG vivo

Uso: dagyard <comando> [opciones]

Comandos:
${rows.join('\n')}
  start | progress | done   atajos de node start | node progress | node done

${tx(HELP_GLOBAL)}
`,
  );
}

function groupHelp(group: string): string {
  const rows = Object.entries(COMMANDS)
    .filter(([name]) => name.startsWith(`${group} `))
    .map(([, c]) => `  ${tx(c.usage)}\n      ${tx(c.summary)}`);
  return `${t('Usage', 'Uso')}:\n${rows.join('\n')}\n\n${tx(HELP_GLOBAL)}\n`;
}

function commandHelp(c: Command): string {
  const summary = tx(c.summary);
  return `${t('Usage', 'Uso')}: ${tx(c.usage)}\n\n${summary.charAt(0).toUpperCase()}${summary.slice(1)}.\n${tx(c.help)}\n\n${tx(HELP_GLOBAL)}\n`;
}
