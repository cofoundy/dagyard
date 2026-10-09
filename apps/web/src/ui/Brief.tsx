// La brújula (#109): bajo el nombre del proyecto, en el orden en que se lee, las tres respuestas que un PM busca al entrar.
//   1. ¿Algo te espera? — grande; si sí, con su único botón principal («Responder») y lo que espera, por nombre.
//   2. En curso ahora   — las tareas que corren, con su última señal de vida («sin noticias hace 5 días» si está quieta).
//   3. Lo que sigue     — lo que ya puede arrancar y lo que espera a otra cosa.
// Cada fila es un enlace a su estrella: al pasar el mouse la marca en el cielo, al hacer clic la cámara vuela hasta ella.
// No es un panel: texto sobre el cielo, sin caja (anti-referencias: sidebar, tablas, KPIs). Nunca se desplaza por dentro:
// un grupo desplegado muestra hasta 8 filas y pliega el otro; lo que no cabe se busca por nombre. En celular, lo que te
// espera va completo y los otros dos grupos son una línea cada uno que se despliega (uno a la vez).

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DagTask } from '../data/dag';
import { ROWS, ROWS_MAX, rowsShown, twinTags, type Orientation } from '../data/orient';
import { fmtDuration, fmtRelative, t } from '../i18n';
import { clock, COPY } from './copy';

type Group = 'moving' | 'next';

