# Certificate Admin Console

Multi-tenant certificate admin console built for the Ocean AI Labs Beijing
technical interview assessment (1-hour build with AI assistance).

Tenant admins list certificates, bulk-issue them per course, revoke them, audit
the events, and export CSV. Actor identity comes from the `X-User` header (no
login UI). All rows are tenant-scoped in SQL.

## One-command startup

Requires Node.js >= 22 (npm included).

```
npm install
npm start
```

`npm start` migrates the schema, seeds the demo dataset, builds the frontend,
and serves the app + API at `http://localhost:3000`.

Actors (switch in the UI dropdown, or send the header on API calls):

- `alice@east.test` — tenant **East** (`Australia/Sydney`)
- `bob@west.test` — tenant **West** (`Australia/Perth`)

API example:

```
curl -H "X-User: alice@east.test" http://localhost:3000/api/certs?q=&sort=local_date&order=desc&size=20
```

### Demo dataset

- East and West tenants (Sydney / Perth timezones).
- One admin per tenant (Alice, Bob), bound to their own tenant only.
- Both tenants have a course **"Safety 101"** and a learner **"Alex Lee"**.
  Enrollments include completed, incomplete, and already-certified cases so the
  bulk-issue eligibility outcomes (A4) are demonstrable.
- Two certificates issued at `2026-01-10T13:30:00Z` (one per tenant) to
  demonstrate DST display (A5).
- East also has a second course ("First Aid Refresher") to demonstrate the
  idempotency-key reuse-with-different-payload rejection (A3).

## Verify (second command)

```
npm run verify
```

Spins up an isolated server on a temp SQLite database and runs checks for every
acceptance scenario, printing PASS/FAIL:

- **A1** tenant isolation (404/403 cross-tenant, no writes)
- **A2** idempotency: sequential and concurrent replay of one bulk request
- **A3** idempotency-key reuse with a different payload -> 409
- **A4** per-learner outcomes (issued / skipped with reasons)
- **A5** DST and tenant-local dates
- **A6** 100,000-row export, timing, stability, and list-during-export
- **A7** revocation audit with no duplicate events

## Reproducing A1–A7 manually

A quicker alternative to all of this is `npm run verify`, which executes every
scenario automatically. The steps below reproduce each one by hand against a
fresh `npm start` dataset (server on `:3000`). To reset the dataset, delete
`server/data.db` (and its `-shm`/`-wal` files) before running `npm start`.
Demo IDs (fixed by the idempotent seeder, see `GET /api/schema` and
`GET /api/certs`):

- courses: `1` East "Safety 101", `2` East "First Aid Refresher", `3` West "Safety 101"
- certificates: `1` `EAST-2026-000001`, `2` `WEST-2026-000001`

### A1 — Tenant isolation

```bash
# Bob lists West certificates only (no EAST serials in the response):
curl -s -H "X-User: bob@west.test" "http://localhost:3000/api/certs?size=100"

# Bob cannot read an East certificate (404, non-revealing):
curl -s -i -H "X-User: bob@west.test" "http://localhost:3000/api/certs/1"

# Bob tries to bulk-issue to an East course -> 404, and NOTHING is written:
curl -s -i -X POST -H "X-User: bob@west.test" -H "Idempotency-Key: a1-x" \
  -H "Content-Type: application/json" \
  -d '{"courseId":1}' "http://localhost:3000/api/certs/bulk"
```

Expected: West list contains only `WEST-*` serials; the two cross-tenant calls
return `404`. Confirm no rows were created: the West certificate count is
unchanged (one) and no `issue` audit events exist for East (visible in the
detail audit trail / database).

### A2 — Retry safety (idempotent bulk issue, sequential)

```bash
# Run the same operation twice with the SAME idempotency key:
curl -s -X POST -H "X-User: alice@east.test" -H "Idempotency-Key: a2-key" \
  -H "Content-Type: application/json" -d '{"courseId":1}' \
  "http://localhost:3000/api/certs/bulk"
curl -s -X POST -H "X-User: alice@east.test" -H "Idempotency-Key: a2-key" \
  -H "Content-Type: application/json" -d '{"courseId":1}' \
  "http://localhost:3000/api/certs/bulk"
```

Expected: the first call issues certificates; the **second returns the same
result** (the stored outcome) and creates nothing new. Check that East now has
exactly 3 certificates (1 demo + 2 issued) and each issued certificate has
exactly one `issue` audit entry. Concurrent replay (multiple parallel requests
with the same key) is covered by `npm run verify`; behavior is identical — one
logical operation, all callers receive the same outcome.

### A3 — Idempotency key misuse

```bash
# Reuse the key from A2 (or any used key) with a DIFFERENT course:
curl -s -i -X POST -H "X-User: alice@east.test" -H "Idempotency-Key: a2-key" \
  -H "Content-Type: application/json" -d '{"courseId":2}' \
  "http://localhost:3000/api/certs/bulk"
```

Expected: `409` with a "different request payload" error. The first operation's
result is untouched (no certificates or audit events for course 2 are created).

### A4 — Per-learner outcomes

```bash
curl -s -X POST -H "X-User: alice@east.test" -H "Idempotency-Key: a4-key" \
  -H "Content-Type: application/json" -d '{"courseId":1}' \
  "http://localhost:3000/api/certs/bulk"
```

Expected outcomes (`outcomes[]`): Riley Stone and Casey Wren `issued`,
Alex Lee `skipped / already_certified`, Jordan Blake `skipped / not_completed`.
Run it a second time — every learner is now `skipped`.

