/**
 * Router del Worker: auth, forma del body (`@dagyard/model`) y lecturas. Toda escritura que depende
 * del estado (ids, ciclos, bloqueantes, estado de la tarea) se valida y escribe dentro del Store en
 * una sola transacción: ver writes.ts.
 */
import {
  countNodes,
  isSlug,
  LIMITS,
  nextStartable,
  parseBlockerInput,
  parseCloseInput,
  parseEdgeInput,
  parseMessageInput,
  parseNodeInput,
  parseNodePatch,
  parseProjectGraphInput,
  parseProjectInput,
  parseResolveInput,
  parseTeamPatch,
  slugify,
  type BlockerWaitResult,
  type DagNode,
  type Parsed,
  type ProjectSummary,
} from '@dagyard/model';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  SESSION_COOKIE,
  SESSION_TTL_S,
  authenticate,
  type Auth,
  closeAllSessions,
  closeSession,
  offeredProtocols,
  openSession,
  originAllowed,
  requireOwner,
  roleOfToken,
  WS_PROTOCOL,
} from './auth.js';
import { hmac, seal, unseal } from './crypto.js';
import { db as dbOf } from './db.js';
import type { AppEnv } from './env.js';
import { ApiFailure, errorResponse, fail, notFound } from './http.js';
import { toBlocker, toProject } from './rows.js';
import { eventsSince, getBlockerRow, loadGraph, requireProject, snapshot, unavailableFailure, write } from './store.js';
import type { WriteOp, WriteValues } from './writes.js';

type C = Context<AppEnv>;

export const app = new Hono<AppEnv>();

const ok = <T>(p: Parsed<T>): T => (p.ok ? p.value : fail('invalid', p.message));

async function body(c: C): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return fail('invalid', 'el body no es JSON válido');
  }
}

const room = (c: C, pid: string) => c.env.PROJECT_ROOM.get(c.env.PROJECT_ROOM.idFromName(pid));
/** AAD del valor de un acceso: lo amarra a su proyecto y su bloqueante. */
const accessAad = (pid: string, bid: string) => `${pid}/${bid}`;

/** Una escritura con la clave de idempotencia del pedido, si trae (ver el middleware de `Idempotency-Key`). */
const run = <K extends WriteOp['kind']>(c: C, op: Extract<WriteOp, { kind: K }>): Promise<WriteValues[K]> => write(c.env, op, c.get('idem'));

function pidParam(c: C): string {
  const pid = c.req.param('pid')!;
  return isSlug(pid) ? pid : notFound(`El proyecto «${pid}»`);
}

/* ------------------------------------------------------------------ errores y auth */

app.onError((err, c) => {
  if (err instanceof ApiFailure) return errorResponse(err.code, err.message, undefined, err.reason);
  // un deploy reinició un Durable Object en medio de una lectura (o está sobrecargado): no es un error nuestro
  const unavailable = unavailableFailure(err);
  if (unavailable) return errorResponse(unavailable.code, unavailable.message);
  console.error(JSON.stringify({ msg: 'error no controlado', path: c.req.path, err: String(err), stack: (err as Error).stack }));
  return errorResponse('internal', 'Algo falló de nuestro lado. Inténtalo de nuevo.');
});

app.notFound((c) => (c.req.path.startsWith('/api/') ? errorResponse('not_found', 'Esa ruta no existe') : c.env.ASSETS.fetch(c.req.raw)));

app.get('/api/health', (c) => c.json({ ok: true, version: c.env.VERSION || 'dev' }));

app.post('/api/session', async (c) => {
  const b = (await body(c)) as { token?: unknown } | null;
  const role = typeof b?.token === 'string' ? await roleOfToken(c.env, b.token.trim()) : null;
  if (role !== 'owner') return errorResponse('unauthorized', 'Ese token no es válido');
  setCookie(c, SESSION_COOKIE, await openSession(c.env), {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_S,
  });
  return c.body(null, 204);
});

/**
 * La cookie la manda el navegador solo, también desde un sitio hermano (`*.workers.dev` es el mismo
 * «sitio»). El WebSocket con cookie exige un Origin permitido; una escritura con cookie y un Origin ajeno
 * se rechaza (sin Origin pasa: un navegador siempre lo manda en una petición entre orígenes).
 */
