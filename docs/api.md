# API de Dagyard v0

> Contrato entre el Worker (`apps/worker`, sitio `nucleo`), la UI (`apps/web`, sitio `cielo`) y el CLI
> (`packages/cli`, sitio `cli`). Los tipos exactos viven en `packages/model/src/types.ts` y mandan
> sobre esta prosa. Importa todo desde `@dagyard/model` (`workspace:*`): tipos, validación, `applyEvent`,
> `nextStartable`, `goalLine` y la demo (`demoProject()`).

## Convenciones

- Base: el mismo origen que sirve la UI (`https://<worker>.workers.dev`). Todas las rutas cuelgan de `/api`.
- JSON en ambas direcciones (`Content-Type: application/json`). Fechas en ISO 8601 UTC.
- Ids: slugs `[a-z0-9][a-z0-9-]*` de hasta 64 caracteres (`marketplace-reservas`, `pagos`). Si creas un
  nodo o proyecto sin `id`, el servidor lo deriva del título con `slugify()` y responde `409` si ya existe.
  Bloqueantes y mensajes llevan ids generados (`b_…`, `m_…`).
- Errores: siempre `{"error": {"code": "…", "message": "…"}}`, con el mensaje en español.

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `invalid` | el body no pasa la validación de `@dagyard/model` |
| 400 | `cycle` | la arista o el grafo cerraría un ciclo |
| 401 | `unauthorized` | sin credencial o credencial inválida |
| 403 | `forbidden` | credencial válida, rol equivocado (p. ej. un agente que intenta resolver) |
| 404 | `not_found` | proyecto, nodo o bloqueante inexistente |
| 409 | `conflict` | id repetido; resolver un bloqueante ya resuelto; cambiar el `status` de un nodo con un bloqueante abierto, o declararlo `done` en un `PUT`; un agente que haría desaparecer un bloqueante, abierto o resuelto (`PUT` que quita su tarea o `DELETE` del nodo); o un `PUT` con `If-None-Match: *` sobre un proyecto que ya existe |
| 500 | `internal` | lo demás |
| 503 | `unavailable` | el servidor se está reiniciando (un deploy) y no escribió nada, o la escritura quedó con su `Idempotency-Key`: repetir con la misma clave es seguro |
| 503 | `overloaded` | el servidor está sobrecargado: espera antes de reintentar (reintentar enseguida empeora) |
| 503 | `uncertain` | el servidor se reinició a mitad de una escritura sin `Idempotency-Key` y no sabe si quedó: revisa antes de repetirla |

### Idempotency-Key y reintentos

Toda escritura (`POST`, `PUT`, `PATCH`, `DELETE`) acepta el header opcional `Idempotency-Key` (1 a 200
caracteres visibles; el CLI manda un uuid nuevo por invocación y el mismo en cada reintento). El Store
registra la clave en la misma transacción que la escritura, por proyecto, con una huella del pedido: un
HMAC (con `VAULT_KEY`) del método, la ruta con su query y el cuerpo **crudo**, calculado antes de parsearlo,
así no cambia entre versiones del Worker y el valor de un acceso nunca se guarda en claro. Repetir la clave
con los mismos bytes devuelve el mismo status y el mismo cuerpo que la primera vez, sin volver a escribir
(sus eventos se vuelven a repartir y el tiempo real ignora los que ya mandó). La misma clave con otra ruta u
otro cuerpo, aunque sea el mismo JSON con otro orden, → `409`. Una escritura que falló (4xx) no gasta la
clave. Las claves se olvidan a las 24 h.

Si un deploy reinicia el Store en medio de una escritura, el Worker la reintenta (≈1 s, con jitter) **solo
si trae clave**; sin clave responde `503 uncertain` (reaplicar a ciegas podría duplicarla o pisar una
escritura posterior). Agotados los intentos, `503 unavailable`. Sobrecargado, `503 overloaded`, sin
reintentar.

El CLI reintenta dos veces (≈300 ms y ≈900 ms, con jitter de ×0,5 a ×1,5) los cortes de red y los `503
unavailable` (o un `503` sin cuerpo de error, que no llegó al Worker). `overloaded`, `uncertain` y los demás
errores no se reintentan.

## Auth

Dos credenciales, ambas secrets del Worker. Ninguna se commitea ni se pega en Basalt o un issue.

