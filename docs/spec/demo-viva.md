# La demo viva (#74)

> Intención: §1 Mensaje 8 (2026-10-04 14:02): «q la demo tmb sea en english y q sea mas vistoza».
> Issue: cofoundy/dagyard#74. El idioma de la UI lo pone #73 (`lang()` de `apps/web/src/i18n`).

## Qué ve el PM

Abre Dagyard sin proyecto elegido y le aparece la demo en su idioma: «Booking marketplace» si su
navegador está en inglés, «Marketplace de reservas» si está en español. No está quieta: mientras la
mira, el equipo trabaja solo. Las barras avanzan, alguien deja un mensaje corto, una tarea se completa
con su onda y la siguiente arranca. Lo único que no se mueve solo son **las 3 cosas que le esperan**
(una decisión, una revisión y un acceso): esas son suyas. Si las resuelve, el trabajo que esperaba
detrás también arranca. Cuando ya no queda nada que avanzar, la demo vuelve a empezar.

## Las dos demos

| id | idioma | nombre |
|---|---|---|
| `booking-marketplace` | en | Booking marketplace |
| `marketplace-reservas` | es | Marketplace de reservas |

Mismo grafo: mismos ids de tarea, etapas, aristas, estados y los mismos 3 bloqueantes; solo cambia el
texto. `@dagyard/model` exporta `DEMO_PROJECT_IDS`, `demoProjectId(lang)`, `isDemoProject(id)` y
`demoProject(lang)`. `DEMO_PROJECT_ID` sigue siendo la española (compatibilidad). `seed.mjs` siembra las dos.

## El pulso

- **Dónde:** el Durable Object `ProjectRoom` del proyecto, con su **alarma** (nada de cron). Se arma
  cuando un navegador saluda un proyecto demo y se re-arma en cada latido **solo si queda alguien
  conectado**: sin miradas no corre ni cuesta. Deja de re-armarse 30 min después del último saludo
  (una pestaña olvidada no lo mantiene vivo para siempre); un saludo nuevo lo vuelve a armar.
- **Solo demo:** si el id no está en `DEMO_PROJECT_IDS`, el pulso no arma alarma ni escribe. Test.
- **Ritmo:** un latido cada ~3,5 s (con jitter). Cada latido es **una** escritura por el mismo camino
  que la API (Store → eventos → sockets), firmada como agente.
- **Qué hace un latido (función pura en el modelo, testeable sin Worker):**
  - avanza una tarea en progreso (+8 a 18 %), a veces con un mensaje corto del equipo (≤280, del
    idioma de la demo);
  - la completa al llegar a 100 % (con un mensaje de cierre);
  - arranca una tarea pendiente cuyas dependencias están todas listas (y le pone su equipo);
  - nunca toca una tarea con un bloqueante abierto, nunca resuelve ni abre un bloqueante.
- **Fin y reinicio:** sin tareas en progreso ni arrancables, espera un par de latidos y re-siembra el
  grafo inicial con un `replaceGraph` del dueño sobre el mismo id (las 3 cosas vuelven a estar abiertas y
  los mensajes del pulso se van). Nunca borrar y recrear: cambiaría la encarnación y cerraría con 4004 a
  quien está mirando. Test: una página conectada pasa la re-siembra sin 4004.
- **Eventos acotados:** al re-sembrar, se podan los eventos del proyecto demo hasta un piso guardado
  (`max seq - REPLAY_LIMIT`). Un `since` por debajo del piso recibe `resync`, nunca un replay con hueco.
  Un proyecto que no es demo nunca se poda. Tests de los tres casos.
- **Guardrails:** tiempo real ≤3 s intacto; un proyecto que no es demo nunca se toca; un visitante
  que resuelve un bloqueante no pierde su respuesta mientras dure la vuelta.

## Más vistosa

En #74, «más vistosa» es el pulso: la demo deja de estar quieta y la escena que ya existe (ondas,
nacimientos, partículas) se luce con cada cambio. La escena y el travelling **no** se rediseñan aquí:
André pidió a las 14:05 una vista temporal que reemplaza el informe de factory, y ese rediseño lo
define #75 con prototipos.

## Verifica

- `en-US` sin proyecto elegido → abre `booking-marketplace`; `es-PE` → `marketplace-reservas`.
- 60 s con la demo abierta sin tocar nada: ≥3 cambios en vivo (filmstrip en `dagyard-design/docs/qa/demo-viva/`).
- Tras 10 min de pulso, las 3 cosas siguen abiertas (test con alarmas).
- Un proyecto que no es demo con un navegador conectado: cero alarmas, cero escrituras (test).
