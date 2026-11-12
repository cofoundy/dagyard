# Decisión con plazo (#131)

## Problema

El dueño de una fábrica de agentes necesita que una corrida larga no se detenga cada vez que un agente le pregunta algo, porque no está mirando las 48 horas; sabremos que funciona cuando una pregunta con plazo vencido se resuelva sola y su rama siga (línea base: espera infinita; meta: el agente sigue dentro de ~1 min del plazo).

Cita: André, 2026-11-11 (cofoundy-orchestrator#202, decisión 2): «Pueden avanzar solas, sí, por default, todas excepto las que dijiste» — las excepciones: plata, mensajes al cliente, marca y producción.

Mecanismos sugeridos (abiertos): `wait --timeout` en el agente con el default escrito por `msg` (diagnóstico de la fábrica, sección d, fila 4).

## Actores y recorrido

- **Dueño (André, PM).** Hoy: abre la ficha, ve «Necesita tu decisión» y los botones; nada le dice que el trabajo está detenido por él ni qué pasa si no contesta. Con la feature: bajo la pregunta lee hasta cuándo y qué rige; el botón del default dice «por defecto»; si vuelve tarde, la respuesta dice «Rigió la opción por defecto» y el mensaje del servidor lo cuenta en la tarea.
- **Agente del sitio (`/cto`).** Hoy: `dagyard wait` bloquea para siempre o sale 2 con `--timeout` y tiene que decidir solo, sin dejar rastro en el cielo. Con la feature: `block --default A --due 4h`; `wait` le devuelve `A` igual que si el dueño hubiera elegido, con un aviso en stderr.
- **La fábrica (`/factory`).** Lee `watch`: ve `respondieron «A»` como cualquier respuesta; `--json` trae `by`.
- **Cliente final (Macondo).** No ve Dagyard. Lo protege la regla: lo que le llega a él no lleva default.

## Alternativas

1. **No hacer nada / manual**: el agente usa `wait --timeout` y escribe su elección con `msg`. Cuesta: el cielo sigue diciendo «Te espera» después del plazo (mentira), el dueño puede contestar tarde y contradecir lo que el agente ya hizo, y cada sitio reimplementa el protocolo.
2. **Default en el agente con resolución por API** (`resolve` con la llave de agente). Rompe la regla de que solo el dueño resuelve y depende de que el agente siga vivo al vencer.
3. **Default en el servidor (elegida)**: el plazo vive en el bloqueante; la alarma del `Store` lo aplica aunque el agente haya muerto, el cielo deja de decir «Te espera» y el dueño no puede contestar después sobre algo ya aplicado (409 «ya resuelto»).
4. **Recordatorio sin default**: avisar más fuerte en vez de avanzar. No cumple la decisión de André.

## Pre-mortem

| Actor | Por qué fracasó a los 3 meses | Señal temprana | Mitigación |
|---|---|---|---|
| Dueño | Un default de plata o de cliente se aplicó solo | Un mensaje «sigo con…» en una tarea de pagos o actas | La regla va en el protocolo del sitio (kickoff del puente) y en la ayuda del CLI; un acceso nunca lleva default |
| Dueño | No entendió que la decisión se iba a tomar sola | Responde después y se sorprende del 409 | La línea del plazo con hora absoluta bajo la pregunta; la respuesta dice «Rigió la opción por defecto» |
| Agente | La alarma no corrió y esperó para siempre | Un bloqueante con `dueAt` vencido y `open` | La alarma se re-arma tras cada apertura y tras cada disparo; `wait` sigue funcionando igual |
| Fábrica | Confundió un default con una respuesta del dueño | — | `resolution.byDefault` en el snapshot y los eventos |

## Matriz de entradas

| Caso | Qué ve el dueño | ¿Falla? |
|---|---|---|
| Plazo en 1 h, 22:00 | «Si no respondes antes de hoy, 23:00, sigue con «Local».» | no |
| Plazo cruza medianoche (22:00 → 08:00) | «antes de mañana, 8:00» | no |
| Plazo en 3 días | «antes de sáb 14 nov, 8:00» (día y fecha) | no |
| Plazo vencido, alarma aún no corrió (segundos) | «Sin respuesta a tiempo: en un momento rige «Local».» | no: no promete una hora pasada |
| Opción de 120 caracteres como default | El botón parte la línea; la marca «por defecto» va al final | revisar en navegador |
| Revisión con default «Aprobar» | La línea del plazo; la marca no (la revisión no lista botones por opción) | aceptado |
| Acceso | Nunca lleva plazo (400 en la API, 64 en el CLI) | no |
| Zona horaria del dueño distinta del agente | Hora local del navegador; el plazo viaja en ISO UTC | no |
| Proyecto en inglés | «If you don’t answer by tomorrow, 8:00 AM, it goes with “Local”.» | no |

Benchmark: `research/2026-11-11-decision-con-plazo-benchmark.md`.
