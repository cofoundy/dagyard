# Decisión con plazo y opción por defecto: benchmark

Pregunta: un agente le pregunta algo a un PM («¿Postgres local o en la nube?») con opciones. Si el PM no responde antes de un plazo, se aplica una opción por defecto y queda registrado. ¿Cómo lo muestran otros productos antes («se decide sola a tal hora con tal opción») y después («se decidió por defecto»)?

Hallazgo general: casi ningún producto trata el vencimiento como una **decisión con contenido**. La mayoría lo trata como **fallo** (GitHub, Elastic, Power Automate) o como un **estado técnico** (Temporal `TIMEOUT`). Los que mejor lo comunican son los que tienen un reloj visible (Jira SLA) o una acción programada a hora fija (Gmail). Nadie que encontré muestra, junto a la pregunta, «si no respondes, pasa X». Ese hueco es nuestro.

## 1. GitHub Actions: aprobación de despliegue por revisores
- Antes: el job queda en **«Pending»**, con el botón **«Review deployments»**. El revisor elige **«Approve and deploy»** o **«Reject»**. Se puede saltar la espera con **«Start all waiting jobs»** y la confirmación **«I understand the consequences, start deploying.»**
- Plazo: «If a job is not approved within 30 days, it will automatically fail» (doc de GHES 3.5). La UI no muestra cuándo vence. El «Wait timer» (1 a 43.200 min) es otra cosa: es una espera antes de correr, no un plazo de respuesta.
- Copiar: los verbos del botón dicen la consecuencia («Approve **and deploy**»), y saltarse el gate pide una confirmación que nombra el riesgo.
- Evitar: el plazo invisible y el desenlace por defecto en forma de «fallo». El PM nunca se entera de que tenía 30 días.

## 2. Microsoft Power Automate: «Start and wait for an approval»
- El timeout se configura en Settings → Timeout (ISO 8601, por ejemplo `PT1M`). Por defecto vence a los 30 días, el tope de duración de un flujo. Lo que pasa al vencer se arma en una rama paralela con «Configure run after» → **«has timed out»**.
- El aprobador no ve ningún plazo. El vencimiento aparece como paso «timed out» y, según la comunidad, a veces la corrida queda marcada como **failed**. Los autores agregan «Terminate: Succeeded» para que no parezca un error.
- Copiar: el vencimiento es una **rama explícita** con su propia acción. Eso equivale a nuestra opción por defecto.
- Evitar: que el estado por defecto se vea como error. Quien lee el historial no sabe si el flujo «falló» o «decidió».

## 3. PagerDuty: auto-resolve y timeout de acknowledgement
- Configuración: la casilla **«Resolve open incidents after»** (en Assign and Notify). Con el timeout de ack, un incidente reconocido «will re-trigger after a specified amount of time» y vuelve a avisar a los responsables.
- Lo que más vale copiar es el modelo de **escalar antes de resolver solo**: primero re-notifica, después cierra. La doc no muestra el copy del registro (no lo verifiqué).
- Copiar: un aviso intermedio antes del vencimiento (re-notificar al PM), no solo el desenlace.
- Evitar: el auto-resolve configurado a nivel servicio y no visible en el incidente. El que lo mira no sabe que se va a cerrar solo.

## 4. Jira Service Management: SLA en la cola
- Antes: una **cuenta regresiva** por SLA. Verde mientras queda tiempo, y la cola se puede ordenar por «shortest time remaining».
- Después: «For breached SLAs, the amount of time past the goal is shown as a **negative number**», con reloj rojo. El cliente del portal solo ve «at risk» o «breached», sin el número.
- Copiar: la escala de urgencia por color y el orden por lo que vence primero. Para el PM con varias preguntas abiertas, eso es su bandeja.
- Evitar: la cuenta regresiva sola (sin hora absoluta) y el número negativo. Con defaults no hay «retraso»: la decisión ya se tomó.