function foreignOrigin(c: C, auth: Auth, live: boolean): boolean {
  if (auth.via !== 'cookie') return false;
  const origin = c.req.header('origin');
  if (!live && (c.req.method === 'GET' || c.req.method === 'HEAD' || origin === undefined)) return false;
  return !originAllowed(c.env, c.req.url, origin);
}

const FOREIGN = 'Ese origen no puede usar la sesión del navegador';

/** Cierra la sesión de esta cookie en el servidor; con `?all=1`, todas (exige credencial de dueño). */
app.delete('/api/session', async (c) => {
  if (c.req.query('all') === '1') {
    const auth = await authenticate(c);
    if (!auth) return errorResponse('unauthorized', 'Falta una credencial válida');
    if (foreignOrigin(c, auth, false)) return errorResponse('forbidden', FOREIGN);
    if (auth.role !== 'owner') return errorResponse('forbidden', 'Cerrar todas las sesiones es solo del dueño');
    await closeAllSessions(c.env);
  } else {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) await closeSession(c.env, cookie);
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
  return c.body(null, 204);
});

app.use('/api/*', async (c, next) => {
  const live = /^\/api\/projects\/[^/]+\/live$/.test(c.req.path);
  const auth = await authenticate(c, { websocket: live });
  if (!auth) return errorResponse('unauthorized', 'Falta una credencial válida');
  if (foreignOrigin(c, auth, live)) return errorResponse('forbidden', FOREIGN);
  c.set('role', auth.role);
  c.set('via', auth.via);
  if (auth.session) c.set('session', auth.session);
  await next();
});

/**
 * `Idempotency-Key` (opcional, en cualquier escritura): el CLI manda una por invocación y la repite en cada
 * reintento; la misma clave en el mismo proyecto devuelve lo de la primera vez sin volver a escribir. La
 * huella es un HMAC del pedido crudo (método, ruta y cuerpo, antes de parsearlo): no cambia entre versiones
 * del Worker y no guarda en claro el valor de un acceso.
 */
app.use('/api/*', async (c, next) => {
  const key = c.req.header('idempotency-key');
  if (key !== undefined && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    if (!/^[\x21-\x7e]{1,200}$/.test(key)) fail('invalid', 'Idempotency-Key: de 1 a 200 caracteres visibles (p. ej. un uuid)');
    const url = new URL(c.req.url);
    // `text()` queda en caché: el `json()` de la ruta parsea estos mismos bytes
    const fp = await hmac(c.env.VAULT_KEY, `dagyard-idem-v1\n${c.req.method}\n${url.pathname}${url.search}\n${await c.req.text()}`);
    c.set('idem', { key, fp });
  }
  await next();
});

app.get('/api/me', (c) => c.json({ role: c.get('role') }));

/* ------------------------------------------------------------------ proyectos */

app.get('/api/projects', async (c) => {
  const db = dbOf(c.env);
  const [p, n, b] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT * FROM projects ORDER BY updated_at DESC'),
    // solo las tareas: un goal, un request o un stream no se cuenta (#90)
    db.prepare("SELECT project_id, status, COUNT(*) AS n FROM nodes WHERE kind = 'task' GROUP BY project_id, status"),
    db.prepare("SELECT project_id, COUNT(*) AS n FROM blockers WHERE status = 'open' GROUP BY project_id"),
  ]);
  const projects: ProjectSummary[] = p!.results.map((r) => {
    const pr = toProject(r);
    const statuses = n!.results
      .filter((x) => x.project_id === pr.id)
      .flatMap((x) => Array.from({ length: Number(x.n) }, () => ({ status: x.status as DagNode['status'] })));
    return {
      id: pr.id,
      name: pr.name,
      stages: pr.stages,
      counts: countNodes(statuses),
      openBlockers: Number(b!.results.find((x) => x.project_id === pr.id)?.n ?? 0),
      updatedAt: pr.updatedAt,
    };
  });
  return c.json({ projects });
});

