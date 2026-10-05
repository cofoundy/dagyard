/**
 * `dagyard sync --github`: la cola de issues → nodos `gh-<n>`, con la API granular (nunca `PUT`): cada
 * cambio es un evento en vivo y el resto del grafo no se toca.
 *
 * Reglas (diseño #45, T-2):
 * - Nodo existente: nunca cambia título, etapa, equipo ni goal (los cura la fábrica); `link` solo si está vacío.
 * - Nodo nuevo: solo issues abiertos (con `all` también los cerrados como completados, ya Listos).
 * - El estado solo avanza: cerrado (completado) → `done`; abierto con un PR abierto que lo cierra y nodo
 *   `pending` → `working`. Con un bloqueante abierto el servidor responde 409: aviso, no error.
 * - La etiqueta `epic` no crea nodo; si ya existe, se sincroniza normal.
 * - Un nodo cuyo `link` es de otro issue (otro repo con el mismo número) se salta con aviso (#50).
 * - Completado = `state_reason` `completed` o null; `not_planned` y `duplicate` no cuentan (#50).
 * - Aristas solo si ambos nodos existen; nunca borra. «Parte de #n» y «depende de #n» son «necesita»; «sale de la
 *   revisión de #n», «nace de #n» o «born from #n», «nació de» desde `gh-n` (#90). `founder-input` → bloqueante `decision`, solo si el
 *   nodo no tiene ninguna decisión (abierta o resuelta, con cualquier texto: contrato #31).
 * - Nunca crea etapas: la de `--stage` (o la de construcción) se reconoce por id o nombre en cualquier idioma, y
 *   las opciones por defecto van en el idioma del proyecto, no en el de `LANG` (#77).
 */
import type { Blocker, BlockerInput, DagNode, Edge, NodeInput, NodePatch, NodeStatus, Stage } from '@dagyard/model';
import { LIMITS, projectLang, wouldCreateCycle, type Lang } from '@dagyard/model';
import { ApiRequestError, type DagyardClient } from '../api.js';
import { UsageError } from '../args.js';
import { defaultSyncStage, findStage, YES_NO } from '../defaults.js';
import { t } from '../i18n.js';
import { oneLine } from '../tasks/parse.js';
import { cleanTitle, closingRefs, dependencyRefs, issueNodeTitle, parseOptions, type GhIssue, type GithubSource } from './github.js';

export type SyncApi = Pick<DagyardClient, 'snapshot' | 'addNode' | 'updateNode' | 'addEdge' | 'openBlocker'>;

export interface SyncOptions {
  repo: string;
  label?: string;
  /** etapa de los nodos nuevos (id o nombre, en cualquier idioma); default la de construcción si existe, si no la primera */
  stage?: string;
  /** también crea los issues cerrados como completados */
  all?: boolean;
  dryRun?: boolean;
}

export interface SyncReport {
  repo: string;
  project: string;
  dryRun: boolean;
  /** issues que mapean a un nodo (nuevo o existente) */
  issues: number;
  created: string[];
  updated: string[];
  unchanged: string[];
  /** en humano: lo que se hizo, en orden */
  actions: string[];
  warnings: string[];
}

export const FOUNDER_LABEL = 'founder-input';
/** Una épica no es una tarea: no se crea (si ya existe como nodo, se sincroniza como cualquier otro). */
export const EPIC_LABEL = 'epic';
const RANK: Record<NodeStatus, number> = { pending: 0, working: 1, blocked: 1, done: 2 };
/** Los estados con las palabras de la web (glosario de #73). */
const STATUS_EN: Record<NodeStatus, string> = { pending: 'Pending', working: 'In progress', blocked: 'Needs you', done: 'Done' };
const STATUS_ES: Record<NodeStatus, string> = { pending: 'Pendiente', working: 'En progreso', blocked: 'Te espera', done: 'Lista' };
const statusHuman = (s: NodeStatus) => t(STATUS_EN[s], STATUS_ES[s]);

export const nodeIdOf = (n: number) => `gh-${n}`;

