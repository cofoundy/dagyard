// Dagyard en Claude Code — una banda sobre el prompt con lo que le toca a esta sesión:
//   · lo que TE ESPERA (bloqueantes abiertos): una decisión o una revisión se resuelven desde aquí;
//     un acceso se da en el cielo (la clave no pasa por la terminal).
//   · lo que está PARA TOMAR (pendiente, sin equipo y con todo lo que necesita ya listo):
//     «Trabajar en esto» la arranca en el servidor y fija su /goal en esta sesión.
//   · el MENÚ (/dagyard o «Ver todo»): todo lo anterior a la vez, en un panel, para responderlo de corrido.
//   · un AVISO (toast) cuando aparece algo nuevo que te espera.
// El proyecto sale del entorno, del .dagyard.json más cercano subiendo desde el cwd, o de
// ~/.config/dagyard; sin ninguno el mod calla (instalado para todas las sesiones, no ensucia otros repos).
// Todo cambio se ve en el cielo (la UI) en tiempo real, porque escribe en la misma API.
// Habla inglés, o español si el entorno lo pide (LC_ALL > LC_MESSAGES > LANG, #73): ver ./i18n.
import type { Register } from 'claude-code'

import { langFromEnv, REQUEST_CHANGES, text } from './i18n'
import type { Strings } from './i18n'

import { skyLink, viewOf } from './view'
import type { Item, Node, Snapshot, View } from './view'

const URL_DEFAULT = 'https://dagyard.cofoundy-dev.workers.dev'
const LINK_FILE = '.dagyard.json'
const POLL_MS = 10_000 // un bloqueante nuevo avisa en ≤20 s aun con la red lenta
const TEAM = 'Claude Code'
const MENU = 'dagyard-menu'

const AMBER = '#ffb547'
const BLUE = '#9fd3ff'
const MUTED = '#6b7a93'

let base = URL_DEFAULT
let project: string | null = null
let seen: Set<string> | null = null // los bloqueantes abiertos ya vistos; null hasta la primera carga
let view: View | null = null
let cursor = 0
let working: Node | null = null
let hidden = false
let busy = false
let lastError = ''
let loading = false
let commenting: string | null = null // la revisión a la que se le está escribiendo «qué cambiarías»
// La opción elegida que espera «Sí, elegir»: resolver no se deshace (el servidor da 409), así que ninguna
// opción lleva hotkey ni se manda de un toque; un dígito en el prompt vacío arma los de la banda (#89).
let picked: { id: string; choice: number } | null = null
// Tomar, terminar o soltar una tarea también escriben (y tomar fija un /goal en la sesión): pasan por la
// misma confirmación, sin hotkey. Medido 2026-10-04 18:32: un «t» suelto tomó gh-89 desde la banda.
type Act = 'take' | 'done' | 'release'
let asking: { act: Act; id: string } | null = null
let s: Strings = text('en') // los textos en el idioma del entorno; se fija en session.start

async function home($: any): Promise<string> {
  const fromEnv = await $.env.get('HOME')
  if (fromEnv) return fromEnv
  const out = await $.process.run(['printenv', 'HOME']).catch(() => null)
  return out?.stdout?.trim() ?? ''
}

async function key($: any, file: string): Promise<string | null> {
  const dir = await home($)
  try {
    return (await $.fs.read(`${dir}/.config/dagyard/${file}`)).trim() || null
  } catch {
    return null
  }
}

/** El .dagyard.json más cercano subiendo desde `cwd` (el que escribe el repo, como el CLI). */
async function linkOf($: any, cwd: string): Promise<{ project?: string; url?: string }> {
  let dir = cwd.replace(/\/+$/, '')
  for (;;) {
    try {
      const raw = JSON.parse(await $.fs.read(`${dir || ''}/${LINK_FILE}`))
      return {
        project: typeof raw?.project === 'string' ? raw.project.trim() || undefined : undefined,
        url: typeof raw?.url === 'string' ? raw.url.trim() || undefined : undefined,
      }
    } catch {
      // no está aquí (o no es JSON): sube
    }
    if (!dir) return {}
    dir = dir.slice(0, dir.lastIndexOf('/'))
  }
}

