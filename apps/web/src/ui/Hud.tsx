// HUD en los bordes: marca + proyecto (abre el selector) + el resumen del DAG arriba a la izquierda; arriba a la derecha
// el único botón principal (lo que te espera); abajo la instrucción con su leyenda, «Busca una tarea» y «Repetir»;
// avisos arriba al centro. Todo lo demás se hace tocando estrellas (design/arbol/handoff.md).

import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import type { DagCounts, DagModel, DagTask } from '../data/dag';
import type { ProjectSummary } from '../data/types';
import { clock, COPY, findMore, summary, waitingText } from './copy';
import type { ToastKind } from './feedback';
import { LangSwitch } from './LangSwitch';

/* ------------------------------------------------------------------ marca */

interface BrandProps {
  counts: DagCounts | null;
  projectName: string;
  projects: ProjectSummary[];
  currentId: string | null;
  reconnecting: boolean;
  onPick: (projectId: string) => void;
  onLogout: () => void;
}

export const Brand = forwardRef<HTMLDivElement, BrandProps>(function Brand(
  { counts, projectName, projects, currentId, reconnecting, onPick, onLogout },
  ref,
) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (ev: PointerEvent | KeyboardEvent) => {
      if (ev instanceof KeyboardEvent ? ev.key === 'Escape' : !wrap.current?.contains(ev.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);

  const sum = counts ? summary(counts) : null;
  return (
    <div className="hud brand" ref={ref}>
      <div className="word">
        <i className={reconnecting ? 'off' : ''} aria-hidden="true" />
        dagyard
      </div>
      <div className="proj-wrap" ref={wrap}>
        <button
          type="button"
          className="proj"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={COPY.projectsTitle}
        >
          <span>{projectName}</span>
          <svg className="chev" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && (
          <div className="picker" role="listbox" aria-label={COPY.projectsTitle}>
            <div className="sec">{COPY.projectsTitle}</div>
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={p.id === currentId}
                className={p.id === currentId ? 'cur' : ''}
                onClick={() => {
                  setOpen(false);
                  if (p.id !== currentId) onPick(p.id);
                }}
              >
                <span>{p.name}</span>
                {p.id === currentId && <span className="tick">●</span>}
              </button>
            ))}
            <LangSwitch />
            <button type="button" className="out" onClick={onLogout}>
              {COPY.logout}
            </button>
          </div>
        )}
      </div>
      <div className="now sum" aria-live="polite">
        {reconnecting ? (
          <span className="amber">{COPY.reconnecting}</span>
        ) : sum ? (
          <>
            <span className="n">
              {sum.tasks}
              <span className="sep">·</span>
            </span>
            <b>{sum.working}</b>
            <span className="opt">
              <span className="sep">·</span>
              {sum.pending}
            </span>
            {sum.loose && (
              <>
                <span className="sep">·</span>
                <span className="loose">{sum.loose}</span>
              </>
            )}
          </>
        ) : (
          ' '
        )}
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ acciones */

interface ActionsProps {
  waiting: number;
  onWaiting: () => void;
  /** Solo si el navegador puede avisar y todavía no le pediste permiso: el clic lo pide. */
  onNotify?: () => void;
}

export const Actions = forwardRef<HTMLDivElement, ActionsProps>(function Actions({ waiting, onWaiting, onNotify }, ref) {
  return (
    <div className="hud actions" ref={ref}>
      {onNotify && (
        <button type="button" className="btn notify" onClick={onNotify} title={COPY.notifyMeHint} aria-label={COPY.notifyMe}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 2.2a3.6 3.6 0 0 0-3.6 3.6v2.3L3.2 10.6h9.6l-1.2-2.5V5.8A3.6 3.6 0 0 0 8 2.2ZM6.6 12.4a1.5 1.5 0 0 0 2.8 0"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="lbl">{COPY.notifyMe}</span>
        </button>
      )}
      <button type="button" className={`btn waiting${waiting ? '' : ' calm'}`} onClick={onWaiting} disabled={!waiting} aria-disabled={!waiting}>
        <span className="dot" aria-hidden="true" />
        <span>{waitingText(waiting)}</span>
        {waiting > 0 && <span className="cta">{COPY.answer}</span>}
      </button>
    </div>
  );
});

/* ------------------------------------------------------------------ pie: la leyenda ES la instrucción */

interface FooterProps {
  model: DagModel | null;
  carded: boolean;
  onPick: (id: string) => void;
  onMark: (id: string | null) => void;
  onReplay: () => void;
}

