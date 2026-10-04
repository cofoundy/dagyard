# Latencia del tiempo real (#48)

Sonda: `node scripts/qa/realtime.mjs --runs N` contra la preview, proyecto de QA propio (`qa-tiempo-real`, se borra al terminar). Cada medición va del comando del CLI al cambio en el DOM, partida en tramos con el reloj de la misma máquina (ver la cabecera del script).

| Archivo | Condición | Resultado |
|---|---|---|
| `2-tranquila-20.txt` | preview `941f4dc`, loadavg 3,4–3,6 en 12 núcleos | p50 593 ms · máx 664 ms (40 mediciones) |
| `1-cargada-20.txt` | preview `b0afff2`, loadavg 8–11, ~80 procesos de navegador de otros sitios | p50 604 ms · máx 828 ms (40 mediciones) |
| `3-deploy-a.txt` | `wrangler deploy` en medio de la corrida | 8 corridas normales; en la 9 `dagyard msg` responde **500** («Algo falló de nuestro lado») |
| `4-deploy-b.txt` | otro `wrangler deploy` en medio | la página reconecta su WebSocket (2 y luego 4 sockets): **903 ms** y **2666 ms**; el socket de control, que no reconecta, deja de recibir |

En todas, el navegador aporta 0–3 ms (`dom`): el resto es arranque del CLI (~50 ms), conexión TLS al edge (~120 ms, colo EZE) y la escritura con su reparto en el servidor.

**Causa del 1857 ms de `movil` (`INFERRED`: `movil` midió justo después de desplegar `3caa995` y solo dejó el máximo; aquí se reproduce el mecanismo con magnitudes del mismo orden):** la medición se cruzó con el rollout del deploy. Un deploy reinicia los Durable Objects, eso corta los WebSockets de la página, y el evento llega recién cuando la UI reconecta (backoff de 300–500 ms en el primer intento, más si el corte se repite durante el rollout) y lo recupera con `?since=`. No es la carga: con la máquina cargada el máximo fue 828 ms. Tampoco es un cambio del worker: con el mismo código y sin deploy, p50 ~600 ms, igual que en #17 (573 ms).

`4-deploy-b.txt` termina con un error de la sonda: al final del rollout la página perdió su contexto (`window.__qaopen` indefinido). La causa no está verificada; la sonda ahora reinstala el observador y lo anota.
