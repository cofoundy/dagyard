/**
 * La demo, en dos idiomas (#74): «Booking marketplace» (en) y «Marketplace de reservas» (es). Los 20 nodos
 * de dagyard-design/design/preview-constelacion.html con sus 3 bloqueantes; el mismo grafo en los dos, solo cambia el texto.
 * La siembra el Worker (`PUT /api/projects/<id>`) y la UI puede usarla como fixture local. Sin nada de un
 * cliente real (NDA). Lo que la mueve sola mientras alguien la mira está en demo-pulse.ts.
 */
import { DEFAULT_STAGES, DEFAULT_STAGES_BY_LANG, type Lang, type NodeInput, type NodeStatus, type ProjectGraphInput } from './types.js';

/** Idioma de una demo (el de su proyecto, #77). */
export type DemoLang = Lang;

const IDS: Record<DemoLang, string> = { en: 'booking-marketplace', es: 'marketplace-reservas' };

/** Los ids de las dos demos. Solo estos proyectos tienen pulso. */
export const DEMO_PROJECT_IDS: readonly string[] = [IDS.en, IDS.es];

/** La demo española (compatibilidad: así se llamaba antes de #74). */
export const DEMO_PROJECT_ID = IDS.es;

export function demoProjectId(lang: DemoLang): string {
  return IDS[lang];
}

export function isDemoProject(id: string): boolean {
  return DEMO_PROJECT_IDS.includes(id);
}

/** El idioma de una demo, o null si el proyecto no es una demo. */
export function demoLang(id: string): DemoLang | null {
  return id === IDS.en ? 'en' : id === IDS.es ? 'es' : null;
}

/** Nombre de las etapas (en los dos idiomas con los ids de DEFAULT_STAGES) y del equipo de cada una. */
const STAGE_NAMES: Record<DemoLang, string[]> = {
  en: DEFAULT_STAGES_BY_LANG.en.map((s) => s.name),
  es: DEFAULT_STAGES.map((s) => s.name),
};
const TEAMS: Record<DemoLang, string[]> = {
  en: ['Research', 'Design', 'Build', 'Testing', 'Launch'],
  es: ['Investigación', 'Diseño', 'Construcción', 'Pruebas', 'Lanzamiento'],
};

/** El equipo que toma una tarea de esa etapa. */
export function demoTeam(lang: DemoLang, stageId: string): string {
  const i = DEFAULT_STAGES.findIndex((s) => s.id === stageId);
  return TEAMS[lang][i < 0 ? 2 : i]!;
}

/** Cómo firma un equipo sus mensajes: «Equipo de Diseño», «Design team». */
export function demoSignature(lang: DemoLang, team: string | null): string {
  if (lang === 'en') return team ? `${team} team` : 'The team';
  return `Equipo de ${team ?? 'la fábrica'}`;
}

/** [id, etapa, estado, dependencias, ¿tiene equipo?, avance] */
type Row = [id: string, stage: number, status: NodeStatus, deps: string[], staffed: boolean, progress?: number];

const ROWS: Row[] = [
  ['entrevistas', 0, 'done', [], true],
  ['competencia', 0, 'done', [], true],
  ['usuario', 0, 'done', ['entrevistas', 'competencia'], true],
  ['registro-d', 1, 'done', ['usuario'], true],
  ['busqueda-d', 1, 'done', ['usuario'], true],
  ['comision', 1, 'blocked', ['competencia'], true],
  ['checkout-d', 1, 'blocked', ['busqueda-d'], true],
  ['perfil-d', 1, 'working', ['usuario'], true, 0.55],
  ['registro', 2, 'working', ['registro-d'], true, 0.68],
  ['buscador', 2, 'working', ['busqueda-d'], true, 0.3],
  ['pagos', 2, 'blocked', [], true],
  ['reservas', 2, 'pending', ['buscador', 'perfil-d'], false],
  ['whatsapp', 2, 'pending', ['registro'], false],
  ['panel', 2, 'pending', ['perfil-d', 'comision'], false],
  ['prueba-users', 3, 'pending', ['reservas', 'registro'], false],
  ['prueba-pagos', 3, 'pending', ['pagos', 'checkout-d'], false],
  ['velocidad', 3, 'pending', ['buscador'], false],
  ['landing', 4, 'pending', ['usuario'], false],
  ['tiendas', 4, 'pending', ['prueba-users', 'prueba-pagos', 'velocidad'], false],
  ['anuncio', 4, 'pending', ['tiendas', 'landing'], false],
];