export const Footer = forwardRef<HTMLElement, FooterProps>(function Footer({ model, carded, onPick, onMark, onReplay }, ref) {
  const empty = !model || !model.tasks.length;
  return (
    <footer className={`hud foot${carded ? ' carded' : ''}`} ref={ref}>
      {!empty && (
        <p className="hint">
          <span className="how">
            <span className="long">{COPY.how}</span>
            <span className="short">{COPY.howShort}</span>
          </span>
          <span className="lg">
            <i className="d1" />
            {COPY.legendDone}
          </span>
          <span className="lg">
            <i className="d2" />
            {COPY.legendWorking}
          </span>
          <span className="lg">
            <i className="d3" />
            {COPY.legendWaiting}
          </span>
          <span className="lg opt">
            <i className="d4" />
            {COPY.legendPending}
          </span>
          <span className="lg opt">
            <i className="ln" />
            {COPY.legendNeeds}
          </span>
          <span className="lg opt">
            <i className="lo" />
            {COPY.legendBorn}
          </span>
        </p>
      )}
      {!empty && (
        <div className="tools">
          <Find model={model} onPick={onPick} onMark={onMark} />
          <button type="button" className="ghost" onClick={onReplay} title={COPY.replayHint}>
            {COPY.replay}
          </button>
        </div>
      )}
    </footer>
  );
});

const RANK: Record<DagTask['status'], number> = { blocked: 0, working: 1, pending: 2, done: 3 };
const fold = (x: string) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** «Busca una tarea» (atajo `/`): por nombre, sin tildes ni mayúsculas; lo que te espera y lo que está en curso primero. */
export function Find({ model, onPick, onMark }: { model: DagModel; onPick: (id: string) => void; onMark: (id: string | null) => void }) {
  const [q, setQ] = useState('');
  const [act, setAct] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (ev.key === '/' && !ev.metaKey && !ev.ctrlKey && tag !== 'input' && tag !== 'textarea') {
        ev.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { hits, total } = useMemo(() => {
    const f = fold(q.trim());
    if (!f) return { hits: [] as DagTask[], total: 0 };
    const all = model.tasks.filter((t) => fold(t.title).includes(f)).sort((a, b) => RANK[a.status] - RANK[b.status] || b.born - a.born);
    return { hits: all.slice(0, 6), total: all.length };
  }, [q, model]);
  const active = hits[Math.min(act, Math.max(0, hits.length - 1))];
  const shown = open && q.trim().length > 0;

  useEffect(() => {
    onMark(shown && active ? active.id : null);
  }, [shown, active, onMark]);

  const pick = (t: DagTask | undefined) => {
    if (!t) return;
    setQ('');
    setOpen(false);
    input.current?.blur();
    onMark(null);
    onPick(t.id);
  };

  return (
    <div className="find">
      <input
        ref={input}
        type="search"
        value={q}
        placeholder={COPY.findPlaceholder}
        aria-label={COPY.findLabel}
        aria-controls="find-res"
        aria-expanded={shown}
        role="combobox"
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          setQ(e.target.value);
          setAct(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setAct((a) => Math.min(hits.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setAct((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(active);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setQ('');
            input.current?.blur();
          }
        }}
      />
      {shown && (
        <ul id="find-res" className="res" role="listbox" aria-label={COPY.findResults}>
          {hits.map((t, i) => (
            <li key={t.id}>
              <button
                type="button"
                role="option"
                aria-selected={t === active}
                className={t === active ? 'act' : ''}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(t)}
                onMouseEnter={() => setAct(i)}
              >
                <i className={t.status} />
                <span>{t.title}</span>
                <time>{clock(t.born, model.now)}</time>
              </button>
            </li>
          ))}
          {hits.length === 0 && <li className="none">{COPY.findNone}</li>}
          {total > hits.length && <li className="none">{findMore(hits.length, total)}</li>}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ avisos */

export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  text: string;
  nodeId?: string;
  leaving?: boolean;
}

export function Toasts({ items, onOpen }: { items: ToastItem[]; onOpen: (nodeId: string) => void }) {
  return (
    <div className="hud toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`toast ${t.kind}${t.leaving ? ' out' : ''}${t.nodeId ? ' link' : ''}`}
          onClick={() => t.nodeId && onOpen(t.nodeId)}
          tabIndex={t.nodeId ? 0 : -1}
        >
          <b>{t.title}</b>
          <span>{t.text}</span>
        </button>
      ))}
    </div>
  );
}