/** Avisa lo que te espera y no estaba la vez anterior; la primera carga solo toma nota. */
function notice($: any, v: View): void {
  const open = new Set(v.waiting.map(it => (it.kind === 'waiting' ? it.blocker.id : '')))
  const fresh = seen ? v.waiting.filter(it => it.kind === 'waiting' && !seen!.has(it.blocker.id)) : []
  seen = open
  const first = fresh[0]
  if (fresh.length === 1 && first?.kind === 'waiting') {
    const { node, blocker: b } = first
    $.ui.toast(s.needsYou(node.title, b.kind, b.question))
  } else if (fresh.length > 1) {
    $.ui.toast(s.manyNew(fresh.length))
  }
}

/**
 * Esperas base entre intentos ante un `503 unavailable` o un corte de red (≈1,2 s: lo que dura el corte de
 * un deploy), con jitter de ×0,5 a ×1,5. Las mismas que `packages/cli/src/api.ts` (el mod no lo importa:
 * corre con `$.http.fetch`, no se empaqueta).
 */
const RETRY_DELAYS_MS = [300, 900]
const jitter = (ms: number) => Math.round(ms * (0.5 + Math.random()))

/**
 * ¿Repetir es seguro y útil? Un corte de red o un `503` del Worker que no escribió (`unavailable`) o que no
 * llegó al Worker (sin cuerpo de error). `overloaded` (reintentar empeora) y `uncertain` (la escritura pudo
 * quedar sin su clave) no se repiten.
 */
function transient(res: { status: number; text: string } | null): boolean {
  if (!res) return true
  if (res.status !== 503) return false
  try {
    const code = JSON.parse(res.text)?.error?.code
    return !code || code === 'unavailable'
  } catch {
    return true
  }
}

/**
 * Una invocación de la API. Toda escritura lleva una `Idempotency-Key` nueva, la misma en cada reintento:
 * así reintentar un `503 unavailable` o un corte de red (la escritura pudo quedar) nunca la duplica.
 */
async function api($: any, path: string, method: string, body: unknown, owner: boolean): Promise<any> {
  const token = await key($, owner ? 'owner-token' : 'agent-key')
  if (!token) throw new Error(s.missingKey)
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'user-agent': 'dagyard-mod/0.2' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (method !== 'GET' && method !== 'HEAD') headers['idempotency-key'] = crypto.randomUUID()
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
  for (let attempt = 0; ; attempt++) {
    let res: { status: number; ok: boolean; text: string } | null = null
    let cut: unknown = null
    try {
      res = await $.http.fetch(`${base}${path}`, init)
    } catch (err) {
      cut = err
    }
    if (res?.ok) return res.text ? JSON.parse(res.text) : null
    if (!transient(res) || attempt >= RETRY_DELAYS_MS.length) {
      if (res) throw new Error(String(res.status))
      throw cut instanceof Error ? cut : new Error(String(cut))
    }
    await $.clock.sleep(jitter(RETRY_DELAYS_MS[attempt]!))
  }
}

async function refresh($: any): Promise<void> {
  if (!project) return
  loading = true
  try {
    const snap = (await api($, `/api/projects/${project}`, 'GET', undefined, false)) as Snapshot
    view = viewOf(snap)
    notice($, view)
    const p = picked
    if (p && !view.waiting.some(it => it.kind === 'waiting' && it.blocker.id === p.id)) picked = null
    const w = working
    if (w) working = snap.nodes.find(n => n.id === w.id && n.status === 'working') ?? null
    lastError = ''
  } catch (err) {
    view = null
    lastError = (err as Error)?.message ?? String(err)
  }
  loading = false
  $.ui.invalidate('ui.render')
}

async function settle($: any, err: unknown): Promise<void> {
  if (err) $.ui.toast(s.noAnswer((err as Error).message))
  busy = false
  await refresh($)
}

async function resolve($: any, it: Extract<Item, { kind: 'waiting' }>, choice: number, note: string): Promise<void> {
  if (busy) return
  busy = true
  $.ui.invalidate('ui.render')
  let err: unknown = null
  try {
    await api($, `/api/projects/${project}/blockers/${it.blocker.id}/resolve`, 'POST', { choice, note: note || 'Desde Claude Code' }, true)
    commenting = null
    picked = null
    $.ui.toast(s.resolved(it.node.title, it.blocker.options[choice] ?? ''))
  } catch (e) {
    err = e
  }
  await settle($, err)
}