| Rol | Secret del Worker | Dónde vive en la Mac | Quién la usa |
|---|---|---|---|
| `owner` | `OWNER_TOKEN` | `~/.config/dagyard/owner-token` (chmod 600) | la UI (el humano) |
| `agent` | `AGENT_KEY` | `~/.config/dagyard/agent-key` (chmod 600) | el CLI y la fábrica |

Formas de presentarla (el servidor prueba en este orden):

1. Header `Authorization: Bearer <token>` — el CLI usa esta.
2. Cookie `__Host-dagyard_session` (httpOnly, Secure, SameSite=Lax, `Path=/`, sin `Domain`), que crea
   `POST /api/session`. La UI usa esta: el humano pega el token una vez y el navegador lo recuerda; el
   WebSocket la manda solo. Solo vale como `owner`. El prefijo `__Host-` impide que otro subdominio
   plante una cookie con ese nombre.
3. Solo en el upgrade del WebSocket, para clientes sin cookie: subprotocolo
   `new WebSocket(url, ['dagyard', 'token.' + token])` (el servidor responde `Sec-WebSocket-Protocol: dagyard`, o el mismo `token.<token>` si no se ofreció `dagyard`,
   y el token no queda en ninguna URL), o, como último recurso, la query `?token=<token>`.

Qué puede cada rol: los dos leen y escriben el grafo y los mensajes. **Resolver un bloqueante es solo
del `owner`** (es el humano quien desbloquea). **Recibir el valor de un acceso es solo del `agent`**
(en `wait`); el valor nunca viaja en snapshots, listados ni eventos, y se guarda cifrado (AES-GCM, amarrado a su proyecto y bloqueante) en el Durable Object `Store` (SQLite).
Sin el secret `VAULT_KEY`, resolver un acceso, recibir su valor o mandar una escritura con `Idempotency-Key` responde `500`: nunca se guarda ni se entrega en claro.

### Sesión (UI)

| Método y ruta | Body | Respuesta |
|---|---|---|
| `POST /api/session` | `{"token": "<owner-token>"}` | `204` + `Set-Cookie`. Token malo (o la clave del agente) → `401` |
| `DELETE /api/session` | — | `204`: cierra **esa** sesión en el servidor y borra la cookie. Sin cookie, también `204` |
| `DELETE /api/session?all=1` | — | `204`: cierra **todas** las sesiones. Exige credencial de dueño (cookie viva o Bearer): sin ella `401`, con la del agente `403`, con cookie y un `Origin` ajeno `403` |
| `GET /api/me` | — | `{"role": "owner" \| "agent"}` o `401` |

Cada login abre una sesión nueva: la cookie lleva un id aleatorio de 256 bits (base64url) y el Durable
Object `Store` guarda solo su SHA-256, con su vencimiento a los **30 días** (el mismo `Max-Age` de la
cookie) y una huella del `OWNER_TOKEN`. Una sesión cerrada, vencida o abierta con un `OWNER_TOKEN` que
ya se rotó responde `401` aunque alguien haya copiado la cookie; la UI vuelve a pedir la clave. Las
vencidas se borran solas al abrir otra sesión o al intentar usarlas. Un WebSocket abierto con esa
cookie también se cierra (ver §Tiempo real).

**Escrituras con la cookie:** como `workers.dev` está en la Public Suffix List, el «sitio» de la preview es
`cofoundy-dev.workers.dev`: cualquier otro Worker de la cuenta es el mismo sitio y `SameSite=Lax` no lo frena. Por eso, si la auth vino por la cookie y el
método no es `GET`/`HEAD`, un `Origin` presente que no esté permitido (mismo origen, `ALLOWED_ORIGINS`
o localhost en dev; un origen opaco `null` nunca) responde `403 forbidden`. Sin `Origin` pasa: un
navegador siempre lo manda en una petición entre orígenes. Bearer no mira el `Origin`.

## Rutas

Sin auth: solo `GET /api/health` → `200 {"ok": true, "version": "<sha corto>"}`. Todo lo demás exige rol.

### Proyectos

