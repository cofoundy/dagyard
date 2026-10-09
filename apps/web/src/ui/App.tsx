// Raíz: el cielo siempre montado detrás (también en la entrada) y, encima, la entrada o el espacio de trabajo.

import { useEffect, useRef, useState } from 'react';
import type { SafeArea, SceneHandlers } from '../scene/contract';
import type { AppApi } from '../data/session';
import { EMPTY_GRAPH } from '../data/view';
import { useLang } from '../i18n';
import { COPY } from './copy';
import { Entry, type EntryNotice } from './Entry';
import { readLink } from './link';
import { useSky } from './useSky';
import { Workspace } from './Workspace';

/** Estimado hasta que el HUD se mide de verdad (Workspace lo corrige al montar). */
const INITIAL_SAFE_AREA: SafeArea = { top: 104, right: 20, bottom: 84, left: 20 };

type Phase = 'checking' | 'entry' | 'in';

export function App({ api, demo = false }: { api: AppApi; demo?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const handlers = useRef<SceneHandlers>({ onPick: () => {} });
  const sky = useSky(canvas, labels, handlers, INITIAL_SAFE_AREA);
  const [phase, setPhase] = useState<Phase>('checking');
  const [notice, setNotice] = useState<EntryNotice | undefined>();
  // Al cambiar de idioma se vuelve a pintar todo el árbol: cada texto se lee del catálogo al pintar.
  useLang();

  // Con un enlace a un proyecto (`?p=`), su plan y la lista se piden junto con la sesión, no después (#112).
  const prefetched = useRef(false);
  useEffect(() => {
    let alive = true;
    const linked = readLink().project;
    if (linked && !prefetched.current) api.prefetch?.(linked);
    prefetched.current = true;
    api
      .check()
      .then((ok) => alive && setPhase(ok ? 'in' : 'entry'))
      .catch(() => alive && setPhase('entry'));
    return () => {
      alive = false;
    };
  }, [api]);

  useEffect(() => {
    if (phase === 'in') return;
    handlers.current = { onPick: () => {} };
    sky.current?.setGraph(EMPTY_GRAPH);
  }, [phase, sky]);

  return (
    <div className="app">
      <div className="backdrop" aria-hidden="true" />
      <canvas ref={canvas} className="sky" aria-label={COPY.skyLabel} />
      <div ref={labels} className="labels" />
      {phase === 'entry' && (
        <Entry
          api={api}
          notice={notice}
          onEnter={() => {
            setNotice(undefined);
            setPhase('in');
          }}
        />
      )}
      {phase === 'in' && (
        <Workspace
          api={api}
          sky={sky}
          handlers={handlers}
          demo={demo}
          onUnauthorized={() => {
            setNotice('entryExpired');
            setPhase('entry');
          }}
          onLogout={() => {
            void api.logout();
            setNotice(undefined);
            setPhase('entry');
          }}
        />
      )}
    </div>
  );
}