async function take($: any, node: Node): Promise<void> {
  if (busy) return
  busy = true
  $.ui.invalidate('ui.render')
  let err: unknown = null
  try {
    await api($, `/api/projects/${project}/nodes/${node.id}`, 'PATCH', { status: 'working', team: TEAM, progress: 0.05 }, false)
    working = node
    $.ui.toast(s.took(node.title))
  } catch (e) {
    err = e
  }
  await settle($, err)
  if (!err) await $.command.run({ command: 'goal', args: node.goal ?? s.finish(node.title) })
}

async function patchWorking($: any, node: Node, body: unknown, toast: string): Promise<void> {
  if (busy) return
  busy = true
  $.ui.invalidate('ui.render')
  let err: unknown = null
  try {
    await api($, `/api/projects/${project}/nodes/${node.id}`, 'PATCH', body, false)
    working = null
    if (toast) $.ui.toast(toast)
  } catch (e) {
    err = e
  }
  await settle($, err)
}

/** Abre el cielo en el proyecto de este repo y, si se pasa, directo en esa tarea con su ficha. */
async function openSky($: any, node?: string): Promise<void> {
  await $.process.run(['open', skyLink(base, project, node)]).catch(() => undefined)
}

// Primero abre y después carga: el motor coloca el panel a cualquier ancho solo si el clic de la
// persona está detrás; una espera de red antes del open lo vuelve «no pedido» (y bajo 144 columnas espera).
async function openMenu($: any): Promise<void> {
  const opened = await $.ui.open({ id: MENU, title: 'Dagyard', focus: true, closeOnEscape: true })
  if (!opened.isPlaced) $.ui.toast(s.menuDoesNotFit(opened.reason))
  void refresh($)
}

async function comment($: any, blockerId: string | null): Promise<void> {
  commenting = blockerId
  picked = null
  $.ui.invalidate('ui.render')
}

/** Primer paso de tomar, terminar o soltar: pregunta; el segundo es el «Sí, …». `null` cancela. */
async function ask($: any, a: { act: Act; id: string } | null): Promise<void> {
  asking = a
  $.ui.invalidate('ui.render')
}

/** Lo que hace cada acción confirmada sobre su tarea. */
function act($: any, a: Act, node: Node): void {
  asking = null
  if (a === 'take') void take($, node)
  else if (a === 'done') void patchWorking($, node, { status: 'done' }, s.isDone(node.title))
  else void patchWorking($, node, { status: 'pending', team: null, progress: 0 }, '')
}

const question = (a: Act, n: Node) => (a === 'take' ? s.confirmTake(n.title) : a === 'done' ? s.confirmDone(n.title) : s.confirmRelease(n.title))
const yes = (a: Act) => (a === 'take' ? s.yesTake : a === 'done' ? s.yesDone : s.yesRelease)

/** Primer paso de elegir: marca la opción; el segundo es «Sí, elegir». `null` cancela. */
async function pick($: any, choice: { id: string; choice: number } | null): Promise<void> {
  picked = choice
  $.ui.invalidate('ui.render')
}

async function toggleBand($: any): Promise<void> {
  hidden = !hidden
  $.ui.invalidate('ui.render')
}