app.post('/api/projects', async (c) => {
  const input = ok(parseProjectInput(await body(c)));
  const project = await run(c, {
    kind: 'createProject',
    pid: input.id ?? slugify(input.name),
    name: input.name,
    ...(input.lang && { lang: input.lang }),
    stages: input.stages,
  });
  return c.json(project, 201);
});

app.get('/api/projects/:pid', async (c) => c.json(await snapshot(dbOf(c.env), pidParam(c))));

app.put('/api/projects/:pid', async (c) => {
  const pid = pidParam(c);
  const graph = ok(parseProjectGraphInput(await body(c)));
  // `If-None-Match: *` = creación exclusiva: el «¿ya existe?» se decide en la misma transacción que escribe
  const exclusive = c.req.header('if-none-match')?.trim() === '*';
  await run(c, { kind: 'replaceGraph', pid, graph, actor: c.get('role'), exclusive });
  return c.json(await snapshot(dbOf(c.env), pid));
});

app.patch('/api/projects/:pid', async (c) => {
  const pid = pidParam(c);
  const b = await body(c);
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return fail('invalid', 'body: se esperaba un objeto');
  const extra = Object.keys(b).filter((k) => k !== 'name' && k !== 'lang' && k !== 'stages');
  if (extra.length) fail('invalid', `campos no editables: ${extra.join(', ')}`);
  const o = b as { name?: unknown; lang?: unknown; stages?: unknown };
  if (o.name === undefined && o.lang === undefined && o.stages === undefined) fail('invalid', 'nada que actualizar');
  // reusa el parser de proyecto; el nombre de relleno solo sirve para validar las etapas y el idioma
  const input = ok(
    parseProjectInput({ name: o.name ?? 'x', ...(o.lang !== undefined && { lang: o.lang }), ...(o.stages !== undefined && { stages: o.stages }) }),
  );
  const project = await run(c, {
    kind: 'patchProject',
    pid,
    ...(o.name !== undefined && { name: input.name }),
    ...(input.lang && { lang: input.lang }),
    ...(input.stages && { stages: input.stages }),
    actor: c.get('role'),
  });
  return c.json(project);
});

app.delete('/api/projects/:pid', async (c) => {
  requireOwner(c, 'Borrar un proyecto');
  const pid = pidParam(c);
  // Primero el room: si falla (un deploy lo reinicia), el borrado no quedó y reintentar lo hace entero.
  await room(c, pid).reset();
  try {
    await run(c, { kind: 'deleteProject', pid });
  } finally {
    // Una página que se reconectó entre el reset y el borrado (también si el borrado quedó pero respondió
    // `uncertain`). Si este segundo aviso se pierde, el room se corrige solo: el proyecto recreado es otra
    // encarnación (su `created_at`) y cierra las páginas del muerto (#67).
    await room(c, pid)
      .reset()
      .catch((err) => console.error(JSON.stringify({ msg: 'reset tras borrar falló', pid, err: String(err) })));
  }
  return c.body(null, 204);
});

app.get('/api/projects/:pid/next', async (c) => {
  const { project, nodes, edges } = await loadGraph(dbOf(c.env), pidParam(c));
  return c.json(nextStartable(project.stages, nodes, edges));
});

app.get('/api/projects/:pid/events', async (c) => {
  const pid = pidParam(c);
  await requireProject(dbOf(c.env), pid);
  const raw = c.req.query('since') ?? '0';
  if (!/^\d+$/.test(raw)) fail('invalid', 'since: un número entero ≥ 0');
  const { events, resync } = await eventsSince(dbOf(c.env), pid, Number(raw), 500);
  // bajo el piso (la demo poda su log al re-sembrar, #74): nada de replay con hueco, vuelve a pedir el snapshot
  return c.json(resync ? { events, resync } : { events });
});

/* ------------------------------------------------------------------ nodos y aristas */

app.post('/api/projects/:pid/nodes', async (c) => {
  const pid = pidParam(c);
  const input = ok(parseNodeInput(await body(c)));
  return c.json(await run(c, { kind: 'addNode', pid, input, actor: c.get('role') }), 201);
});

