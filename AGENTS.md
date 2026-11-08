# AGENTS.md — Certificate Admin Console

Guidance for AI tools and humans working in this repository.

## Commands

- `npm install` — install dependencies (`express`, `better-sqlite3`, `vue`, `vite`).
- `npm run setup` — migrate schema + seed demo data into `server/data.db` (idempotent).
- `npm start` — setup + `vite build` + run Express (app + API) on `:3000`, serving `dist/`.
- `npm run dev` — setup + Vite dev server (:5173, `/api` proxied to :3000).
- `npm run verify` — isolated temp DB; spawns server on `:3123`; runs A1-A7 checks; should print "38 passed".
- `npm run seed:100k` — add 100k certificate rows for a tenant (`--tenant east|west`, `--count N`). Does not modify demo rows.

## Conventions & constraints

- Backend: Node 22 ESM (`"type": "module"`), Express + better-sqlite3 (synchronous, WAL).
  Keep transactions synchronous inside `db.transaction(() => ...)()`.
- Frontend: Vue 3 + Vite (web/ root). State-based navigation; no vue-router.
- DB schema lives in `server/db.js` (`SCHEMA`). Add columns/tables there; `npm run setup`
  is idempotent (seed skips if admins exist).
- Tenant scoping is enforced in SQL via `req.actor.tenant_id`; never write cross-tenant
  queries. Cross-tenant detail must 404 (non-revealing), bulk must fail before any write.
- Actor header: `X-User: alice@east.test | bob@west.test`.
- Idempotency: `Idempotency-Key` header + `idempotency_keys` (UNIQUE(tenant_id, key)).
  Same key + different payload = 409.
- DST: store UTC epoch; precompute `local_date` (tenant tz) at write time (see helpers.js).
- Serial format: `<SLUG-UPPER>-<YYYY>-<000001>`.
- Export: declared BEFORE `/certs/:id` (route order matters), streams on a dedicated
  readonly connection, yields between chunks (keeps list responsive during export).
- Verification: extend `server/scripts/verify.js`, keep `npm run verify` green for
  every acceptance scenario. Prefer API-level checks.
- Do not add comments unless they explain a non-obvious decision (see DESIGN.md).
- `ai/` evidence and `written-answers.md` (Section 6) must not be edited by AI:
  Section 6 answers are candidate-authored, without AI assistance.