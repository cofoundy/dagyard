// La brújula (#109): bajo el nombre del proyecto, en el orden en que se lee, las tres respuestas que un PM busca al entrar.
//   1. ¿Algo te espera? — grande; si sí, con su único botón principal («Responder») y lo que espera, por nombre.
//   2. En curso ahora   — las tareas que corren, con su última señal de vida («sin noticias en 5 d» si está quieta).
//   3. Lo que sigue     — lo que ya puede arrancar y lo que espera a otra cosa.
// Cada fila es un enlace a su estrella: al pasar el mouse la marca en el cielo, al hacer clic la cámara vuela hasta ella.
// No es un panel: texto sobre el cielo, sin caja (anti-referencias: sidebar, tablas, KPIs).

import { forwardRef, useEffect, useState } from 'react';
import type { Orientation } from '../data/orient';
import { fmtDuration, fmtRelative, t } from '../i18n';

/** Filas por grupo antes de «+N más»: 3 en escritorio, 2 en celular (la pantalla es del grafo también). */
const CAP = 3;
const CAP_MOBILE = 2;

function useCap(): number {
  const q = typeof matchMedia === 'function' ? matchMedia('(max-width: 720px)') : null;
  const [mobile, setMobile] = useState(() => !!q?.matches);
  useEffect(() => {
    if (!q) return;
    const on = () => setMobile(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, [q]);
  return mobile ? CAP_MOBILE : CAP;
}

interface BriefProps {
  o: Orientation;
  now: number;
  reconnecting: boolean;
  onAnswer: () => void;
  onPick: (id: string) => void;
  onMark: (id: string | null) => void;
}

export const Brief = forwardRef<HTMLElement, BriefProps>(function Brief({ o, now, reconnecting, onAnswer, onPick, onMark }, ref) {
  const [allMoving, setAllMoving] = useState(false);
  const [allNext, setAllNext] = useState(false);
  const cap = useCap();
  const quietN = o.moving.filter((x) => x.quiet).length;
  const waiting = o.waiting.length;
  const row = (id: string) => ({
    onClick: () => {
      onMark(null);
      onPick(id);
    },
    onMouseEnter: () => onMark(id),
    onMouseLeave: () => onMark(null),
    onFocus: () => onMark(id),
    onBlur: () => onMark(null),
  });
  const moving = allMoving ? o.moving : o.moving.slice(0, cap);
  const next = allNext ? o.next : o.next.slice(0, cap);

  return (
    <nav className="hud brief" ref={ref} aria-label={t('brief.label')}>
      {/* 1 · ¿algo te espera? */}
      {waiting > 0 ? (
        <div className="b-head wait">
          <p aria-live="polite">
            <i className="dot" aria-hidden="true" />
            {t('brief.waiting', { count: waiting })}
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
        <ul className="b-rows wait">
          {o.waiting.map(({ task, blocker }) => (
            <li key={task.id}>
              <button type="button" className="b-row blocked" {...row(task.id)}>
                <i aria-hidden="true" />
                <span className="ttl" title={task.title}>{task.title}</span>
                <span className="meta">{t(`brief.ask.${blocker.kind}`)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 2 · ¿qué se mueve? */}
      <section className="b-group">
        <h2 className="b-cap">
          {t('brief.moving')}
          {o.moving.length > 0 && <span className="n">{o.moving.length - quietN}</span>}
          {quietN > 0 && <span className="q">· {t('brief.quietCount', { count: quietN })}</span>}
        </h2>
        {o.moving.length === 0 ? (
          <p className="b-none">{t('brief.noMoving')}</p>
        ) : (
          <ul className={`b-rows${allMoving ? ' all' : ''}`}>
            {moving.map(({ task, lastSign, news, quiet }) => (
              <li key={task.id}>
                <button type="button" className={`b-row working${quiet ? ' quiet' : ''}`} {...row(task.id)}>
                  <i aria-hidden="true" />
                  <span className="ttl" title={task.title}>{task.title}</span>
                  <span className="meta">
                    {quiet ? t('brief.quiet', { dur: fmtDuration(roundQuiet(now - lastSign)) }) : t(news ? 'brief.news' : 'brief.started', { ago: fmtRelative(lastSign, now) })}
                  </span>
                </button>
              </li>
            ))}
            {o.moving.length > cap && (
              <li>
                <button type="button" className="b-more" onClick={() => (setAllMoving((v) => !v), setAllNext(false))}>
                  {allMoving ? t('brief.less') : t('brief.more', { count: o.moving.length - cap })}
                </button>
              </li>
            )}
          </ul>
        )}
      </section>

      {/* 3 · ¿qué sigue? */}
      <section className="b-group">
        <h2 className="b-cap">
          {t('brief.next')}
          {o.next.length > 0 && <span className="n">{o.next.length}</span>}
        </h2>
        {o.next.length === 0 ? (
          <p className="b-none">{t('brief.noNext')}</p>
        ) : (
          <ul className={`b-rows${allNext ? ' all' : ''}`}>
            {next.map(({ task, ready, after }) => (
              <li key={task.id}>
                <button type="button" className={`b-row queued${ready ? ' ready' : ''}`} {...row(task.id)}>
                  <i aria-hidden="true" />
                  <span className="ttl" title={task.title}>{task.title}</span>
                  <span className="meta">
                    {ready || !after ? (
                      t('brief.ready')
                    ) : (
                      <>
                        {t('brief.after')} <span className="after">{after.title}</span>
                      </>
                    )}
                  </span>
                </button>
              </li>
            ))}
            {o.next.length > cap && (
              <li>
                <button type="button" className="b-more" onClick={() => (setAllNext((v) => !v), setAllMoving(false))}>
                  {allNext ? t('brief.less') : t('brief.more', { count: o.next.length - cap })}
                </button>
              </li>
            )}
          </ul>
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