app.patch('/api/projects/:pid/nodes/:nid', async (c) => {
  const pid = pidParam(c);
  const patch = ok(parseNodePatch(await body(c)));
  return c.json(await run(c, { kind: 'patchNode', pid, nid: c.req.param('nid'), patch, actor: c.get('role') }));
});

/** Cierra con motivo (#90): lista, reemplazada, descartada o «aprendimos». Emite `node.updated`. */
app.post('/api/projects/:pid/nodes/:nid/close', async (c) => {
  const pid = pidParam(c);
  const input = ok(parseCloseInput(await body(c)));
  return c.json(await run(c, { kind: 'closeNode', pid, nid: c.req.param('nid'), input, actor: c.get('role') }));
});

/**
 * Descartar (#90): cierra como `dropped` con el motivo opcional de `?why=`. Nunca borra la fila. Solo el dueño: la
 * fábrica descarta cerrando con motivo (`close`).
 */
app.delete('/api/projects/:pid/nodes/:nid', async (c) => {
  requireOwner(c, 'Descartar una tarea');
  const pid = pidParam(c);
  const why = c.req.query('why')?.trim() || null;
  if (why && [...why].length > LIMITS.closedReason) fail('invalid', `why: máximo ${LIMITS.closedReason} caracteres`);
  const node = await run(c, { kind: 'closeNode', pid, nid: c.req.param('nid'), input: { as: 'dropped', why }, actor: c.get('role'), whyOptional: true });
  return c.json(node);
});

/** `{from, to, kind?, why?}`: sin `kind`, «necesita»; `kind: 'origin'` = «nació de» (#90). */
app.post('/api/projects/:pid/edges', async (c) => {
  const pid = pidParam(c);
  const e = ok(parseEdgeInput(await body(c)));
  return c.json(await run(c, { kind: 'addEdge', pid, from: e.from, to: e.to, edgeKind: e.kind ?? 'requires', why: e.why ?? null, actor: c.get('role') }), 201);
});

/** `?from&to[&kind=origin]`. Quitar un «nació de» es solo del dueño: es el porqué (#90). */
app.delete('/api/projects/:pid/edges', async (c) => {
  const pid = pidParam(c);
  const from = c.req.query('from');
  const to = c.req.query('to');
  const kind = c.req.query('kind') ?? 'requires';
  if (!isSlug(from) || !isSlug(to)) return fail('invalid', 'from y to: ids de tareas');
  if (kind !== 'requires' && kind !== 'origin') return fail('invalid', 'kind: requires u origin');
  if (kind === 'origin') requireOwner(c, 'Quitar un «nació de»');
  await run(c, { kind: 'removeEdge', pid, from, to, edgeKind: kind, actor: c.get('role') });
  return c.body(null, 204);
});

/* ------------------------------------------------------------------ equipos de la fábrica (#75) */

/** Upsert parcial de un equipo (un sitio de `/factory`); sin cambios no escribe ni emite `team.updated`. */
app.put('/api/projects/:pid/teams/:tid', async (c) => {
  const pid = pidParam(c);
  const tid = c.req.param('tid');
  if (!isSlug(tid)) return fail('invalid', `tid: el slug del sitio, minúsculas, números y guiones (máx. 64): «${tid}»`);
  const patch = ok(parseTeamPatch(await body(c)));
  return c.json(await run(c, { kind: 'putTeam', pid, tid, patch, actor: c.get('role') }));
});

/* ------------------------------------------------------------------ bloqueantes */

app.post('/api/projects/:pid/nodes/:nid/blockers', async (c) => {
  const pid = pidParam(c);
  const input = ok(parseBlockerInput(await body(c)));
  return c.json(await run(c, { kind: 'openBlocker', pid, nid: c.req.param('nid'), input, actor: c.get('role') }), 201);
});

async function requireBlockerRow(c: C, pid: string) {
  const bid = c.req.param('bid')!;
  return (await getBlockerRow(dbOf(c.env), pid, bid)) ?? notFound(`El bloqueante «${bid}»`);
}

app.get('/api/projects/:pid/blockers/:bid', async (c) => c.json(toBlocker(await requireBlockerRow(c, pidParam(c)))));