/** Título y misión de cada tarea. */
const TASKS: Record<DemoLang, Record<string, [title: string, goal: string]>> = {
  es: {
    entrevistas: ['Entrevistas a 8 usuarios', 'Entrevista a 8 personas que reservan servicios y resume sus 3 dolores principales'],
    competencia: ['Análisis de la competencia', 'Compara 6 apps de reservas y di qué hace cada una mejor y peor'],
    usuario: ['Definir el usuario principal', 'Elige al usuario principal con lo aprendido en entrevistas y competencia'],
    'registro-d': ['Flujo de registro', 'Diseña un registro de 2 pasos con Google o correo'],
    'busqueda-d': ['Pantalla de búsqueda', 'Diseña la búsqueda con filtros por zona, precio y horario'],
    comision: ['Modelo de comisiones', 'Propón a quién cobrarle la comisión y cuánto, con números'],
    'checkout-d': ['Diseño del pago', 'Diseña el pago en 3 pantallas como máximo'],
    'perfil-d': ['Perfil del proveedor', 'Diseña el perfil del proveedor con galería de fotos y reseñas'],
    registro: ['Registro e inicio de sesión', 'Construye el registro y el inicio de sesión según el diseño aprobado'],
    buscador: ['Buscador con filtros', 'Construye el buscador con filtros y disponibilidad real'],
    pagos: ['Pagos con tarjeta', 'Conecta la pasarela de pagos para cobrar con tarjeta'],
    reservas: ['Reservas y calendario', 'Construye las reservas con calendario del proveedor'],
    whatsapp: ['Avisos por WhatsApp', 'Envía avisos por WhatsApp al reservar y un día antes'],
    panel: ['Panel del proveedor', 'Construye el panel donde el proveedor ve reservas y cobros'],
    'prueba-users': ['Prueba con 5 usuarios reales', 'Prueba la app con 5 usuarios reales y reporta dónde se traban'],
    'prueba-pagos': ['Prueba de pagos de punta a punta', 'Prueba un pago real de punta a punta, incluido el reembolso'],
    velocidad: ['Revisión de velocidad en celular', 'Mide la velocidad en un celular de gama media y corrige lo lento'],
    landing: ['Página de lanzamiento', 'Arma la página de lanzamiento con la lista de espera'],
    tiendas: ['Publicar en App Store y Play Store', 'Publica la app en App Store y Play Store'],
    anuncio: ['Anuncio a la lista de espera', 'Avísale a la lista de espera que ya pueden reservar'],
  },
  en: {
    entrevistas: ['Interviews with 8 users', 'Interview 8 people who book services and sum up their top 3 pain points'],
    competencia: ['Competitor review', 'Compare 6 booking apps and say what each one does best and worst'],
    usuario: ['Define the main user', 'Pick the main user based on what the interviews and the competitor review taught us'],
    'registro-d': ['Sign-up flow', 'Design a 2-step sign-up with Google or email'],
    'busqueda-d': ['Search screen', 'Design search with filters for area, price and time'],
    comision: ['Commission model', 'Propose who pays the commission and how much, with numbers'],
    'checkout-d': ['Checkout design', 'Design checkout in 3 screens at most'],
    'perfil-d': ['Provider profile', 'Design the provider profile with a photo gallery and reviews'],
    registro: ['Sign-up and log-in', 'Build sign-up and log-in following the approved design'],
    buscador: ['Search with filters', 'Build search with filters and real availability'],
    pagos: ['Card payments', 'Connect the payment provider so customers can pay by card'],
    reservas: ['Bookings and calendar', "Build bookings with the provider's calendar"],
    whatsapp: ['WhatsApp notifications', 'Send WhatsApp notifications on booking and one day before'],
    panel: ['Provider dashboard', 'Build the dashboard where providers see their bookings and payouts'],
    'prueba-users': ['Test with 5 real users', 'Test the app with 5 real users and report where they get stuck'],
    'prueba-pagos': ['End-to-end payment test', 'Run a real payment from start to finish, including a refund'],
    velocidad: ['Mobile speed check', 'Measure speed on a mid-range phone and fix whatever feels slow'],
    landing: ['Launch page', 'Build the launch page with the waitlist'],
    tiendas: ['Publish to App Store and Google Play', 'Publish the app on the App Store and Google Play'],
    anuncio: ['Waitlist announcement', 'Tell the waitlist they can start booking'],
  },
};