export async function syncGithub(api: SyncApi, source: GithubSource, projectId: string, opts: SyncOptions): Promise<SyncReport> {
  const dry = !!opts.dryRun;
  const snap = await api.snapshot(projectId);
  const lang = projectLang(snap.project);
  const stage = pickStage(snap.project.stages, opts.stage, lang);

  const listed = await source.issues(opts.repo, opts.label ? { label: opts.label } : {});
  const issues = listed.filter((i) => !i.isPull).sort((a, b) => a.number - b.number);
  const withPr = new Set<number>();
  for (const pr of await source.openPulls(opts.repo)) for (const n of closingRefs(`${pr.title}\n${pr.body}`)) withPr.add(n);

  const nodes = new Map<string, Pick<DagNode, 'id' | 'status' | 'link'>>(snap.nodes.map((n) => [n.id, n]));
  const edges: Array<Pick<Edge, 'from' | 'to'>> = snap.edges.map((e) => ({ from: e.from, to: e.to }));
  // «nació de» (#90); un servidor previo no trae `origins`
  const origins: Array<Pick<Edge, 'from' | 'to'>> = (snap.origins ?? []).map((o) => ({ from: o.from, to: o.to }));
  const report: SyncReport = {
    repo: opts.repo,
    project: projectId,
    dryRun: dry,
    issues: 0,
    created: [],
    updated: [],
    unchanged: [],
    actions: [],
    warnings: [],
  };
  const created = new Set<string>();
  /** nodos `gh-<n>` que son de otro issue (otro repo con el mismo número): no se tocan ni se enlazan */
  const foreign = new Set<string>();
  const updated = new Set<string>();
  const considered: GhIssue[] = [];

  /** 400/404/409 de una escritura → aviso; lo demás (auth, red, 5xx) corta el sync. */
  const soft = async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ApiRequestError && [400, 404, 409].includes(err.status)) {
        report.warnings.push(`${what}: ${err.message}`);
        return undefined;
      }
      throw err;
    }
  };

  // 1 · nodos: crear o avanzar
  for (const issue of issues) {
    const id = nodeIdOf(issue.number);
    const existing = nodes.get(id);
    // completado = `completed` o null (issues viejos); `not_planned` y `duplicate` no cuentan
    const completed = issue.state === 'closed' && (issue.stateReason === 'completed' || issue.stateReason === null);
    if (!existing) {
      if (issue.state === 'closed' && (!opts.all || !completed)) continue;
      if (issue.labels.includes(EPIC_LABEL)) continue;
      const input: NodeInput = {
        id,
        stage,
        title: issueNodeTitle(issue.title, issue.number),
        status: completed ? 'done' : withPr.has(issue.number) ? 'working' : 'pending',
        link: issue.url,
      };
      considered.push(issue);
      const ok = dry || (await soft(t(`could not create ${id}`, `no pude crear ${id}`), () => api.addNode(projectId, input))) !== undefined;
      if (!ok) continue;
      nodes.set(id, { id, status: input.status!, link: input.link! });
      created.add(id);
      report.actions.push(t(`new ${id} «${input.title}» (${statusHuman(input.status!)})`, `nuevo ${id} «${input.title}» (${statusHuman(input.status!)})`));
      continue;
    }
    if (existing.link && linkClash(existing.link, issue, opts.repo)) {
      foreign.add(id);
      report.warnings.push(
        t(
          `${id} points to ${existing.link}, not to ${issue.url}: skipped it (another repo with the same number?)`,
          `${id} apunta a ${existing.link}, no a ${issue.url}: lo salté (¿otro repo con el mismo número?)`,
        ),
      );
      continue;
    }
    considered.push(issue);
    const patch: NodePatch = {};
    if (!existing.link && issue.url) patch.link = issue.url;
    const want: NodeStatus | null = completed ? 'done' : issue.state === 'open' && withPr.has(issue.number) ? 'working' : null;
    if (want && RANK[want] > RANK[existing.status]) {
      if (existing.status === 'blocked' || hasOpenBlocker(snap.blockers, id)) {
        report.warnings.push(openQuestion(id, want));
      } else {
        patch.status = want;
      }
    }
    if (!Object.keys(patch).length) continue;
    let applied: NodePatch = patch;
    if (!dry) {
      try {
        await api.updateNode(projectId, id, patch);
      } catch (err) {
        if (!(err instanceof ApiRequestError) || ![400, 404, 409].includes(err.status)) throw err;
        if (err.status !== 409 || !patch.status) {
          report.warnings.push(t(`could not update ${id}: ${err.message}`, `no pude actualizar ${id}: ${err.message}`));
          continue;
        }
        // 409 al cambiar el estado: tiene un bloqueante abierto. Aviso, y el resto del cambio sí entra
        report.warnings.push(openQuestion(id, patch.status));
        const { status: _skip, ...rest } = patch;
        applied = rest;
        if (!Object.keys(rest).length) continue;
        if ((await soft(t(`could not update ${id}`, `no pude actualizar ${id}`), () => api.updateNode(projectId, id, rest))) === undefined) continue;
      }
    }
    nodes.set(id, { ...existing, ...(applied.link ? { link: applied.link } : {}), ...(applied.status ? { status: applied.status } : {}) });
    updated.add(id);
    const what = [applied.status ? statusHuman(applied.status) : null, applied.link ? t('link to the issue', 'enlace al issue') : null].filter(Boolean);
    report.actions.push(`${id}: ${what.join(', ')}`);
  }

  // 2 · aristas (solo entre nodos que existen; nunca borra)
  for (const issue of considered) {
    const self = nodeIdOf(issue.number);
    if (!nodes.has(self)) continue;
    const refs = dependencyRefs(issue.body);
    const wanted: Array<[string, string]> = [
      ...refs.partOf.map((n): [string, string] => [self, nodeIdOf(n)]), // la épica necesita sus partes
      ...refs.dependsOn.map((n): [string, string] => [nodeIdOf(n), self]),
    ];
    for (const [from, to] of wanted) {
      if (from === to || !nodes.has(from) || !nodes.has(to) || foreign.has(from) || foreign.has(to)) continue;
      if (edges.some((e) => e.from === from && e.to === to)) continue;
      if (dry) {
        if (wouldCreateCycle(edges, from, to)) {
          report.warnings.push(cycleWarning(from, to));
          continue;
        }
      } else {
        try {
          await api.addEdge(projectId, from, to);
        } catch (err) {
          if (!(err instanceof ApiRequestError)) throw err;
          if (err.status === 400 && err.code === 'cycle') report.warnings.push(cycleWarning(from, to));
          else if (err.status === 409) report.warnings.push(t(`${from} → ${to} already existed`, `${from} → ${to} ya existía`));
          else if ([400, 404].includes(err.status)) report.warnings.push(t(`did not add ${from} → ${to}: ${err.message}`, `no agregué ${from} → ${to}: ${err.message}`));
          else throw err;
          continue;
        }
      }
      edges.push({ from, to });
      updated.add(self);
      report.actions.push(`${from} → ${to}`);
    }
    // «nació de»: este nodo nació de gh-n
    for (const n of refs.bornFrom) {
      const from = nodeIdOf(n);
      if (from === self || !nodes.has(from) || foreign.has(from) || foreign.has(self)) continue;
      if (origins.some((o) => o.from === from && o.to === self)) continue;
      if (dry) {
        if (wouldCreateCycle(origins, from, self)) {
          report.warnings.push(bornCycleWarning(from, self));
          continue;
        }
      } else {
        try {
          await api.addEdge(projectId, from, self, { kind: 'origin' });
        } catch (err) {
          if (!(err instanceof ApiRequestError)) throw err;
          if (err.status === 400 && err.code === 'cycle') report.warnings.push(bornCycleWarning(from, self));
          else if (err.status === 409) report.warnings.push(t(`${self} was already born from ${from}`, `${self} ya nacía de ${from}`));
          else if ([400, 404].includes(err.status)) report.warnings.push(t(`did not say ${self} was born from ${from}: ${err.message}`, `no dije que ${self} nació de ${from}: ${err.message}`));
          else throw err;
          continue;
        }
      }
      origins.push({ from, to: self });
      updated.add(self);
      report.actions.push(t(`${self} born from ${from}`, `${self} nació de ${from}`));
    }
  }

  // 3 · founder-input → decisión (sin re-preguntar)
  for (const issue of considered) {
    if (issue.state !== 'open' || !issue.labels.includes(FOUNDER_LABEL)) continue;
    const id = nodeIdOf(issue.number);
    const node = nodes.get(id);
    if (!node || node.status === 'done') continue;
    // cualquier decisión previa, abierta o resuelta y con el texto que sea (la fábrica la cura a mano), basta:
    // nunca se re-pregunta (contrato #31)
    if (snap.blockers.some((b) => b.nodeId === id && b.kind === 'decision')) continue;
    const question = oneLine(cleanTitle(issue.title), LIMITS.question);
    const options = parseOptions(issue.body);
    const input: BlockerInput = { kind: 'decision', question, options: options.length ? options : [...YES_NO[lang]] };
    if (!dry && (await soft(t(`could not open the question for ${id}`, `no pude abrir la pregunta de ${id}`), () => api.openBlocker(projectId, id, input))) === undefined) continue;
    nodes.set(id, { ...node, status: 'blocked' });
    updated.add(id);
    report.actions.push(t(`${id}: asks the owner «${question}»`, `${id}: pregunta al dueño «${question}»`));
  }

  report.issues = considered.length;
  for (const issue of considered) {
    const id = nodeIdOf(issue.number);
    if (created.has(id)) report.created.push(id);
    else if (updated.has(id)) report.updated.push(id);
    else report.unchanged.push(id);
  }
  return report;
}