app.post('/api/projects/:pid/blockers/:bid/resolve', async (c) => {
  requireOwner(c, 'Resolver un bloqueante');
  const pid = pidParam(c);
  // kind y opciones no cambian nunca: sirven para validar el body fuera de la transacción
  const prev = toBlocker(await requireBlockerRow(c, pid));
  // con clave, el reintento de una resolución que ya quedó lo responde el Store con lo guardado
  if (prev.status === 'resolved' && !c.get('idem')) fail('conflict', 'Ese bloqueante ya está resuelto');
  const r = ok(parseResolveInput(await body(c), prev));
  // cifrar es async, así que va antes; la verificación de que sigue abierto va dentro de la transacción
  const sealed = r.value !== null ? await seal(c.env.VAULT_KEY, r.value, accessAad(pid, prev.id)) : null;
  const blocker = await run(c, { kind: 'resolveBlocker', pid, bid: prev.id, expectKind: prev.kind, choice: r.choice, note: r.note, sealed });
  return c.json(blocker);
});

app.get('/api/projects/:pid/blockers/:bid/wait', async (c) => {
  const pid = pidParam(c);
  const raw = c.req.query('timeout');
  if (raw !== undefined && !/^\d+(\.\d+)?$/.test(raw)) fail('invalid', 'timeout: segundos, entre 0 y 25');
  const timeout = Math.min(25, raw === undefined ? 25 : Number(raw));
  const deadline = Date.now() + timeout * 1000;
  let row = await requireBlockerRow(c, pid);
  while (row.status === 'open' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(500, Math.max(0, deadline - Date.now()))));
    row = await requireBlockerRow(c, pid);
  }
  const blocker = toBlocker(row);
  const canSee = blocker.kind === 'access' && blocker.status === 'resolved' && c.get('role') === 'agent' && !!row.access_value;
  const value = canSee ? await unseal(c.env.VAULT_KEY, row.access_value as string, accessAad(pid, blocker.id)) : null;
  const result: BlockerWaitResult = { blocker, value };
  return c.json(result);
});

/* ------------------------------------------------------------------ mensajes */

app.post('/api/projects/:pid/nodes/:nid/messages', async (c) => {
  const pid = pidParam(c);
  const input = ok(parseMessageInput(await body(c)));
  return c.json(await run(c, { kind: 'postMessage', pid, nid: c.req.param('nid'), input, actor: c.get('role') }), 201);
});

/* ------------------------------------------------------------------ tiempo real */

app.get('/api/projects/:pid/live', async (c) => {
  const pid = pidParam(c);
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return fail('invalid', 'Esta ruta espera un WebSocket (Upgrade: websocket)');
  await requireProject(dbOf(c.env), pid);
  const since = c.req.query('since');
  const headers = new Headers(c.req.raw.headers);
  headers.set('x-dagyard-project', pid);
  headers.delete('x-dagyard-since');
  if (since !== undefined) headers.set('x-dagyard-since', since);
  // hash de la sesión del navegador: el DO revalida el socket en cada evento (nunca viene del cliente)
  headers.delete('x-dagyard-session');
  const session = c.get('session');
  if (session) headers.set('x-dagyard-session', session);
  // el subprotocolo que responde el 101 lo elige el Worker: `dagyard` si se ofreció; si no, el `token.<k>` que
  // autenticó (sin elegir uno, el cliente corta). El DO lo devuelve tal cual (nunca viene del cliente).
  const offered = offeredProtocols(headers.get('sec-websocket-protocol') ?? undefined);
  const chosen = offered.includes(WS_PROTOCOL) ? WS_PROTOCOL : c.get('via') === 'protocol' ? offered.find((p) => p.startsWith('token.')) : undefined;
  headers.delete('x-dagyard-protocol');
  if (chosen) headers.set('x-dagyard-protocol', chosen);
  // el token del subprotocolo no viaja más allá de la auth
  if (offered.length) headers.set('sec-websocket-protocol', offered.filter((p) => !p.startsWith('token.')).join(', '));
  return room(c, pid).fetch(new Request(c.req.raw.url, { headers }));
});
