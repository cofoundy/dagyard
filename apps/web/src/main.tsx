import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HttpApi } from './data/http';
import type { AppApi } from './data/session';
import { initLang } from './i18n';
import { App } from './ui/App';
import './styles.css';

async function boot() {
  // idioma antes del primer pintado: elección guardada > navegador > inglés (#73)
  initLang();
  let api: AppApi;
  let demo = false;
  // `pnpm dev:fixture`: sin servidor, con el proyecto de ejemplo en memoria. Vite reemplaza la variable
  // en tiempo de build, así que el fixture no entra al bundle de producción.
  if (import.meta.env.VITE_FIXTURE) {
    const { FixtureApi } = await import('./data/fixture');
    // con los proyectos de la vista DAG: el real del 4 oct (#90), el de estrés y uno vacío
    const fixture = new FixtureApi({ latency: 220, extra: true });
    // Simulador del CLI desde la consola del navegador, p. ej.:
    //   dagyard.message('marketplace-reservas', 'pagos-con-tarjeta', 'Ya conecté la pasarela.')
    //   dagyard.done('marketplace-reservas', 'registro-e-inicio-de-sesion')
    (window as unknown as { dagyard: typeof fixture }).dagyard = fixture;
    api = fixture;
    demo = true;
    // prototipo #109: con `?variant=` se entra directo (cualquier clave sirve en el ejemplo)
    if (new URLSearchParams(location.search).has('variant')) await fixture.login('prototipo');
  } else {
    api = new HttpApi();
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App api={api} demo={demo} />
    </StrictMode>,
  );
}

void boot();
