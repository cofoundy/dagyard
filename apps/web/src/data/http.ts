// DagyardApi sobre fetch + WebSocket, contra docs/api.md de nucleo. La traducción del cable vive en
// ./adapter; aquí solo hay transporte: sesión por cookie, reintentos del WebSocket y reanudación por `seq`.

import {
  toBlocker,
  toEvent,
  toProjectSummary,
  toResolveInput,
  toSnapshot,
  type WireBlocker,
  type WireProjectSummary,
  type WireServerFrame,
  type WireSnapshot,
} from './adapter';
import { onLangChange, t } from '../i18n';
import { ApiError, type AppApi } from './session';
import { UnauthorizedError, type Blocker, type DagEvent, type ProjectSummary, type Resolution, type Snapshot } from './types';

type Handlers = Parameters<AppApi['subscribe']>[2];

export interface HttpApiOptions {
  /** Prefijo de la API en el mismo origen. */
  base?: string;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /** Origen para armar la URL del WebSocket (por defecto, el de la página). */
  origin?: string;
  /** Cada cuánto se manda `ping` (ms). */
  pingEvery?: number;
  /** Sin ningún frame en este tiempo, se da la conexión por muerta y se reconecta (ms). */
  staleAfter?: number;
  /** Espera antes de cada reintento (ms), según el número de intento. */
  backoff?: (attempt: number) => number;
  /**
   * Un socket que recibió `hello` y se cerró (un deploy reinicia el proyecto) reconecta sin esperar, una
   * vez por racha; la racha se renueva cuando un socket vive al menos esto (ms). Así un socket que saluda
   * y muere en bucle vuelve al backoff en vez de martillar.
   */
  quickAfter?: number;
}

export const defaultBackoff = (attempt: number) =>
  Math.min(10_000, 400 * 2 ** Math.min(attempt, 5)) * (0.75 + Math.random() * 0.5);

