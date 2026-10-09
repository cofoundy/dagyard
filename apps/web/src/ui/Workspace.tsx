// El espacio de trabajo: elige el proyecto, mantiene el estado vivo (snapshot + eventos) y conecta la
// escena con el HUD, la ficha y los avisos. Eventos del servidor → reducer → DAG → setGraph + pulse + aviso.
// Una sola vista (#75): el DAG que crece; abrir una tarea hace volar la cámara hasta ella y cerrarla la trae de vuelta.

import { DEMO_PROJECT_IDS, demoProjectId } from '@dagyard/model';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { Pulse, SceneHandlers, Sky } from '../scene/contract';
import { ApiError, type AppApi } from '../data/session';
import { ProjectStore, type StoreChange, type StoreState } from '../data/store';
import { UnauthorizedError, type Blocker, type ProjectSummary, type Resolution } from '../data/types';
import { buildDag } from '../data/dag';
import { activityOf, nodeById, openBlockers, toSceneGraph, touchedOf } from '../data/view';
import { lang, t, type Lang } from '../i18n';
import { orientation } from '../data/orient';
import {
  isLooking,
  newlyOpened,
  notifyPermission,
  requestNotifyPermission,
  showAttention,
  showNotice,
  type NotifyPermission,
} from './attention';
import { Card } from './Card';
import { COPY } from './copy';
import { feedbackFor, resolvedToast, type ToastSpec } from './feedback';
import { Actions, Brand, Footer, Toasts, type FindHandle, type ToastItem } from './Hud';
import { readLink, writeLink } from './link';
import { useSafeArea } from './useSafeArea';
import { Brief } from './Brief';

const PROJECT_KEY = 'dagyard:project';
const TOAST_MS = 4200;
const MAX_TOASTS = 3;
/** «Ahora» avanza solo: el borde derecho del eje y la edad de lo terminado se recalculan cada minuto. */
const NOW_TICK = 60_000;

/**
 * Proyecto que se abre al entrar: el del enlace (`?p=`), si existe; si no, el que el usuario eligió la última vez; si no
 * eligió (o ya no existe), la demo en su idioma (#74), que es lo primero que un PM tiene que ver (la lista llega por
 * última actualización, así que su primero sería el último importado). Si falta la de su idioma, la otra; sin demo, el
 * primero de la lista.
 */
export function initialProject(
  list: readonly ProjectSummary[],
  stored: string | null,
  linked: string | null = null,
  l: Lang = lang(),
): string | null {
  const has = (id: string | null) => !!id && list.some((p) => p.id === id);
  if (has(linked)) return linked;
  if (has(stored)) return stored;
  const demo = [demoProjectId(l), ...DEMO_PROJECT_IDS].find(has);
  return demo ?? list[0]?.id ?? null;
}

const NO_STATE: StoreState = { snapshot: null, status: 'loading' };
const noSubscribe = () => () => {};
const noState = () => NO_STATE;

export interface WorkspaceProps {
  api: AppApi;
  sky: RefObject<Sky | null>;
  handlers: RefObject<SceneHandlers>;
  demo?: boolean;
  onUnauthorized: () => void;
  onLogout: () => void;
}

