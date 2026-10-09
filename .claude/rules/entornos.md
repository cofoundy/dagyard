# Entornos — Dagyard

| Entorno | URL | Cómo se despliega |
|---|---|---|
| preview | `https://dagyard.cofoundy-dev.workers.dev` | desde `main`: `pnpm build && cd apps/worker && CLOUDFLARE_ACCOUNT_ID=7865fc5defa821d49cc320b17715a398 npx wrangler deploy --var VERSION:$(git rev-parse --short HEAD)` (sin el `--var`, `/api/health` responde `"version":"dev"` y la sonda de efecto no distingue builds; `pnpm --filter … run deploy -- --var …` no lo pasa). Ojo: `pnpm deploy` a secas es otro comando de pnpm. La demo se siembra con `node apps/worker/scripts/seed.mjs <url>` (idempotente). |
| prod | no existe todavía (dominio `dagyard.run` pendiente de compra) | — |

**Regla de deploy** (carrera medida por dogfood el 2026-10-04 16:12Z: dos sitios desplegaron con 6 s de diferencia y ganó el sha más viejo): despliega solo desde un checkout en `origin/main` HEAD recién traído (`git fetch && git checkout --detach origin/main`); después, `/api/health` tiene que dar el sha de `origin/main` en varias llamadas seguidas (durante ~30 s el borde puede alternar entre la versión vieja y la nueva). Si no, vuelve a traer y redespliega. Nunca despliegues desde tu rama.

El account id de Cloudflare de arriba no es un secreto (Cloudflare lo trata como identificador; sin un token no da acceso) y queda en el repo público a propósito.

Secrets del Worker (`wrangler secret bulk`): `OWNER_TOKEN`, `AGENT_KEY`, `VAULT_KEY`; sus valores viven en
`~/.config/dagyard/{owner-token,agent-key,vault-key}` (chmod 600). Nunca en un commit, issue ni en Basalt.
El token de Cloudflare del entorno no tiene permiso de D1: el estado vive en Durable Objects con SQLite (#9).

Verifica: `curl -s <url>/api/health` → 200 con `version` = el sha de `main`; `curl -s -o /dev/null -w '%{http_code}' <url>/api/projects` → 401.

`/api/health` no pasa por el Durable Object `Store`: tras un deploy da el sha nuevo enseguida, pero el `Store` puede seguir con el código viejo ~2 min (medido el 2026-10-09 en #110: deploy 17:57:35Z, el 409 con `reason` apareció a las 17:59:48Z). Si el cambio toca el `Store` (`writes.ts`, `db.ts`), sondea el efecto (la respuesta de la escritura) hasta verlo, no el `health`.
