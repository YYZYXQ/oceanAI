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

| Scenario | How to reproduce |
|---|---|
| A1 | As `bob@west.test`, call `GET /api/certs/1`, `POST /api/certs/bulk` with an East `courseId`. Both return 404; no certificates or audit rows are created. The list only ever shows West rows. |
| A2 | As Alice, `POST /api/certs/bulk` with the same `Idempotency-Key` twice (serial or concurrent). The second returns the first operation's outcome; no extra certificates or audit events. |
| A3 | Reuse a used `Idempotency-Key` with a different `courseId`. Returns `409` and preserves the first result. |
| A4 | Bulk-issue East "Safety 101": Riley Stone and Casey Wren are `issued`, Alex Lee `skipped: already_certified`, Jordan Blake `skipped: not_completed`. |
| A5 | Open `GET /api/certs/1` as Alice (`2026-01-11 00:30`) and `GET /api/certs/2` as Bob (`2026-01-10 21:30`). List sorting and CSV use `local_date`. |
| A6 | `npm run seed:100k` (default tenant `east`), then load the UI and export. While exporting, load the certificate list. See the verify script for the exact assertions (timing < 60s, stable order). |
| A7 | As Alice, revoke `GET /api/certs/1`, then revoke it again. Status flips once; only one `revoke` audit row exists. |

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