async function skip($: any): Promise<void> {
  cursor += 1
  picked = null
  asking = null
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const link = await linkOf($, e.cwd)
    base = ((await $.env.get('DAGYARD_URL')) || link.url || (await key($, 'url')) || URL_DEFAULT).replace(/\/+$/, '')
    project = (await $.env.get('DAGYARD_PROJECT')) || link.project || (await key($, 'project')) || null
    s = text(langFromEnv({ LC_ALL: await $.env.get('LC_ALL'), LC_MESSAGES: await $.env.get('LC_MESSAGES'), LANG: await $.env.get('LANG') }))
    view = null
    seen = null
    await $.command.register({ name: 'dagyard', description: s.commandDescription })
    if (project) {
      $.clock.every(POLL_MS, () => void refresh($))
      void refresh($)
    }
    return next(e)
  })

  on('command.run', { command: 'dagyard' }, async $ => {
    if (!project)
      return {
        text: s.notLinked(LINK_FILE),
      }
    await openMenu($)
    const v = view
    return {
      text: v
        ? s.summary(v.project, v.waiting.length, v.startable.length)
        : `${s.noAnswer(lastError || s.noDetail)} · ${base}/api/projects/${project}`,
    }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($)
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const v = view
    if (!project || e.props.hasSurvey || e.props.isWorking || hidden) return below
    if (!v) {
      if (!loading && !lastError) void refresh($)
      const { Box: B, Text: T } = $.ui.resolve(e)
      return (
        <B flexDirection="column">
          <T color={MUTED}>{s.offline(base, lastError || s.loading)}</T>
          {below}
        </B>
      )
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    // la pregunta de una acción que escribe y su [Cancelar][Sí, …]; Cancelar primero: un Enter de más cancela
    const confirmRow = (prefix: string, a: Act, n: Node) => (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>{question(a, n)}</Text>
        </Text>
        <Box flexWrap="wrap">
          <Button key={`${prefix}-cancel`} label={s.cancel} dimColor onPress={() => void ask($, null)} />
          <Button key={`${prefix}-confirm`} label={yes(a)} variant="primary" onPress={() => act($, a, n)} />
        </Box>
      </Box>
    )
    const list: Item[] = [...v.waiting, ...v.startable]

    const head = (
      <Text wrap="truncate-end">
        <Text color={BLUE}>◆ dagyard </Text>
        <Text bold>{v.project}</Text>
        <Text color={MUTED}>{s.progress(v.done, v.total, v.now)} · </Text>
        <Text color={v.waiting.length ? AMBER : MUTED}>{s.waitingCount(v.waiting.length)}</Text>
        <Text color={MUTED}> · </Text>
        <Text color={v.startable.length ? BLUE : MUTED}>{s.startableCount(v.startable.length)}</Text>
      </Text>
    )

    let body = null
    const w = working
    if (busy) {
      body = <Text color={MUTED}>…</Text>
    } else if (w) {
      body = (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text color={BLUE}>{s.workingOn}</Text>
            <Text bold>{w.title}</Text>
          </Text>
          {asking && asking.id === w.id && asking.act !== 'take' ? (
            confirmRow('dy', asking.act, w)
          ) : (
            <Box flexWrap="wrap">
              <Button key="dy-done" label={s.done} variant="primary" onPress={() => void ask($, { act: 'done', id: w.id })} />
              <Button key="dy-release" label={s.release} onPress={() => void ask($, { act: 'release', id: w.id })} />
              <Button key="dy-open" label={s.openSky} hotkey="o" dimColor onPress={() => void openSky($, w.id)} />
            </Box>
          )}
        </Box>
      )
    } else if (list.length > 0) {
      const i = cursor % list.length
      const it = list[i]!
      const more =
        list.length > 1 ? (
          <Button key="dy-next" label={s.other(i + 1, list.length)} hotkey="s" dimColor onPress={() => void skip($)} />
        ) : null
      if (it.kind === 'waiting') {
        const b = it.blocker
        const label = s.waitingLabel(b.kind)
        const p = picked && picked.id === b.id && b.kind !== 'access' ? picked : null
        // las opciones no llevan hotkey: elegir es marcar y después «Sí, elegir» (#89)
        const buttons =
          b.kind === 'access'
            ? [<Button key="dy-sky" label={s.grantInSky} hotkey="o" variant="primary" onPress={() => void openSky($, it.node.id)} />]
            : b.options.slice(0, 3).map((opt, k) => (
                <Button key={`dy-opt-${k}`} label={opt} variant={k === 0 ? 'primary' : undefined} onPress={() => void pick($, { id: b.id, choice: k })} />
              ))
        body = (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={AMBER}>{label} · </Text>
              <Text bold>{it.node.title}</Text>
              <Text color={MUTED}> — {b.kind === 'access' ? b.accessLabel ?? b.question : b.question}</Text>
            </Text>
            {p ? (
              <Box flexDirection="column">
                <Text wrap="truncate-end">
                  <Text bold>{s.confirmPick(b.options[p.choice] ?? '')}</Text>
                  <Text color={MUTED}> {s.cannotUndo}</Text>
                </Text>
                {/* Cancelar primero: un Enter de más sobre el mismo lugar cancela en vez de resolver */}
                <Box flexWrap="wrap">
                  <Button key="dy-cancel" label={s.cancel} dimColor onPress={() => void pick($, null)} />
                  <Button key="dy-confirm" label={s.yesChoose} variant="primary" onPress={() => void resolve($, it, p.choice, '')} />
                </Box>
              </Box>
            ) : (
              <Box flexWrap="wrap">
                {buttons}
                {more}
                <Button key="dy-menu" label={s.seeAll} hotkey="m" dimColor onPress={() => void openMenu($)} />
              </Box>
            )}
          </Box>
        )
      } else {
        const n = it.node
        body = (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={BLUE}>{s.readyToTake}</Text>
              <Text bold>{n.title}</Text>
              {n.goal ? <Text color={MUTED}> — /goal {n.goal}</Text> : null}
            </Text>
            {asking && asking.id === n.id && asking.act === 'take' ? (
              confirmRow('dy', 'take', n)
            ) : (
              <Box flexWrap="wrap">
                <Button key="dy-take" label={s.workOnThis} variant="primary" onPress={() => void ask($, { act: 'take', id: n.id })} />
                {more}
                <Button key="dy-menu" label={s.seeAll} hotkey="m" dimColor onPress={() => void openMenu($)} />
              </Box>
            )}
          </Box>
        )
      }
    }

    return (
      <Box flexDirection="column">
        {head}
        {body}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: MENU }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    // la pregunta de una acción que escribe y su [Cancelar][Sí, …]; Cancelar primero: un Enter de más cancela
    const confirmRow = (prefix: string, a: Act, n: Node) => (
      <Box flexDirection="column">
        <Text wrap="wrap">
          <Text bold>{question(a, n)}</Text>
        </Text>
        <Box flexWrap="wrap">
          <Button key={`${prefix}-cancel`} label={s.cancel} dimColor onPress={() => void ask($, null)} />
          <Button key={`${prefix}-confirm`} label={yes(a)} variant="primary" onPress={() => act($, a, n)} />
        </Box>
      </Box>
    )
    // «Qué cambiarías» se escribe donde la superficie tiene campo de texto (el celular no lo dibuja);
    // donde no, «Pedir cambios» se manda sin nota en vez de dejar un «Cancelar» solo
    const Input = e.surface !== 'mobile' && 'Input' in els ? els.Input : null
    const v = view
    if (!v) {
      return (
        <Box flexDirection="column">
          <Text color={MUTED}>{s.offlineMenu(base, lastError || s.loading)}</Text>
          <Button key="mn-retry" label={s.retry} onPress={() => void refresh($)} />
        </Box>
      )
    }
    const w = working
    const rows: any[] = []

    rows.push(
      <Text key="mn-head" wrap="truncate-end">
        <Text bold>{v.project}</Text>
        <Text color={MUTED}>{s.progress(v.done, v.total, v.now)}</Text>
      </Text>,
    )

    if (w) {
      rows.push(<Text key="mn-w-sec" color={BLUE}>{'\n'}{s.working}</Text>)
      rows.push(
        <Box key="mn-w" flexDirection="column">
          <Text bold>{w.title}</Text>
          {asking && asking.id === w.id && asking.act !== 'take' ? (
            confirmRow('mn-w', asking.act, w)
          ) : (
            <Box flexWrap="wrap">
              <Button key="mn-w-done" label={s.done} variant="primary" onPress={() => void ask($, { act: 'done', id: w.id })} />
              <Button key="mn-w-release" label={s.release} onPress={() => void ask($, { act: 'release', id: w.id })} />
            </Box>
          )}
        </Box>,
      )
    }

    rows.push(<Text key="mn-wait-sec" color={v.waiting.length ? AMBER : MUTED}>{'\n'}{s.waitingSection(v.waiting.length)}</Text>)
    if (v.waiting.length === 0) rows.push(<Text key="mn-wait-none" color={MUTED}>{s.nothingWaiting}</Text>)
    v.waiting.forEach(it => {
      if (it.kind !== 'waiting') return
      const b = it.blocker
      const kind = s.kindName(b.kind)
      const id = b.id
      let actions: any
      if (b.kind === 'access') {
        actions = <Button key={`mn-${id}-sky`} label={s.grantInSky} variant="primary" onPress={() => void openSky($, it.node.id)} />
      } else if (commenting === id && Input) {
        const k = b.options.findIndex(o => REQUEST_CHANGES.test(o))
        actions = (
          <Box flexDirection="column">
            <Input key={`mn-${id}-note`} label={s.whatWouldYouChange} placeholder={s.oneLine} submitLabel={s.send} autoFocus onSubmit={(value: string) => void resolve($, it, k < 0 ? b.options.length - 1 : k, value)} />
            <Button key={`mn-${id}-cancel`} label={s.cancel} dimColor onPress={() => void comment($, null)} />
          </Box>
        )
      } else if (picked && picked.id === id) {
        const choice = picked.choice
        actions = (
          <Box flexDirection="column">
            <Text wrap="wrap">
              <Text bold>{s.confirmPick(b.options[choice] ?? '')}</Text>
              <Text color={MUTED}> {s.cannotUndo}</Text>
            </Text>
            <Box flexWrap="wrap">
              <Button key={`mn-${id}-cancel`} label={s.cancel} dimColor onPress={() => void pick($, null)} />
              <Button key={`mn-${id}-confirm`} label={s.yesChoose} variant="primary" onPress={() => void resolve($, it, choice, '')} />
            </Box>
          </Box>
        )
      } else {
        // «Pedir cambios» ya son dos pasos (abrir el campo y enviar); el resto marca y pide «Sí, elegir» (#89)
        actions = (
          <Box flexWrap="wrap">
            {b.options.map((opt, k) =>
              b.kind === 'review' && Input && REQUEST_CHANGES.test(opt) ? (
                <Button key={`mn-${id}-${k}`} label={opt} onPress={() => void comment($, id)} />
              ) : (
                <Button key={`mn-${id}-${k}`} label={opt} variant={k === 0 ? 'primary' : undefined} onPress={() => void pick($, { id, choice: k })} />
              ),
            )}
          </Box>
        )
      }
      rows.push(
        <Box key={`mn-${id}`} flexDirection="column">
          <Text wrap="wrap">
            <Text color={AMBER}>{kind} · </Text>
            <Text bold>{it.node.title}</Text>
          </Text>
          <Text wrap="wrap" color={MUTED}>{b.kind === 'access' ? `${b.question} (${b.accessLabel ?? s.access})` : b.question}</Text>
          {actions}
        </Box>,
      )
    })

    rows.push(<Text key="mn-take-sec" color={v.startable.length ? BLUE : MUTED}>{'\n'}{s.startableSection(v.startable.length)}</Text>)
    if (v.startable.length === 0) rows.push(<Text key="mn-take-none" color={MUTED}>{s.nothingStartable}</Text>)
    v.startable.forEach(it => {
      const n = it.node
      rows.push(
        <Box key={`mn-t-${n.id}`} flexDirection="column">
          <Text bold>{n.title}</Text>
          {n.goal ? <Text wrap="wrap" color={MUTED}>/goal {n.goal}</Text> : null}
          {asking && asking.id === n.id && asking.act === 'take' ? (
            confirmRow(`mn-t-${n.id}`, 'take', n)
          ) : (
            <Button key={`mn-t-${n.id}-take`} label={s.workOnThis} variant="primary" onPress={() => void ask($, { act: 'take', id: n.id })} />
          )}
        </Box>,
      )
    })

    rows.push(
      <Box key="mn-foot">
        <Text>{'\n'}</Text>
        <Button key="mn-sky" label={s.openSky} dimColor onPress={() => void openSky($, w?.id)} />
        <Button key="mn-band" label={hidden ? s.showBand : s.hideBand} dimColor onPress={() => void toggleBand($)} />
      </Box>,
    )

    return <Box flexDirection="column">{rows}</Box>
  })
}