## 5. Temporal (y Elastic Workflows): human-in-the-loop en código
- Temporal, en su Approval Pattern, espera un signal con un timer. Si gana el timer, el estado queda en **`TIMEOUT`** y el mensaje es «Request {id} timed out». La guía dice: «Define clear timeout behavior such as rejection, escalation, or notification». Advierte que un signal tardío encuentra la espera ya cerrada.
- Elastic `waitForApproval`: por defecto `24h`, «No response fails the step». Solo registra `respondedBy` si alguien respondió.
- Copiar: **registrar quién decidió**. Hay que distinguir «decidió Ana» de «decidió el plazo» y manejar la respuesta tardía de forma explícita, por ejemplo «llegó tarde: ya se aplicó X; ¿quieres cambiarlo?».
- Evitar: un estado técnico (`TIMEOUT`) como texto para el PM.

## Referencias de apoyo
- Gmail «Schedule send»: la acción queda en la carpeta **«Scheduled»** y se revierte con **«Cancel send»** (vuelve a borrador). Es el patrón «esto pasa solo a tal hora, y puedes deshacerlo».
- Google Calendar «Out of office»: hay que elegir explícitamente el comportamiento por defecto entre declinar reuniones nuevas y existentes, solo las nuevas, o no declinar, y el mensaje de rechazo es editable. El default se decide **al crear**, no al vencer.

## Qué se lleva Dagyard a la ficha
1. Antes del plazo, una frase: **«Si nadie responde, se elige «Postgres local» el jue 13 nov a las 18:00»**. Va con la hora absoluta en la zona del PM y, al lado, la relativa («en 3 h»). Ninguno de los productos revisados lo muestra en el punto de decisión.
2. La opción por defecto se marca **dentro de la lista de opciones** con una etiqueta («por defecto»), no en un texto aparte. Así el PM ve qué pasa si no hace nada.
3. Después del plazo: **«Se eligió «Postgres local» por defecto · jue 13 nov 18:00 · nadie respondió»**. Es un estado de decisión, no de error, y nunca dice «falló», «timeout» ni «vencido» en rojo.
4. Quién decidió es un campo propio (PM o plazo), al estilo `respondedBy`, y se puede revertir mientras el agente no haya avanzado (como «Cancel send»). Una respuesta tardía se trata de forma explícita.
5. Aviso antes del vencimiento (como el re-trigger de PagerDuty) y una bandeja ordenada por lo que vence primero (como Jira).

## References & Research Sources
- https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/reviewing-deployments (last-fetched 2026-11-11): Pending, Review deployments, Approve and deploy, bypass.
- https://docs.github.com/en/enterprise-server@3.5/actions/managing-workflow-runs/reviewing-deployments (last-fetched 2026-11-11): «automatically fail» a los 30 días; el dato llegó por buscador, no abrí la página.
- https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments (last-fetched 2026-11-11): Wait timer de 1 a 43.200 min y required reviewers.
- https://www.spguides.com/?p=122063 (last-fetched 2026-11-11): timeout de Power Automate y «has timed out»; es fuente de terceros y llegó por buscador.
- https://collab365.com/blog/overcoming-power-automate-30-day-limits (last-fetched 2026-11-11): tope de 30 días por corrida; es fuente de terceros y llegó por buscador.
- https://docs.pagerduty.com/incident-management/services/configurable-service-settings (last-fetched 2026-11-11): auto-resolve y ack timeout.
- https://confluence.atlassian.com/servicemanagementserver102/sla-display-formats-and-time-frames-1473873983.html (last-fetched 2026-11-11): SLA negativo y colores; llegó por buscador.
- https://docs.temporal.io/design-patterns/approval (last-fetched 2026-11-11): estado TIMEOUT, guía de comportamiento por defecto y signal tardío.
- https://www.elastic.co/docs/explore-analyze/workflows/steps/wait-for-approval (last-fetched 2026-11-11): 24h por defecto, «No response fails the step».
- https://support.google.com/mail/answer/9214606 (last-fetched 2026-11-11): Schedule send, carpeta Scheduled, Cancel send.
- https://getclockwise.com/outofoffice (last-fetched 2026-11-11): opciones de auto-decline de Google Calendar; es fuente de terceros y llegó por buscador.