export class HttpApi implements AppApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly WS: typeof WebSocket;
  private readonly origin: string;
  private readonly opts: Required<Pick<HttpApiOptions, 'pingEvery' | 'staleAfter' | 'backoff' | 'quickAfter'>>;
  /** El contrato resuelve por id de bloqueante; la ruta necesita el proyecto. */
  private readonly blockerProject = new Map<string, string>();

  constructor(o: HttpApiOptions = {}) {
    this.base = o.base ?? '/api';
    this.fetchImpl = o.fetch ?? ((...a) => fetch(...a));
    this.WS = o.WebSocket ?? WebSocket;
    this.origin = o.origin ?? (typeof location !== 'undefined' ? location.origin : 'http://localhost');
    this.opts = {
      pingEvery: o.pingEvery ?? 25_000,
      staleAfter: o.staleAfter ?? 60_000,
      backoff: o.backoff ?? defaultBackoff,
      quickAfter: o.quickAfter ?? 1_000,
    };
  }

  /* ---------------------------------------------------------------- sesión */

  async check(): Promise<boolean> {
    try {
      await this.request('GET', '/me');
      return true;
    } catch (e) {
      if (e instanceof UnauthorizedError) return false;
      throw e;
    }
  }

  async login(token: string): Promise<void> {
    await this.request('POST', '/session', { token: token.trim() });
  }

  async logout(): Promise<void> {
    try {
      await this.request('DELETE', '/session');
    } catch {
      /* salir siempre funciona del lado de la UI */
    }
  }

  /* ---------------------------------------------------------------- lecturas y escrituras */

  async listProjects(): Promise<ProjectSummary[]> {
    const r = await this.request<{ projects: WireProjectSummary[] }>('GET', '/projects');
    return r.projects.map(toProjectSummary);
  }

  async getSnapshot(projectId: string): Promise<Snapshot> {
    const w = await this.request<WireSnapshot>('GET', `/projects/${enc(projectId)}`);
    for (const b of w.blockers) this.blockerProject.set(b.id, w.project.id);
    return toSnapshot(w);
  }

  async resolveBlocker(blockerId: string, resolution: Resolution): Promise<Blocker> {
    const pid = this.blockerProject.get(blockerId);
    if (!pid) throw new ApiError(404, 'not_found', t('card.notFound'));
    const w = await this.request<WireBlocker>(
      'POST',
      `/projects/${enc(pid)}/blockers/${enc(blockerId)}/resolve`,
      toResolveInput(resolution),
    );
    return toBlocker(w);
  }

  async linkOrigin(projectId: string, from: string, to: string, why?: string): Promise<void> {
    await this.request('POST', `/projects/${enc(projectId)}/edges`, { from, to, kind: 'origin', ...(why ? { why } : {}) });
  }

  async dropNode(projectId: string, nodeId: string, why?: string): Promise<void> {
    await this.request('DELETE', `/projects/${enc(projectId)}/nodes/${enc(nodeId)}${why ? `?why=${encodeURIComponent(why)}` : ''}`);
  }

  /* ---------------------------------------------------------------- tiempo real */

  subscribe(projectId: string, sinceSeq: number, handlers: Handlers): () => void {
    let lastSeq = sinceSeq;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    let lastFrame = 0;
    /** Cuándo saludó el socket actual (0: todavía no). */
    let helloAt = 0;
    /** Queda el reintento sin espera de esta racha. */
    let quick = true;
    let status: 'live' | 'reconnecting' | null = null;

    const setStatus = (s: 'live' | 'reconnecting') => {
      if (s === status) return;
      status = s;
      handlers.onStatus?.(s);
    };

    const clearTimers = () => {
      if (retry) clearTimeout(retry);
      if (ping) clearInterval(ping);
      retry = ping = null;
    };

    const scheduleReconnect = (now = false) => {
      if (closed || retry) return;
      setStatus('reconnecting');
      const wait = now ? 0 : this.opts.backoff(attempt);
      attempt++;
      retry = setTimeout(() => {
        retry = null;
        void connect();
      }, wait);
    };

    const onFrame = (raw: unknown) => {
      lastFrame = Date.now();
      if (typeof raw !== 'string') return;
      if (raw === 'pong') return;
      let f: WireServerFrame;
      try {
        f = JSON.parse(raw) as WireServerFrame;
      } catch {
        return;
      }
      switch (f.type) {
        case 'hello':
          attempt = 0;
          helloAt = Date.now();
          setStatus('live');
          break;
        case 'resync':
          lastSeq = Math.max(lastSeq, f.seq);
          handlers.onResync?.();
          break;
        case 'event': {
          const ev = f.event;
          if (ev.seq <= lastSeq) return;
          lastSeq = ev.seq;
          if (ev.type === 'blocker.opened' || ev.type === 'blocker.resolved')
            this.blockerProject.set(ev.payload.blocker.id, projectId);
          const ui: DagEvent | null = toEvent(ev);
          if (ui) handlers.onEvent(ui);
          else handlers.onResync?.();
          break;
        }
        case 'pong':
          break;
      }
    };

    const connect = async () => {
      if (closed) return;
      // La sesión puede haber vencido: sin ella el upgrade falla sin decir por qué. Tras varios intentos,
      // se pregunta; si venció, se pide un resync y el snapshot devuelve el 401 a la UI.
      if (attempt >= 3) {
        const ok = await this.check().catch(() => true);
        if (closed) return;
        if (!ok) {
          handlers.onResync?.();
          scheduleReconnect();
          return;
        }
      }
      const url = new URL(`${this.base}/projects/${enc(projectId)}/live`, this.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('since', String(lastSeq));
      let sock: WebSocket;
      try {
        sock = new this.WS(url.toString());
      } catch {
        scheduleReconnect();
        return;
      }
      ws = sock;
      helloAt = 0;
      lastFrame = Date.now();
      sock.onmessage = (m) => onFrame(m.data);
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null;
        if (ping) clearInterval(ping);
        ping = null;
        // Solo un socket que llegó a `hello` reconecta sin esperar: un servidor caído sigue con backoff.
        if (helloAt && Date.now() - helloAt >= this.opts.quickAfter) quick = true;
        const now = helloAt > 0 && quick;
        if (now) quick = false;
        scheduleReconnect(now);
      };
      sock.onerror = () => {
        try {
          sock.close();
        } catch {
          /* ya cerrado */
        }
      };
      sock.onopen = () => {
        if (ping) clearInterval(ping);
        ping = setInterval(() => {
          if (Date.now() - lastFrame > this.opts.staleAfter) {
            sock.close();
            return;
          }
          try {
            sock.send(JSON.stringify({ type: 'ping' }));
          } catch {
            /* el onclose reconecta */
          }
        }, this.opts.pingEvery);
      };
    };

    // Volver a la pestaña o recuperar la red reconecta ya, sin esperar el backoff.
    const wake = () => {
      if (closed || ws) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (retry) clearTimeout(retry);
      retry = null;
      attempt = 0;
      void connect();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', wake);
      document.addEventListener('visibilitychange', wake);
    }

    // Los resúmenes de las respuestas se escriben en el idioma de la interfaz al traducir el cable: si el PM cambia de
    // idioma, se vuelve a traer el plan para que salgan en el nuevo sin recargar (#73).
    const offLang = onLangChange(() => handlers.onResync?.());

    void connect();

    return () => {
      closed = true;
      offLang();
      clearTimers();
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', wake);
        document.removeEventListener('visibilitychange', wake);
      }
      const s = ws;
      ws = null;
      if (s) {
        s.onclose = null;
        try {
          s.close();
        } catch {
          /* ya cerrado */
        }
      }
    };
  }

  /* ---------------------------------------------------------------- transporte */

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      /* cuerpo no JSON */
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new ApiError(res.status, err?.code ?? 'internal', err?.message ?? `Error ${res.status}`);
    }
    return data as T;
  }
}

const enc = encodeURIComponent;
