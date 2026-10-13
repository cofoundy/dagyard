# Dagyard — reglas del repo

- Lee primero `docs/spec/v0.md` y la intención en `~/cofoundy/plugins/cofoundy-orchestrator/docs/intent/2026-10-03-panel-dag-de-la-fabrica.md` (§1 verbatim manda).
- Público: PMs. La UI no muestra jerga técnica. Idioma: inglés por defecto y español si el sistema está en español (web: `navigator.languages`; CLI y mod: `LC_ALL`/`LC_MESSAGES`/`LANG`). Todo texto visible pasa por el catálogo en/es (web: `apps/web/src/i18n/`); el español va con tildes y tuteo, nunca voseo. Lo que escribe un usuario no se traduce (intención §1 Mensaje 8, #73).
- La referencia visual es `design/preview-constelacion.html` de `cofoundy/dagyard-design` (privado; clónalo al lado como `../dagyard-design`; en comentarios, `dagyard-design/<ruta>`): igual de pulido o mejor. Anti-referencias: `design/2026-10-03-anti-ref-*.png` del mismo repo.
- Solo código (#127): las imágenes viven en `docs/media/` (las del README) y en ningún otro lado; las capturas de QA van al issue o a Basalt, nunca al repo; los prototipos de diseño, a `cofoundy/dagyard-design`. El check `repo-weight` de CI falla si el árbol pasa de 8 MB o entra una imagen fuera de `docs/media/`.
- Stack: Cloudflare Worker + Durable Objects con SQLite (sin D1, #9), Vite + React + three.js, pnpm. Receta de deploy: `~/cofoundy/products/basalt`.
- Gates por exit code: `pnpm typecheck`, `pnpm test`, `pnpm build`. Nunca commitees tokens; el token de dueño vive en `~/.config/dagyard/owner-token`.
- `main` se toca vía PR (products/* = Tier B).
- Dogfooding: este repo es el proyecto «dagyard» en Dagyard (`.dagyard.json`); un sitio sigue `docs/dogfooding.md` (start, msg, block, done sobre su nodo `gh-<issue>`).