| Método y ruta | Body | Respuesta |
|---|---|---|
| `GET /api/projects` | — | `{"projects": ProjectSummary[]}` (con conteos por estado y bloqueantes abiertos) |
| `POST /api/projects` | `ProjectInput` (`name`, `id?`, `lang?`, `stages?`) | `201 Project`. Sin `lang`, `en`; sin `stages` usa las 5 por defecto con su nombre en ese idioma (los ids son los mismos en los dos: `descubrimiento`, `diseno`, `construccion`, `pruebas`, `lanzamiento`) |
| `GET /api/projects/:pid` | — | `ProjectSnapshot` (ver abajo) |
| `PUT /api/projects/:pid` | `ProjectGraphInput` | `200 ProjectSnapshot`. Crea el proyecto o **reemplaza** el grafo entero (idempotente). Lo usan la semilla (con el token del dueño) y `dagyard import`. Con `If-None-Match: *` solo crea: `409` si el proyecto ya existe, sin tocarlo. Si quien llama es `agent` conserva los bloqueantes, los mensajes y la antigüedad de las tareas (ver abajo) y responde `409` si el grafo nuevo quita una tarea que tiene alguno. Emite `project.replaced` |
| `PATCH /api/projects/:pid` | `{"name"?, "lang"?, "stages"?}` | `200 Project`. Emite `project.updated` |
| `DELETE /api/projects/:pid` | — | `204`. Solo `owner` |
| `GET /api/projects/:pid/next` | — | `NextResult`: `{"node": DagNode \| null, "goalLine": "/goal …" \| null}` |
| `GET /api/projects/:pid/events?since=<seq>` | — | `{"events": DagEvent[]}` con `seq > since`, máx. 500 (recuperación sin WebSocket). Si `since` está bajo el piso de eventos (la demo los poda), `{"events": [], "resync": true}`: vuelve a pedir el snapshot |

