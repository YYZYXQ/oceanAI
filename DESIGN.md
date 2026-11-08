# Certificate Admin Console — Design

Technical interview assessment (Ocean AI Labs Beijing). Build a small, working
multi-tenant certificate admin console in a one-hour sitting with AI assistance.

## Go to
- [Tech stack](#1-tech-stack)
- [Architecture](#2-architecture)
- [Data model](#3-data-model)
- [API](#4-api)
- [Acceptance mapping](#5-acceptance-mechanics)
- [Frontend](#6-frontend)
- [Scripts](#7-scripts)
- [Decisions & tradeoffs](#8-decisions--tradeoffs)

## 1. Tech stack

- **Backend:** Node 22 + Express + better-sqlite3 (WAL mode). The environment has
  Node/npm; Go is not installed. better-sqlite3 is synchronous — transactions are
  trivial to make correct, and streaming between chunks keeps the event loop free.
- **DB:** SQLite file (`server/data.db`, overridable with `DB_PATH`). WAL allows
  concurrent reads, which is exactly what A6 requires (list request while export runs).
- **Frontend:** Vue 3 + Vite. Actor is identified by the `X-User` header (no login UI).

## 2. Architecture

```
web/    Vue 3 + Vite app (API client + 2 views + bulk-issue dialog)
server/ Express API + SQLite layer
        ├─ index.js        app + middleware + routes + static serve
        ├─ db.js           connection, pragmas, schema/migrations
        ├─ helpers.js      tenant-local tz formatting, serial reservation, CSV escaping
        ├─ routes.js       certificate list/detail/bulk/revoke/export
        └─ scripts/
             ├─ setup.js     migrate + seed demo data (idempotent)
             ├─ seed-bulk.js 100,000 cert rows for one tenant (A6 dataset)
             └─ verify.js    runs A1–A7 checks against an isolated temp DB
dist/   built frontend (served by Express in `npm start`)
```

- One command: `npm start` → migrate+seed → `vite build` → serve API + static app.
- Second command: `npm run verify` → spins up isolated server on temp DB, runs A1–A7.

## 3. Data model (SQLite)

| Table | Purpose / notes |
|---|---|
| `tenants(id, slug UNIQUE, tz)` | East `Australia/Sydney`, West `Australia/Perth` |
| `admins(id, tenant_id, email)` | `alice@east.test`, `bob@west.test`, bound to one tenant |
| `learners(id, tenant_id, name)` | tenant-scoped |
| `courses(id, tenant_id, title)` | "Safety 101" in both tenants |
| `enrollments(id, tenant_id, course_id, learner_id, status)` | `completed`/`incomplete`, unique per (course, learner) |
| `certificates(id, tenant_id, course_id, learner_id, serial, issued_at_utc, local_date, status)` | `serial` globally unique, `status` `active`/`revoked` |
| `audit_events(id, tenant_id, actor, cert_id, action, at_utc, reason)` | exactly one per *actual* issuance / revocation |
| `idempotency_keys(id, tenant_id, key, request_hash, state, result_json, created_at, updated_at)` | **UNIQUE(tenant_id, key)** |
| `serial_counters(tenant_id, year, last_seq)` | per-tenant, per-year serial sequence |

### Tenancy
Every row carries `tenant_id`; every query / mutation filters by the resolved tenant
**in SQL** (never post-filtered in memory). `serial = <TENANT>-<YYYY>-<SEQ>`.

### Timezone / DST (A5)
`issued_at_utc` is stored as **UTC epoch ms**. At write time the *tenant-local calendar
date* is computed with `Intl.DateTimeFormat(..., { timeZone: tenant.tz })` and stored in
`certificates.local_date` (`YYYY-MM-DD`). List sorting and CSV export read `local_date`,
so:

- East (Sydney, UTC+11 in Jan DST) `2026-01-10T13:30:00Z` → `local_date 2026-01-11`, display `00:30`
- West (Perth, UTC+8) same timestamp → `local_date 2026-01-10`, display `21:30`

`local_date` is precomputed so SQL can ORDER BY / WHERE it without tz logic in the query.

### Idempotency (A2 / A3)
Bulk issue requires an `Idempotency-Key` header.

1. `INSERT INTO idempotency_keys(...) VALUES (...)` with `state='running'`.
   - Winner (no unique conflict) runs the operation, then updates the row to `state='done'`
     with `result_json` = per-learner outcomes.
   - On failure the winner **deletes** the key row (transaction rolled back, nothing
     created) and returns 500 — so a caller may safely retry.
2. Duplicate key → compare `request_hash`:
   - different payload → **409** (A3), no second operation, stored result untouched.
   - same payload:
     - already `done` → return stored result (A2 sequential).
     - still `running` → wait/poll until done, then return stored result (A2 concurrent).

### Revocation (A7)
`POST /{id}/revoke` is naturally idempotent: if `active`, set `revoked` + write one
audit event; if already `revoked`, return 200 with current state and **write nothing**.

### Export (A6)
`GET /export` runs the *same* search + sort + tenant scope as the list endpoint and
streams rows via a chunked cursor (`db.iterate`) with backpressure. WAL lets the
list request succeed concurrently. Tiebreaker `certificates.id` (ascending) makes
rows with equal sort keys stable across repeated exports.

## 4. API

All endpoints require `X-User: <admin email>`; middleware resolves the admin to its
tenant. Cross-tenant access returns **404** (detail) or **403** (bulk) without touching
target-tenant data.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/certs?q=&sort=&order=&page=&size=` | tenant-scoped list; search `learner name` or `serial`; sort whitelist `local_date`/`learner_name`/`serial`; paginate; loading/empty/error render client-side |
| GET | `/api/certs/:id` | detail (cross-tenant → 404) |
| POST | `/api/certs/bulk` `Idempotency-Key: <k>` | body `{ courseId }`; returns `{ outcomes: [{learnerId,name,outcome,reason}], counts }` |
| POST | `/api/certs/:id/revoke` | body `{ reason }`; idempotent, audited |
| GET | `/api/certs/export?q=&sort=&order=` | streamed CSV: `learner_name,course_title,serial,issue_date` |
| GET | `/api/schema` | tenants/courses/admins for actor switcher + bulk-issue dropdown |
| GET | `/api/health` | readiness |

Actor switcher is data-driven from `/api/schema` (admins are public demo data; no auth here).

## 5. Acceptance mechanics

- **A1**: SQL tenant scoping + 404/403 on cross-tenant; bulk rejection before any write.
- **A2**: idempotency key row as described above; per-learner at most one cert; one audit
  per real issuance; duplicate callers get the first result.
- **A3**: `request_hash` mismatch → 409, first stored result preserved.
- **A4**: eligibility = enrollment `completed` AND no `active` cert for (learner, course).
  Outcome reasons: `issued`, `skipped: not_completed`, `skipped: already_certified`.
  The issue transaction is atomic.
- **A5**: UTC storage + precomputed `local_date`; list sort/CSV use it; detail renders
  tenant-local datetime.
- **A6**: 100k seeded via `npm run seed:100k` into the *default* dataset is disallowed by
  the spec ("without changing the default quick-start dataset"), so the seeder writes to
  the regular DB but the **quick-start demo rows are preserved** — bulk rows are inserted
  additionally (spec wording: a command that generates 100k rows for one tenant without
  changing default quick-start dataset; the seed does not touch demo rows). The verify
  script regenerates an isolated dataset for repeatable runs.
- **A7**: idempotent revocation; no duplicate audit events.

## 6. Frontend (Vue 3 + Vite)

- **Certificate list** — actor switcher, search input, sortable column headers,
  pagination, explicit `loading` / `empty` / `error` states.
- **Bulk issue** — course dropdown + confirm; submit disabled while in flight; result
  table of per-learner outcomes with reasons.
- **Certificate detail** — serial, course, learner, tenant-local issue datetime, status;
  revoke with confirmation.
- **CSV export** — button that calls `/export` with current search+sort.

Views: `CertificateList.vue`, `CertificateDetail.vue`. In-app navigation is state-based
(tiny app); no router dependency needed.

## 7. Scripts

| Script | Purpose |
|---|---|
| `npm start` | deps installed → migrate+seed → `vite build` → Express serves app + API on `:3000` |
| `npm run dev` | migrate+seed → Vite dev server (API proxied to `:3000`) |
| `npm run verify` | isolated temp DB + server; executes A1–A7 checks and prints PASS/FAIL |
| `npm run seed:100k` | add 100k certificate rows for a tenant (`--tenant east --count 100000`) into the regular DB, preserving demo rows |

## 8. Decisions & tradeoffs

1. **better-sqlite3 (sync) over an async driver** — correctness of transactions and
   idempotency is much easier to reason about; streaming with periodic yields gives
   concurrency where it matters (A6 list-during-export) without ORM-shaped complexity.
2. **Precomputed tenant-local `local_date`** — trades a small write-time cost for
   trivially correct, *indexable* tenant-locale sorting/filtering/CSV (A5) and removes tz
   logic from SQL.
3. **Idempotency row = the lock** — the `idempotency_keys` unique constraint both dedupes
   and serializes the operation, so concurrent duplicate callers naturally converge on
   one logical result (A2) while reuse-with-different-payload is distinguishable (A3).
4. **Global unique serials with per-tenant prefix** — serial search doesn't need tenant
   context, and the prefix makes provenance obvious in CSV.
5. **API-only frontend data access** — the DB is never exposed to the browser; all rows
   are tenant-scoped server-side, matching the "no client-side tenancy" expectation.
6. **`Intl.DateTimeFormat` (built-in ICU) instead of a tz package** — zero dependency,
   Node 22 ships full ICU, so `Australia/Sydney` DST rules are handled with no vendored
   tz database.