function useMobile(): boolean {
  const q = useMemo(() => (typeof matchMedia === 'function' ? matchMedia('(max-width: 720px)') : null), []);
  const [mobile, setMobile] = useState(() => !!q?.matches);
  useEffect(() => {
    if (!q) return;
    const on = () => setMobile(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, [q]);
  return mobile;
}

interface BriefProps {
  o: Orientation;
  now: number;
  reconnecting: boolean;
  onAnswer: () => void;
  onPick: (id: string) => void;
  onMark: (id: string | null) => void;
  /** Lo que no cabe en las filas se busca por nombre: lleva el foco a «Busca una tarea». */
  onFind: () => void;
  /** Hasta dónde puede crecer (px desde arriba): el borde del pie. Un grupo desplegado no lo pasa. */
  floor?: () => number;
}

export const Brief = forwardRef<HTMLElement, BriefProps>(function Brief({ o, now, reconnecting, onAnswer, onPick, onMark, onFind, floor }, ref) {
  const mobile = useMobile();
  const self = useRef<HTMLElement>(null);
  useImperativeHandle(ref, () => self.current as HTMLElement);
  // un grupo desplegado a la vez; en celular, plegado es una sola línea
  const [open, setOpen] = useState<Group | null>(null);
  // el tope desplegado: 8, o las que quepan sobre el pie (se mide antes de pintar: sin salto)
  const [fit, setFit] = useState(ROWS_MAX);
  useLayoutEffect(() => setFit(ROWS_MAX), [open, mobile, o]);
  useLayoutEffect(() => {
    const el = self.current;
    const limit = floor?.() ?? 0;
    // sin layout (limit 0: jsdom, o el pie todavía sin medir) no se recorta nada
    if (!el || !open || limit <= 0) return;
    const over = el.getBoundingClientRect().bottom - (limit - 12);
    const rowH = el.querySelector('.b-group .b-row')?.getBoundingClientRect().height ?? 44;
    if (over > 0 && fit > 1) setFit(Math.max(1, fit - Math.ceil(over / rowH)));
  });
  useEffect(() => {
    const on = () => setFit(ROWS_MAX);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const quietN = o.moving.filter((x) => x.quiet).length;
  const waiting = o.waiting.length;
  const tags = useMemo(
    () => twinTags([...o.waiting, ...o.moving, ...o.next].map((x) => x.task), (task) => clock(task.born, now)),
    [o, now],
  );
  const capOf = (g: Group) => (mobile || (open !== null && open !== g) ? 0 : ROWS);
  const toggle = (g: Group) => setOpen((cur) => (cur === g ? null : g));

  const row = (task: DagTask, cls: string, meta: ReactNode) => (
    <li key={task.id}>
      <button
        type="button"
        className={`b-row ${cls}`}
        onClick={() => {
          onMark(null);
          // en celular la ficha sube desde abajo: el grupo se pliega para no quedar cortado debajo de ella
          if (mobile) setOpen(null);
          onPick(task.id);
        }}
        onMouseEnter={() => onMark(task.id)}
        onMouseLeave={() => onMark(null)}
        onFocus={() => onMark(task.id)}
        onBlur={() => onMark(null)}
      >
        <i aria-hidden="true" />
        <span className="ttl" title={task.title}>
          {task.title}
        </span>
        <span className="meta">
          {tags.has(task.id) && <span className="tag">{tags.get(task.id)}</span>}
          {meta}
        </span>
      </button>
    </li>
  );

  /** Los botones al pie de un grupo: «+N más» / «Ver menos», y lo que ni desplegado cabe, a la búsqueda. */
  const tail = (g: Group, rows: ReturnType<typeof rowsShown>) => (
    <>
      {rows.more > 0 && capOf(g) > 0 && (
        <li>
          <button type="button" className="b-more" aria-expanded={false} onClick={() => setOpen(g)}>
            {t('brief.more', { count: rows.more })}
          </button>
        </li>
      )}
      {open === g && rows.rest > 0 && (
        <li>
          <button type="button" className="b-more rest" onClick={onFind}>
            {t('brief.rest', { count: rows.rest, find: COPY.findPlaceholder })}
          </button>
        </li>
      )}
      {open === g && !mobile && (
        <li>
          <button type="button" className="b-more" aria-expanded onClick={() => setOpen(null)}>
            {t('brief.less')}
          </button>
        </li>
      )}
    </>
  );

  /** La cabecera de un grupo: en celular, o si el otro grupo está desplegado, es la línea que lo despliega. */
  const cap = (g: Group, total: number, label: ReactNode) => {
    const folds = total > 0 && capOf(g) === 0;
    const inner = (
      <>
        {label}
        {folds && (
          <svg className="chev" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </>
    );
    return (
      <h2 className="b-cap">
        {folds ? (
          <button type="button" className={`b-tog${open === g ? ' on' : ''}`} aria-expanded={open === g} onClick={() => toggle(g)}>
            {inner}
          </button>
        ) : (
          inner
        )}
      </h2>
    );
  };

  const mv = rowsShown(o.moving.length, open === 'moving', capOf('moving'), fit);
  const nx = rowsShown(o.next.length, open === 'next', capOf('next'), fit);
  const wt = rowsShown(waiting, true);
  /** Plegado a su cabecera (celular, o el otro grupo desplegado): sin lista. */
  const listed = (g: Group, rows: ReturnType<typeof rowsShown>) => rows.shown > 0 || (rows.more > 0 && capOf(g) > 0);

  return (
    <nav className={`hud brief${open ? ' open' : ''}`} ref={self} aria-label={t('brief.label')}>
      {/* 1 · ¿algo te espera? */}
      {waiting > 0 ? (
        <div className="b-head wait">
          <p aria-live="polite">
            <i className="dot" aria-hidden="true" />
            {reconnecting ? t('hud.reconnecting') : t('brief.waiting', { count: waiting })}
          </p>
          <button type="button" className="b-answer" onClick={onAnswer} disabled={reconnecting}>
            {t('hud.answer')}
          </button>
        </div>
      ) : (
        <p className="b-head calm" aria-live="polite">
          <i className="dot" aria-hidden="true" />
          {reconnecting ? t('hud.reconnecting') : t('brief.nothing')}
        </p>
      )}
      {waiting > 0 && (
        <ul className="b-rows">
          {o.waiting.slice(0, wt.shown).map(({ task, blocker }) => row(task, 'blocked', t(`brief.ask.${blocker.kind}`)))}
          {/* más de 8 esperas: «Responder» las recorre todas */}
          {wt.rest > 0 && (
            <li>
              <button type="button" className="b-more" onClick={onAnswer} disabled={reconnecting}>
                {t('brief.more', { count: wt.rest })}
              </button>
            </li>
          )}
        </ul>
      )}

      {/* 2 · ¿qué se mueve? */}
      <section className="b-group">
        {cap(
          'moving',
          o.moving.length,
          <>
            {t('brief.moving')}
            {o.moving.length > 0 && <span className="n">{o.moving.length - quietN}</span>}
            {quietN > 0 && <span className="q">· {t('brief.quietCount', { count: quietN })}</span>}
          </>,
        )}
        {o.moving.length === 0 ? (
          <p className="b-none">{t('brief.noMoving')}</p>
        ) : (
          listed('moving', mv) && (
            <ul className="b-rows">
              {o.moving.slice(0, mv.shown).map(({ task, lastSign, news, quiet }) =>
                row(
                  task,
                  `working${quiet ? ' quiet' : ''}`,
                  quiet ? t('brief.quiet', { dur: fmtDuration(roundQuiet(now - lastSign)) }) : t(news ? 'brief.news' : 'brief.started', { ago: fmtRelative(lastSign, now) }),
                ),
              )}
              {tail('moving', mv)}
            </ul>
          )
        )}
      </section>

      {/* 3 · ¿qué sigue? */}
      <section className="b-group">
        {cap(
          'next',
          o.next.length,
          <>
            {t('brief.next')}
            {o.next.length > 0 && <span className="n">{o.next.length}</span>}
          </>,
        )}
        {o.next.length === 0 ? (
          <p className="b-none">{t('brief.noNext')}</p>
        ) : (
          listed('next', nx) && (
            <ul className="b-rows">
              {o.next.slice(0, nx.shown).map(({ task, ready, after }) =>
                row(
                  task,
                  `queued${ready ? ' ready' : ''}`,
                  ready || !after ? (
                    t('brief.ready')
                  ) : (
                    <>
                      {t('brief.after')} <span className="after">{after.title}</span>
                    </>
                  ),
                ),
              )}
              {tail('next', nx)}
            </ul>
          )
        )}
      </section>
    </nav>
  );
});

/** Lo quieto se cuenta en horas o días enteros («24 h», «5 días»), no al minuto. */
function roundQuiet(ms: number): number {
  const h = ms / 36e5;
  return (h >= 48 ? Math.round(h / 24) * 24 : Math.round(h)) * 36e5;
}