### A5 — DST and tenant-local dates

```bash
curl -s -H "X-User: alice@east.test" "http://localhost:3000/api/certs/1"   # EAST-2026-000001
curl -s -H "X-User: bob@west.test"     "http://localhost:3000/api/certs/2"   # WEST-2026-000001
```

Both certificates share the UTC timestamp `2026-01-10T13:30:00Z`. Expected:
East detail shows `localDateTime: "2026-01-11 00:30"` and `local_date:
"2026-01-11"`; West shows `"2026-01-10 21:30"` / `"2026-01-10"`. The East list
sorted by `sort=local_date` and the exported CSV use these local calendar dates.

### A6 — Export growth (100,000 East rows)

```bash
npm run seed:100k                          # adds 100k East certs (demo rows untouched)
npm start                                  # needed only if the server is not running

# Export twice with a search + sort, and request the certificate LIST during
# the first export (both below can run in parallel terminals):
curl -s -H "X-User: alice@east.test" \
  "http://localhost:3000/api/certs/export?q=000001&sort=local_date&order=asc" -o export1.csv
curl -s -H "X-User: alice@east.test" \
  "http://localhost:3000/api/certs/export?q=000001&sort=local_date&order=asc" -o export2.csv
curl -s -H "X-User: alice@east.test" "http://localhost:3000/api/certs?size=20"   # during export
```

Expected: each export finishes well under 60 seconds; both CSV files contain
exactly the matching East rows in the same order (rows with equal
`issue_date` keep the same relative order); the list request succeeds while an
export is running. `export2.csv` is byte-identical to `export1.csv`.

### A7 — Revocation audit

```bash
curl -s -X POST -H "X-User: alice@east.test" -H "Content-Type: application/json" \
  -d '{"reason":"policy review"}' "http://localhost:3000/api/certs/1/revoke"
curl -s -X POST -H "X-User: alice@east.test" -H "Content-Type: application/json" \
  -d '{"reason":"policy review"}' "http://localhost:3000/api/certs/1/revoke"
```

Expected: the first call flips the status to `revoked` and writes **one**
`revoke` audit event; the repeat returns `200` with
`alreadyRevoked: true` and writes nothing. The detail audit trail shows exactly
one `revoke` entry.

### 100,000-row generation

```
npm run seed:100k                 # 100,000 East certificates (default)
npm run seed:100k -- --tenant west --count 50000
```

The seeder adds certificate rows (with matching learners and completed
enrollments) without touching the quick-start demo dataset. All bulk rows share
one `local_date` so the equal-sort-key stability requirement is exercised.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/certs?q=&sort=&order=&page=&size=` | tenant-scoped list/search/paginate/sort |
| GET | `/api/certs/:id` | detail (cross-tenant -> 404) |
| GET | `/api/certs/export?q=&sort=&order=` | streamed CSV |
| POST | `/api/certs/bulk` + `Idempotency-Key` | body `{ "courseId": <id> }` |
| POST | `/api/certs/:id/revoke` | body `{ "reason": "..." }` |
| GET | `/api/schema` | tenants/admins/courses (drives UI) |
| GET | `/api/health` | readiness |

Sort whitelist: `local_date` (default), `learner_name`, `serial`, `id`. Order
`asc`/`desc`; equal sort keys are tie-broken by `id ASC` so repeated exports are
stable.

## Project layout

```
server/            Express API + SQLite layer (db.js, routes.js, helpers.js)
web/               Vue 3 + Vite app (list + detail views, bulk issue, export)
dist/              built frontend (generated)
ai/                AI interaction evidence (session export, index, decision log)
written-answers.md Section 6 written answers (candidate-authored, no AI)
AGENTS.md          instructions for AI tools working in this repo
DESIGN.md          design rationale
```

## Known defects / unfinished work

- No authentication: the `X-User` header identifies an admin from the seeded
  set; there is no password or token validation (explicitly out of scope).
- Two bulk-issue requests with **different** idempotency keys issued
  concurrently for the same course are both eligible-read at the same moment and
  could each issue to the same "eligible" learners. The same-key guarantee (A2)
  is enforced; a different-key cross-request lock / unique index on
  `(course_id, learner_id)` for active certificates is the natural hardening not
  yet implemented.
- Revocation uses the endpoint's natural idempotency (a revoked certificate
  revoke is a no-op) rather than an explicit idempotency-key row; A7's
  no-duplicate-audit requirement is still met.
- No automated UI (browser) tests; API-level checks cover A1–A7 via
  `npm run verify`.
- `npm run seed:100k` writes into the default database file; it does not alter
  the demo rows but does grow that file. `npm run verify` never touches the
  default database (isolated temp DB).

## AI interaction evidence (Section 5)

- `ai/sessions/` — native opencode JSON exports (full transcript, tool calls,
  timestamps, model identifiers).
- `ai/session-index.csv` — one row per session.
- `ai/decision-log.md` — traced decisions (accepted suggestion, rejected output,
  verification-driven corrections, tradeoffs), linked to session + commits.
- This README is part of the completeness declaration; see the bottom of
  `DESIGN.md` for the design decisions. Section 6 was completed without AI
  (`written-answers.md` is candidate-authored).

### Completeness declaration (tool)

| Tool | Evidence | Export limitation |
|---|---|---|
| opencode (CLI, this agent) | `ai/sessions/*.json` via `opencode export` | Native JSON export available; no limitation. Inline autocomplete (if any) is intentionally not used/disclosed here; command transcripts are inside the session exports. |