export function Workspace({ api, sky, handlers, demo, onUnauthorized, onLogout }: WorkspaceProps) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [listError, setListError] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [store, setStore] = useState<ProjectStore | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const brandRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const footRef = useRef<HTMLElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const briefRef = useRef<HTMLElement>(null);
  const findRef = useRef<FindHandle>(null);

  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  /* ---------------------------------------------------------------- avisos */

  const toastSeq = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  };
  const pushToast = useCallback((spec: ToastSpec) => {
    const id = ++toastSeq.current;
    setToasts((list) => [{ id, ...spec }, ...list].slice(0, MAX_TOASTS));
    later(() => setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t))), TOAST_MS);
    later(() => setToasts((list) => list.filter((t) => t.id !== id)), TOAST_MS + 450);
  }, []);
  useEffect(() => {
    const set = timers.current;
    return () => {
      for (const t of set) clearTimeout(t);
      set.clear();
    };
  }, []);

  /* ---------------------------------------------------------------- proyectos */

  // El enlace se lee una vez al entrar; su tarea (`?n=`) se abre cuando llega el primer plan de su proyecto.
  const linkRead = useRef(false);
  const pendingFocus = useRef<{ project: string; node: string } | null>(null);

  const loadProjects = useCallback(async () => {
    setListError(false);
    try {
      const list = await api.listProjects();
      setProjects(list);
      const link = linkRead.current ? null : readLink();
      linkRead.current = true;
      const linked = link?.project && list.some((p) => p.id === link.project) ? link.project : null;
      let stored: string | null = null;
      try {
        // Abrir un enlace cuenta como elegir ese proyecto: se recuerda, como desde el selector.
        if (linked) localStorage.setItem(PROJECT_KEY, linked);
        stored = localStorage.getItem(PROJECT_KEY);
      } catch {
        /* almacenamiento bloqueado */
      }
      if (linked && link?.node) pendingFocus.current = { project: linked, node: link.node };
      setProjectId((cur) => cur ?? initialProject(list, stored, linked));
    } catch (e) {
      if (e instanceof UnauthorizedError) onUnauthorizedRef.current();
      else setListError(true);
    }
  }, [api]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const pickProject = (id: string) => {
    try {
      localStorage.setItem(PROJECT_KEY, id);
    } catch {
      /* almacenamiento bloqueado */
    }
    pendingFocus.current = null;
    setFocusId(null);
    setProjectId(id);
  };

  /* ---------------------------------------------------------------- estado vivo */

  // Pulsos pendientes: se disparan después del setGraph que trae al nodo (un nodo recién nacido aún no existe).
  const pendingPulses = useRef<Array<{ nodeId: string; kind: Pulse }>>([]);
  const mine = useRef(new Set<string>());

  // Avisos del navegador abiertos de este proyecto, por bloqueante (uno por pedido, nunca dos).
  const notices = useRef(new Map<string, Notification | null>());
  const focusRef = useRef<(id: string) => void>(() => {});

  const onChange = useRef<(c: StoreChange) => void>(() => {});
  onChange.current = ({ prev, next, event }) => {
    const opened = newlyOpened(prev, next, event);
    // Solo si no estás mirando: con la página al frente ya están el aviso en pantalla y la cuenta del HUD.
    if (opened && !notices.current.has(opened.blocker.id) && !isLooking(document)) {
      const notice = showNotice(
        {
          blockerId: opened.blocker.id,
          nodeId: opened.node.id,
          taskTitle: opened.node.title,
          kind: opened.blocker.kind,
          projectName: next.project.name,
        },
        (nodeId) => focusRef.current(nodeId),
      );
      if (notice) notices.current.set(opened.blocker.id, notice);
    }
    if (event.type === 'blocker.resolved') {
      // Ya no te espera: el aviso que quedó en el centro de notificaciones se va.
      notices.current.get(event.blocker.id)?.close();
    }
    const fb = feedbackFor(prev, next, event);
    if (fb.pulse) pendingPulses.current.push(fb.pulse);
    // Lo que resolviste desde aquí ya tiene su aviso; el eco del servidor no lo repite.
    if (event.type === 'blocker.resolved' && mine.current.has(event.blocker.id)) return;
    if (fb.toast) pushToast(fb.toast);
  };

  useEffect(() => {
    if (!projectId) return;
    const s = new ProjectStore(api, projectId, {
      onChange: (c) => onChange.current(c),
      onUnauthorized: () => onUnauthorizedRef.current(),
    });
    setStore(s);
    s.start().catch(() => {});
    const open = notices.current;
    return () => {
      // Al cambiar de proyecto, los avisos del anterior ya no abren nada aquí.
      for (const n of open.values()) n?.close();
      open.clear();
      s.dispose();
      setStore((cur) => (cur === s ? null : cur));
    };
  }, [api, projectId]);

  const state = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getState ?? noState);
  const snapshot = state.snapshot;

  /* ---------------------------------------------------------------- escena */

  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), NOW_TICK);
    return () => clearInterval(id);
  }, []);
  // el DAG se recalcula con cada evento; «ahora» es el reloj, salvo que el último nacimiento sea más nuevo
  const model = useMemo(() => (snapshot ? buildDag(snapshot, Math.max(tick, Date.now())) : null), [snapshot, tick]);
  // la brújula (#109): qué te espera, qué está en curso y qué sigue
  const orient = useMemo(() => (model && snapshot ? orientation(model, snapshot) : null), [model, snapshot]);
  // lo que sigue y la brújula nombra (las 3 primeras) se rotula también en el cielo; lo quieto, la píldora lo dice igual
  const marks = useMemo(
    () => ({
      named: new Set(orient?.next.slice(0, 3).map((x) => x.task.id)),
      quiet: new Set(orient?.moving.filter((x) => x.quiet).map((x) => x.task.id)),
    }),
    [orient],
  );
  const graph = useMemo(
    () => (model && snapshot ? toSceneGraph(model, activityOf(snapshot), touchedOf(snapshot), marks) : null),
    [model, snapshot, marks],
  );
  const shownProject = useRef<string | null>(null);
  useEffect(() => {
    const s = sky.current;
    if (!graph || !snapshot || !s) return;
    s.setGraph(graph);
    const switched = shownProject.current !== null && shownProject.current !== snapshot.project.id;
    shownProject.current = snapshot.project.id;
    if (switched) s.overview();
    const pulses = pendingPulses.current.splice(0);
    for (const p of pulses) if (graph.nodes.some((n) => n.id === p.nodeId)) s.pulse(p.nodeId, p.kind);
    const linked = pendingFocus.current;
    if (linked?.project === snapshot.project.id) {
      pendingFocus.current = null;
      // Una tarea que ya no está en el plan se ignora: queda la vista general y el enlace pierde la `n`.
      if (nodeById(snapshot, linked.node)) focusRef.current(linked.node);
      else writeLink({ project: linked.project, node: null });
    }
  }, [graph, snapshot, sky]);

  const focus = useCallback(
    (id: string) => {
      if (!snapshot) return;
      const n = nodeById(snapshot, id);
      if (!n) return;
      setFocusId(id);
      sky.current?.focus(id);
    },
    [snapshot, sky],
  );

  focusRef.current = focus;

  // La URL sigue a lo que miras, así cualquier vista se puede copiar y mandar. Mientras la tarea del enlace espera su
  // plan, la `n` se conserva.
  useEffect(() => {
    if (!projectId) return;
    const linked = pendingFocus.current;
    writeLink({ project: projectId, node: focusId ?? (linked?.project === projectId ? linked.node : null) });
  }, [projectId, focusId]);

  const overview = useCallback(() => {
    setFocusId(null);
    sky.current?.overview();
  }, [sky]);

  const replay = useCallback(() => {
    setFocusId(null);
    sky.current?.replay();
  }, [sky]);

  const mark = useCallback((id: string | null) => sky.current?.mark(id), [sky]);

  const engaged = focusId !== null;
  useLayoutEffect(() => {
    handlers.current = {
      onPick: (id) => {
        if (id) focus(id);
        else if (engaged) overview();
      },
      onModeChange: (m) => {
        if (m === 'overview') setFocusId(null);
      },
    };
  }, [handlers, focus, overview, engaged]);

  useEffect(() => {
    if (!engaged) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && !ev.defaultPrevented) overview();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engaged, overview]);

  // Si la tarea abierta sale del plan, se vuelve a la vista general.
  const focusedNode = snapshot ? nodeById(snapshot, focusId) : undefined;
  useEffect(() => {
    if (focusId && snapshot && !focusedNode) overview();
  }, [focusId, snapshot, focusedNode, overview]);

  /* ---------------------------------------------------------------- HUD medido */

  useSafeArea(
    [brandRef, actionsRef],
    [footRef, noteRef],
    (area) => sky.current?.setSafeArea(area),
    [!!snapshot, demo, !!model?.tasks.length],
    [briefRef],
  );

  // lo que tapa la ficha: el vuelo a una tarea la deja en el centro de lo que queda a la vista
  useLayoutEffect(() => {
    const measure = () => {
      const el = document.querySelector('.card.open');
      const r = el?.getBoundingClientRect();
      if (!r || !focusId) return sky.current?.setCardArea({ right: 0, bottom: 0 });
      const vw = window.innerWidth, vh = window.innerHeight;
      // escritorio: a la derecha; móvil: hoja inferior
      if (vw <= 720) sky.current?.setCardArea({ right: 0, bottom: Math.round(vh - r.top + 8) });
      else sky.current?.setCardArea({ right: Math.round(vw - r.left + 16), bottom: 0 });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [focusId, sky]);

  /* ---------------------------------------------------------------- acciones */

  /* ---------------------------------------------------------------- pestaña y avisos del navegador */

  // La cuenta del proyecto que miras: «(2) Dagyard» y el punto ámbar, también con la pestaña de fondo.
  const openCount = snapshot ? openBlockers(snapshot).length : 0;
  useEffect(() => showAttention(document, openCount), [openCount]);
  useEffect(() => () => showAttention(document, 0), []);

  const [permission, setPermission] = useState<NotifyPermission>(notifyPermission);
  useEffect(() => {
    // Si lo cambias desde los ajustes del navegador, el botón se entera al volver a la pestaña.
    const sync = () => setPermission(notifyPermission());
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
    };
  }, []);
  const askPermission = () => void requestNotifyPermission().then(setPermission);

  const waitingIds = useMemo(() => (snapshot ? [...new Set(openBlockers(snapshot).map((b) => b.nodeId))] : []), [snapshot]);

  const nextWaiting = () => {
    if (!waitingIds.length) return;
    const i = focusId ? (waitingIds.indexOf(focusId) + 1) % waitingIds.length : 0;
    focus(waitingIds[i]!);
  };

  const resolve = async (b: Blocker, r: Resolution) => {
    if (!store) return;
    const title = (snapshot && nodeById(snapshot, b.nodeId)?.title) ?? '';
    mine.current.add(b.id);
    try {
      const res = await store.resolve(b.id, r);
      pushToast(resolvedToast(title, res.resolution, b.nodeId));
      sky.current?.pulse(b.nodeId, 'working');
    } catch (e) {
      mine.current.delete(b.id);
      if (e instanceof UnauthorizedError) {
        onUnauthorizedRef.current();
        throw new Error(COPY.entryExpired);
      }
      if (e instanceof ApiError && e.code === 'conflict') {
        void store.start().catch(() => {});
        throw new Error(COPY.alreadyResolved);
      }
      throw new Error(COPY.sendError);
    }
  };

  /** Un error de «Enlazarlo» o «Dejarla ir» en palabras de la ficha (la sesión vencida vuelve a la entrada). */
  const rethrowForCard = (e: unknown): never => {
    if (e instanceof UnauthorizedError) {
      onUnauthorizedRef.current();
      throw new Error(COPY.entryExpired);
    }
    throw new Error(COPY.sendError);
  };

  /* ---------------------------------------------------------------- vista */

  const current = projects?.find((p) => p.id === projectId);
  const projectName = snapshot?.project.name ?? current?.name ?? '';

  let center: React.ReactNode = null;
  if (listError) {
    center = (
      <div className="center-note">
        <p>{COPY.loadError}</p>
        <button type="button" className="btn" onClick={() => void loadProjects()}>
          {COPY.retry}
        </button>
      </div>
    );
  } else if (projects && !projects.length) {
    center = (
      <div className="center-note">
        <p>{COPY.noProjects}</p>
        <button type="button" className="btn" onClick={onLogout}>
          {COPY.logout}
        </button>
      </div>
    );
  } else if (!snapshot && state.status === 'error') {
    center = (
      <div className="center-note">
        <p>{COPY.loadError}</p>
        <button type="button" className="btn" onClick={() => void store?.start().catch(() => {})}>
          {COPY.retry}
        </button>
      </div>
    );
  } else if (!snapshot) {
    center = (
      <div className="center-note loading">
        <i aria-hidden="true" />
        <p>{COPY.loading}</p>
      </div>
    );
  } else if (!snapshot.nodes.length) {
    center = (
      <div className="center-note empty">
        <h2>{t('brief.nothing')}</h2>
        <p>{t('brief.emptyText')}</p>
      </div>
    );
  }

  return (
    <>
      <Brand
        ref={brandRef}
        projectName={projectName}
        projects={projects ?? []}
        currentId={projectId}
        reconnecting={!!snapshot && state.status === 'reconnecting'}
        onPick={pickProject}
        onLogout={onLogout}
      />
      <Actions ref={actionsRef} onNotify={permission === 'default' ? askPermission : undefined} />
      {orient && model && !!model.tasks.length && (
        <Brief
          ref={briefRef}
          o={orient}
          now={model.now}
          reconnecting={state.status === 'reconnecting'}
          onAnswer={nextWaiting}
          onPick={focus}
          onMark={mark}
          onFind={() => findRef.current?.focus()}
          floor={() => footRef.current?.getBoundingClientRect().top ?? window.innerHeight}
        />
      )}
      <Toasts items={toasts} onOpen={focus} />
      {snapshot && (
        <Card
          snapshot={snapshot}
          model={model ?? undefined}
          node={focusedNode}
          offline={state.status === 'reconnecting'}
          onClose={overview}
          onFocus={focus}
          onResolve={resolve}
          onLink={store ? (from, to) => store.link(from, to).catch(rethrowForCard) : undefined}
          onDrop={store ? (id, why) => store.drop(id, why).catch(rethrowForCard) : undefined}
        />
      )}
      {demo && (
        <div className="hud note" ref={noteRef}>
          {COPY.demoNote}
        </div>
      )}
      {snapshot && <Footer ref={footRef} model={model} carded={!!focusedNode} onPick={focus} onMark={mark} onReplay={replay} findRef={findRef} />}
      {center}
    </>
  );
}
