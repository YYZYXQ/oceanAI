# AI Decision Log

Traceable decisions made while building the Certificate Admin Console. Each
entry links to the relevant AI session, the verification evidence, and the
commit(s). One session covers the whole build:

- **Session:** `ses_e45378c5bfferVVEWBKnPnKFq2`
- **Tool:** opencode (CLI), v1.18.3 / 1.19.5
- **Model:** `deepseek-ai/DeepSeek-V4-Flash` (provider `siliconflow`)
- **Export:** `ai/sessions/ses_e45378c5bfferVVEWBKnPnKFq2.json`
  (started `2026-11-08T10:51:01Z`, ended `2026-11-08T12:48:59Z`, 297 messages)

## Evidence

- `npm run verify` -> **"38 passed, 0 failed"** (A1-A7, isolated temp DB).
- Live end-to-end re-runs of the README manual flow -> **22/22 PASS** on a
  pristine quick-start dataset; **A6 (100k export) -> 11/11 PASS** (live).
  All runs are recorded in the session transcript.
- Commit history: `3fce0f4` (briefing) , `71d6b3a` (build), `db881b3`,
  `f0414ce`, `6ef3622`, `ef2a56f`, `a82de16`, `910e940`, `43ae2b1`, `c47a2f2`.

## D1 — Accepted AI suggestion: better-sqlite3 (sync) + precomputed local date

- **Decision:** Use better-sqlite3 (synchronous) in WAL mode, and store a
  precomputed `certificates.local_date` (`YYYY-MM-DD` in the tenant's IANA
  timezone) alongside `issued_at_utc`.
- **Why accepted:** synchronous transactions make idempotency/audit/bulk issue
  easy to reason about; a stored local calendar date makes tenant-local sorting /
  filtering / CSV (A5, A6) indexable and removes timezone logic from SQL;
  `Intl.DateTimeFormat` with Node's built-in ICU handles Australia/Sydney DST
  with zero extra dependencies.
- **Verification:** A5 (East `2026-01-11 00:30`, West `2026-01-10 21:30`) and the
  A6 sort/stability checks pass on `npm run verify`.
- **Commit:** `71d6b3a`.

## D2 — Rejected/corrected AI output: unaliased columns in ORDER BY

- **Suggestion produced:** `ORDER BY certificates.local_date` while the FROM
  clause aliases the table (`FROM certificates c`). SQLite rejects the original
  table name once aliased -> `SqliteError: no such column: certificates.local_date`
  (observed live: list endpoint HTTP 500).
- **Correction applied:** SORT_COLS map to aliased columns (`c.local_date`,
  `l.name`, `c.serial`, `c.id`), shared by list and export.
- **Verification:** reproduce-and-fix in transcript; list and export checks pass.
- **Commit:** `71d6b3a`.

## D3 — Correction found by verification: route ordering /certs/export vs /certs/:id

- **Bug:** `GET /certs/export` was declared after `GET /certs/:id`, so Express
  matched `export` as `:id` and returned 404 (`{"error":"not found"}`). Not
  caught by reasoning; caught by a standalone export probe, then the A6 check.
- **Correction applied:** declare `/certs/export` before `/certs/:id`.
- **Verification:** `npm run verify` A6 exports the exact matching rows and
  repeated exports are byte-identical.
- **Commit:** `71d6b3a`.

## D4 — Scope/design tradeoff: dedicated readonly connection for CSV export

- **Tradeoff:** one better-sqlite3 connection cannot run a second statement while
  a cursor is being iterated. Instead of buffering 100k+ rows in memory, the
  export opens a dedicated readonly connection to the same file (WAL) and streams
  with periodic yields so other requests keep being served.
- **Cost:** one extra file handle per export; closed in `finally`.
- **Verification:** A6 "list request succeeds while export is running" passes;
  100k-row export completes in ~0.2s (well under 60s).
- **Commit:** `71d6b3a`.

## D5 — Normalization correction: serial prefix casing

- **Suggestion produced:** seeded demo serials `EAST-...`/`WEST-...` but runtime
  bulk-issue serials derived from lowercase DB slugs (`east-...`).
- **Correction accepted:** `reserveSerials` uppercases the slug so every serial
  follows `<TENANT>-<YYYY>-<SEQ>` (e.g. `EAST-2026-000002`).
- **Verification:** A2 "exactly one audit per actually-issued certificate" passes
  with normalized serials.
- **Commit:** `71d6b3a`.

## D6 — Verification-driven docs correction: A2/A4 reproduction order

- **Problem found while validating the README's manual steps:** A2 bulk-issued
  course 1 first, so A4's documented "issued" outcomes could never reproduce on
  a sequential run (the two eligible learners were already certified).
- **Correction applied:** README runs A4 first (fresh outcomes), then A2 replays
  the same `Idempotency-Key` and A3 reuses it with a different course.
- **Verification:** the full documented flow was executed end-to-end on a fresh
  dataset -> 22/22 PASS.
- **Commit:** `c47a2f2`.

## D7 — Scope/UX decision: detail shows only the tenant-local issue date

- **Decision:** `GET /api/certs/:id` no longer returns raw `issued_at_utc`; the
  response exposes `local_date` + `localDateTime`, and the UI shows a single
  "Issue date" row (tenant-local) instead of a UTC row.
- **Why accepted:** the assessment's workflow specifies the tenant-local issue
  date as the displayed value; raw UTC is redundant for the admin use case.
- **Verification:** live detail response and rebuilt UI checked in transcript.
- **Commit:** `43ae2b1`.