/**
 * El enlace del nodo es de otro issue: fuera de `github.com/<repo>/` o hacia otro número de issue del mismo
 * repo. Un enlace al PR del mismo repo no es choque (el nodo puede enlazar su issue o su PR).
 */
export function linkClash(link: string, issue: Pick<GhIssue, 'number' | 'url'>, repo: string): boolean {
  const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();
  const l = norm(link);
  if (l === norm(issue.url)) return false;
  const base = `https://github.com/${repo.toLowerCase()}/`;
  if (!l.startsWith(base)) return true;
  const m = /^issues\/(\d+)(?:[/?#]|$)/.exec(l.slice(base.length));
  return !!m && Number(m[1]) !== issue.number;
}

function openQuestion(id: string, status: NodeStatus): string {
  return t(
    `${id} has an open question for the owner; did not move it to ${statusHuman(status)}`,
    `${id} tiene una pregunta abierta para el dueño; no lo pasé a ${statusHuman(status)}`,
  );
}

function cycleWarning(from: string, to: string): string {
  return t(`did not add ${from} → ${to}: it would close a loop`, `no agregué ${from} → ${to}: cerraría un ciclo`);
}

function bornCycleWarning(from: string, to: string): string {
  return t(`did not say ${to} was born from ${from}: it would close a loop`, `no dije que ${to} nació de ${from}: cerraría un ciclo`);
}

function hasOpenBlocker(blockers: Blocker[], nodeId: string): boolean {
  return blockers.some((b) => b.nodeId === nodeId && b.status === 'open');
}

function pickStage(stages: Stage[], wanted: string | undefined, lang: Lang): string {
  if (!stages.length) throw new UsageError(t('the project has no stages', 'el proyecto no tiene etapas'));
  if (wanted !== undefined) {
    const hit = findStage(stages, wanted);
    if (!hit) {
      const ids = stages.map((s) => s.id).join(', ');
      throw new UsageError(t(`there is no stage «${wanted}»; the project has: ${ids}`, `no existe la etapa «${wanted}»; las del proyecto: ${ids}`));
    }
    return hit.id;
  }
  return defaultSyncStage(stages, lang)!.id;
}

export function formatSync(r: SyncReport): string {
  const lines = [
    t(
      `Synced ${r.issues} issues: ${r.created.length} new · ${r.updated.length} updated · ${r.unchanged.length} unchanged`,
      `Sincronicé ${r.issues} issues: ${r.created.length} nuevas · ${r.updated.length} actualizadas · ${r.unchanged.length} sin cambios`,
    ),
  ];
  if (r.dryRun) lines.push(t(`This was a dry run: nothing was sent to «${r.project}».`, `Fue una simulación: no se envió nada a «${r.project}».`));
  if (r.warnings.length) lines.push(t(`Warnings (${r.warnings.length}):`, `Avisos (${r.warnings.length}):`), ...r.warnings.map((w) => `  - ${w}`));
  return `${lines.join('\n')}\n`;
}