**Idioma del proyecto (#77).** `Project.lang` (`en` | `es`) es el idioma de lo que se escribe solo: las
etapas por defecto, las misiones y etapas de `dagyard import`, las opciones por defecto de una revisión y
de `dagyard sync`, y los mensajes que firma el servidor. Lo fija el proyecto, nunca el `LANG` de quien lo
toca. Un proyecto nuevo nace en `en` (POST o PUT sin `lang`); un `PUT` sin `lang` sobre uno existente
conserva el suyo. Un proyecto guardado antes del campo (`dagyard`, las demos sembradas antes) se lee `es`
(la demo inglesa, `en`) y nadie lo reescribe: cambia solo si un POST, PUT o PATCH manda `lang`. El idioma
cambia los nombres de las etapas por defecto, nunca sus ids.

`ProjectSnapshot` = `{ project, nodes, edges, blockers, messages, teams, seq }`: nodos, aristas y bloqueantes
completos (abiertos y resueltos, sin valores de acceso), los últimos 200 mensajes en orden cronológico y
el `seq` del último evento. Con ese `seq` la UI abre el WebSocket.

Resolver es solo del dueño, así que un agente no puede hacer desaparecer ni una pregunta abierta ni una
respuesta ya dada. Con la API key, el `PUT` sobre un proyecto existente **conserva** cada bloqueante
(abierto o resuelto) con su id, su respuesta y el valor de su acceso, así un `wait` en curso lo sigue
encontrando. Las tareas que tienen un bloqueante abierto quedan `blocked` las declare así o no. Un
bloqueante del body igual a uno conservado **abierto** (misma tarea, `kind`, `question`, `options` y
`accessLabel`) no se duplica: re-importar el mismo archivo es idempotente. Uno igual a uno ya **resuelto**
entra como bloqueante nuevo y abierto (re-preguntar nunca se descarta en silencio), y la respuesta anterior
se conserva al lado. Si el grafo nuevo quita una tarea que tiene algún bloqueante, `409` y no se toca nada.
Ese mismo `PUT` conserva tal cual (id, firma y fecha) los mensajes de las tareas que siguen, incluido el
mensaje del sistema de cada respuesta, y el `createdAt` de cada tarea que ya existía, así
`next` no cambia de orden al re-importar. También conserva el `link` de cada tarea que ya existía cuando el body
no trae la clave (un import no la manda); `"link": null` explícito sí lo borra. Un mensaje del body igual a uno conservado (misma tarea, `from`,
`text` y `reportUrl`; sin `from`, basta tarea, `text` y `reportUrl`, porque la firma sale del equipo
actual y puede haber cambiado) no se duplica; los mensajes de una tarea quitada se van con ella. El dueño reemplaza
el grafo entero siempre (sus bloqueantes y mensajes se recrean desde el body con otros ids y fecha nueva).

Con cualquier llamante, una tarea declarada `done` que quedaría `blocked` (por un bloqueante abierto
conservado o del mismo body) responde `409` sin tocar nada, igual que el `PATCH`: no se cierra una tarea
con una pregunta abierta. Si lo único que la bloquearía es una pregunta que el dueño ya respondió y el
archivo vuelve a hacer, el `409` lo dice: quítala de `blockers` o no cierres la tarea.

`dagyard import` crea proyectos nuevos con un solo `PUT` exclusivo (`If-None-Match: *`): si el proyecto
ya existe falla, y el «¿ya existe?» se decide en la misma transacción que escribe, así dos imports a la vez
no se pisan. `--replace` manda el `PUT` sin ese header. El import nunca manda `blocked` ni `blockers`: una tarea `blocked` en el
archivo queda `pending`, y si pide algo a una persona (su status nombra una escalación, decisión o aprobación,
o no espera a ninguna otra tarea) deja un aviso en `warnings`; el agente hace la pregunta en vivo con
`dagyard block` (una pregunta generada desde el archivo se reabriría en cada `--replace`).

`next` elige, entre los nodos `pending` con todas sus dependencias `done`, el de la etapa más temprana y,
a igualdad, el más antiguo (`nextStartable()` del modelo). `goalLine` es `/goal <goal o título>`.

### Nodos y aristas

| Método y ruta | Body | Respuesta |
|---|---|---|
| `POST /api/projects/:pid/nodes` | `NodeInput` (`stage`, `title`, `id?`, `status?`, `progress?`, `team?`, `goal?`, `reportUrl?`, `link?`, `deps?`) | `201 DagNode`. Emite `node.added` + un `edge.added` por cada dep |
| `PATCH /api/projects/:pid/nodes/:nid` | `NodePatch` (`stage?`, `title?`, `status?`, `progress?`, `team?`, `goal?`, `reportUrl?`, `link?`, `teamId?`) | `200 DagNode`. Emite `node.updated`. Un `teamId` de un equipo que no existe lo crea (arrancado ahora, nombre desde el slug) |
| `DELETE /api/projects/:pid/nodes/:nid` | — | `204`. Borra sus aristas, bloqueantes y mensajes. `409` si quien llama es `agent` y el nodo tiene ≥1 bloqueante (abierto o resuelto). Emite `node.removed` |
| `POST /api/projects/:pid/edges` | `{"from", "to"}` | `201 Edge`; `400 cycle` si cierra un ciclo; `409` si ya existe. Emite `edge.added` |
| `DELETE /api/projects/:pid/edges?from=<id>&to=<id>` | — | `204`. Emite `edge.removed` |

`link` es el detalle técnico de la tarea: la URL (http o https) del issue o del PR. Es opcional
(`null` por defecto, `null` en un `PATCH` lo borra) y la UI lo ofrece en la ficha como «Detalle técnico»,
debajo del informe, sin mostrar la URL. En el `PUT` del grafo, el de un agente conserva el `link` anterior si
el body no trae la clave; el del dueño lo reemplaza como todo lo demás.

Reglas del servidor al escribir un nodo:

- `status: "done"` fija `progress = 1`. `status: "working"` desde `pending` arranca en `progress = 0`
  salvo que mandes otro.
- `status: "blocked"` no se pone a mano: lo pone abrir un bloqueante. Un `PATCH` con `blocked` → `400`.
  Mientras haya un bloqueante abierto, un `PATCH` de `status` → `409`.
- `startedAt` y `doneAt` los pone el servidor, nunca el cliente (#75): `startedAt` la primera vez que la
  tarea pasa a `working` (vuelve a `null` si regresa a `pending`), `doneAt` al pasar a `done` (se limpia si
  deja de estarlo). El `PUT` del grafo los conserva, junto con `teamId`, en las tareas que siguen.
- El CLI mapea `start` → `PATCH {"status": "working"}`, `progress <n>` → `PATCH {"progress": n}` y
  `done` → `PATCH {"status": "done"}`.

### Equipos de la fábrica (#75)

| Método y ruta | Body | Respuesta |
|---|---|---|
| `PUT /api/projects/:pid/teams/:tid` | `TeamPatch` (`name?`, `nodeIds?`, `requestedAt?`, `startedAt?`, `closedAt?`, `outcome?`) | `200 Team`. Upsert parcial de un sitio de `/factory`; `tid` = slug (minúsculas, números y guiones, máx. 64). Las fechas son las del sitio, no las de la escritura, para poder traer la historia después (`dagyard import-ledger`). Sin cambios no escribe ni emite nada (idempotente); si cambia algo, emite `team.updated` |

Un equipo es lo que la vista en el tiempo dibuja como un carril. El CLI: `dagyard team start <sitio> --name
<Nombre> [--issues 45,46]`, `dagyard team close <sitio> --outcome merged|pr-open|stopped`, `dagyard start
gh-<n>` (manda `teamId` = `$COFOUNDY_AGENT` o `--site`) y `dagyard import-ledger [<sites.jsonl>]`.

En el `PUT` del grafo, cada bloqueante del body acepta `createdAt` opcional (una fecha futura queda en
ahora): así recrear un proyecto no pierde la hora real de sus preguntas.

### Bloqueantes

| Método y ruta | Body | Respuesta |
|---|---|---|
| `POST /api/projects/:pid/nodes/:nid/blockers` | `BlockerInput` | `201 Blocker`. El nodo pasa a `blocked`. Emite `blocker.opened` + `node.updated` |
| `GET /api/projects/:pid/blockers/:bid` | — | `200 Blocker` (sin valor) |
| `POST /api/projects/:pid/blockers/:bid/resolve` | `ResolveInput` | `200 Blocker`. **Solo `owner`**. Ya resuelto → `409`. Emite `blocker.resolved` + `node.updated` |
| `GET /api/projects/:pid/blockers/:bid/wait?timeout=<s>` | — | long-poll hasta `timeout` (default 25, máx. 25): `200 BlockerWaitResult` |

Tipos de bloqueante (`BlockerInput`):

| `kind` | UI | Body al abrir | Body al resolver |
|---|---|---|---|
| `decision` | Necesita tu decisión | `question`, `options` (1 a 6) | `{"choice": <índice o texto exacto>, "note"?}` |
| `review` | Necesita tu revisión | `question`, `options?` (default en el idioma del proyecto: `["Approve", "Request changes"]` o `["Aprobar", "Pedir cambios"]`) | igual que `decision` |
| `access` | Necesita un acceso | `question`, `accessLabel` (p. ej. «Clave de la pasarela de pagos»), sin `options` | `{"value": "<el secreto>", "note"?}` |

Al resolver: el bloqueante queda `status: "resolved"` con `resolution = {choice, note, hasValue}`,
`resolvedBy: "owner"` y `resolvedAt`; el nodo vuelve a `working` y el servidor agrega un mensaje del
sistema en el idioma del proyecto («Thanks. Picking up where I left off.» / «Gracias. Sigo desde donde me
quedé.») solo si el nodo no tiene otro bloqueante abierto.

`wait` responde apenas el bloqueante se resuelve, o al vencer el `timeout` con el bloqueante todavía
`open` (el CLI vuelve a llamar). `BlockerWaitResult = {blocker, value}`; `value` es el secreto
descifrado **solo** si `kind = access`, está resuelto y el rol es `agent`. Para el `owner` siempre `null`.

### Mensajes

| Método y ruta | Body | Respuesta |
|---|---|---|
| `POST /api/projects/:pid/nodes/:nid/messages` | `MessageInput` (`text` ≤280, `from?`, `reportUrl?`) | `201 Message`. Emite `message.posted` |

Sin `from`, el servidor firma en el idioma del proyecto: `<team> team` o `Agent` (`en`), `Equipo de <team>` o
`Agente` (`es`), según el nodo tenga equipo o no. Si el
mensaje trae `reportUrl` y el nodo no tiene uno, el nodo lo adopta (emite también `node.updated`).

## Tiempo real

Un Durable Object por proyecto guarda los WebSockets (API de hibernación) y reparte cada evento que
emite una escritura. Todas las escrituras de la API, vengan de la UI o del CLI, pasan por ahí.

**Conexión:** `GET /api/projects/:pid/live?since=<seq>` con `Upgrade: websocket`. Auth por cookie, subprotocolo
`token.<token>` (el 101 elige `dagyard` si se ofreció; si no, ese `token.<token>`) o `?token=`. Sin auth → `401` antes del upgrade.

**Origin:** si la auth vino por la cookie, el upgrade exige un header `Origin` que sea el mismo origen
que la URL pedida o uno de la var `ALLOWED_ORIGINS` del Worker (lista por comas, vacía por defecto en
`wrangler.toml`); si no, o sin `Origin`, `403 forbidden`. En dev, si se pide a `localhost`/`127.0.0.1`,
vale cualquier origen localhost. Bearer, subprotocolo y `?token=` no miran el `Origin` (un sitio ajeno no
tiene el token). Un origen opaco (`Origin: null`, `file:`, `data:`) nunca vale, ni desde `ALLOWED_ORIGINS`.
El proxy de Vite (`apps/web/vite.config.ts`) reescribe el `Origin` del upgrade y de las peticiones al de
su target, así la UI en dev funciona contra un Worker local o remoto.

**Sesión viva:** un socket abierto con la cookie se revalida contra el Store antes de cada evento. Si su
sesión se cerró (logout o `?all=1`), venció o es de un `OWNER_TOKEN` rotado, el servidor lo cierra con
código **`4001`** sin mandarle el evento; al reconectar, el upgrade responde `401` y la UI vuelve a pedir
la clave. Para no sumar latencia, una sesión vista viva se confía hasta 30 s: el cierre llega en el primer
evento después de esa ventana. (`4004` = el proyecto se borró.)

**Frames servidor → cliente** (JSON, tipo `ServerFrame`):

```json
{"type": "hello", "projectId": "marketplace-reservas", "seq": 42}
{"type": "event", "event": {"seq": 43, "projectId": "marketplace-reservas", "type": "message.posted",
  "actor": "agent", "at": "2026-10-04T06:01:02.000Z", "payload": {"message": {…}}}}
{"type": "resync", "seq": 900}
{"type": "pong"}
```

Si mandas `since` y hay eventos más nuevos, el servidor los reenvía en orden justo después del `hello`.
Si faltan más de 500, si `since` es mayor que el `seq` actual (p. ej. el proyecto se borró y se volvió a
crear) o si `since` está bajo el piso de eventos, manda `resync`: vuelve a pedir el snapshot. El piso solo sube en
las dos demos (#74): al volver a empezar, se borran sus eventos hasta `seq − 500`; un proyecto que no es demo nunca
pierde eventos. Cliente → servidor: `{"type": "ping"}`
(o el texto `ping`) cuando quieras; el servidor contesta `pong`.

**Eventos** (`DagEvent`, cada uno con `seq` monotónico por proyecto, `actor` y `at`):

| `type` | `payload` |
|---|---|
| `project.replaced` | `{project}` — el grafo entero cambió: vuelve a pedir el snapshot (`needsRefetch()`) |
| `project.updated` | `{project}` |
| `node.added` / `node.updated` | `{node}` (el nodo completo, no un diff) |
| `node.removed` | `{nodeId}` |
| `edge.added` / `edge.removed` | `{edge}` |
| `blocker.opened` / `blocker.resolved` | `{blocker}` (sin valor de acceso) |
| `message.posted` | `{message}` |

La UI aplica cada evento con `applyEvent(snapshot, event)` de `@dagyard/model`: es puro, idempotente
(ignora `seq <= snapshot.seq`) y devuelve un snapshot nuevo. Al reconectar, reabre con el último `seq`.

## Ejemplos

```bash
URL=https://<worker>.workers.dev; KEY=$(cat ~/.config/dagyard/agent-key)
curl -s $URL/api/health                                               # 200 sin auth
curl -s -o /dev/null -w '%{http_code}\n' $URL/api/projects            # 401
curl -s -H "Authorization: Bearer $KEY" $URL/api/projects             # 200
curl -s -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"text": "Ya conecté la pasarela. Falta probar un reembolso."}' \
  $URL/api/projects/marketplace-reservas/nodes/pagos/messages         # 201 y aparece en la UI
```

## La demo

`demoProject()` de `@dagyard/model` es el grafo «Marketplace de reservas» del preview: 20 nodos, 5 etapas
y 3 bloqueantes abiertos (una decisión en «Modelo de comisiones», una revisión en «Diseño del pago» y un
acceso en «Pagos con tarjeta»). El Worker la siembra con `PUT /api/projects/marketplace-reservas`; la UI
puede usarla como fixture local mientras no haya servidor.