const BLOCKERS: Record<DemoLang, NonNullable<ProjectGraphInput['blockers']>> = {
  es: [
    {
      nodeId: 'comision',
      kind: 'decision',
      question: '¿A quién le cobramos la comisión?',
      options: ['Al proveedor (10 % por reserva)', 'Al cliente (cargo de servicio)'],
      accessLabel: null,
    },
    {
      nodeId: 'checkout-d',
      kind: 'review',
      question: 'Terminé el diseño del pago en 3 pantallas. Revísalo antes de que lo construyamos.',
      options: ['Aprobar', 'Pedir cambios'],
      accessLabel: null,
    },
    {
      nodeId: 'pagos',
      kind: 'access',
      question: 'Necesito acceso a la cuenta de la pasarela de pagos para cobrar con tarjeta.',
      options: [],
      accessLabel: 'Clave de la pasarela de pagos',
    },
  ],
  en: [
    {
      nodeId: 'comision',
      kind: 'decision',
      question: 'Who should pay the commission?',
      options: ['The provider (10% per booking)', 'The customer (service fee)'],
      accessLabel: null,
    },
    {
      nodeId: 'checkout-d',
      kind: 'review',
      question: 'I finished the 3-screen checkout design. Please review it before we build it.',
      options: ['Approve', 'Request changes'],
      accessLabel: null,
    },
    {
      nodeId: 'pagos',
      kind: 'access',
      question: 'I need access to the payment provider account so customers can pay by card.',
      options: [],
      accessLabel: 'Payment provider key',
    },
  ],
};

/** Lo que el equipo ya contó antes de que llegues. */
const MESSAGES: Record<DemoLang, Array<[nodeId: string, text: string]>> = {
  es: [
    ['entrevistas', 'Listo. El dolor #1 es no saber si hay disponibilidad antes de llamar.'],
    ['competencia', 'Revisé 6 apps. Ninguna muestra disponibilidad en tiempo real.'],
    ['usuario', 'Elegimos al cliente que reserva desde el celular, entre semana.'],
    ['registro-d', 'Registro en 2 pasos, con Google o con correo.'],
    ['busqueda-d', 'Filtros por zona, precio y horario disponible.'],
    ['perfil-d', 'Armando la galería de fotos y las reseñas. Mañana te lo paso para revisar.'],
    ['registro', 'Ya entra con Google. Me falta el correo de bienvenida.'],
    ['buscador', 'Los filtros ya responden. Ahora conecto la disponibilidad real.'],
  ],
  en: [
    ['entrevistas', "Done. Pain point #1 is not knowing if there's availability before calling."],
    ['competencia', 'Reviewed 6 apps. None of them shows availability in real time.'],
    ['usuario', 'We picked the customer who books from their phone on weekdays.'],
    ['registro-d', '2-step sign-up, with Google or email.'],
    ['busqueda-d', 'Filters for area, price and available times.'],
    ['perfil-d', "Putting together the photo gallery and reviews. I'll send it over for review tomorrow."],
    ['registro', 'Google log-in works. Still missing the welcome email.'],
    ['buscador', 'Filters are working. Now hooking up real availability.'],
  ],
};

/** El grafo completo, listo para `PUT /api/projects/<demoProjectId(lang)>`. Devuelve una copia nueva. */
/** El grafo de la demo: cada nodo trae su etapa (desde #90 es opcional en `NodeInput`; la demo siempre la dice). */
export type DemoGraph = Omit<ProjectGraphInput, 'nodes'> & { nodes: Array<NodeInput & { stage: string }> };

export function demoProject(lang: DemoLang = 'es'): DemoGraph {
  const team = new Map(ROWS.map(([id, stage, , , staffed]) => [id, staffed ? TEAMS[lang][stage]! : null]));
  return {
    name: lang === 'en' ? 'Booking marketplace' : 'Marketplace de reservas',
    lang,
    stages: DEFAULT_STAGES.map((s, i) => ({ id: s.id, name: STAGE_NAMES[lang][i]! })),
    nodes: ROWS.map(([id, s, status, deps, , progress]): NodeInput & { stage: string } => {
      const [title, goal] = TASKS[lang][id]!;
      return {
        id,
        stage: DEFAULT_STAGES[s]!.id,
        title,
        status,
        progress: progress ?? (status === 'done' ? 1 : 0),
        team: team.get(id) ?? null,
        goal,
        reportUrl: null,
        link: null,
        deps: [...deps],
      };
    }),
    blockers: BLOCKERS[lang].map((b) => ({ ...b, options: [...(b.options ?? [])] })),
    messages: MESSAGES[lang].map(([nodeId, text]) => ({ nodeId, text, from: demoSignature(lang, team.get(nodeId) ?? null) })),
  };
}
