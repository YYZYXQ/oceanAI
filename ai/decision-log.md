# AI Decision Log

Traceable decisions made while building the Certificate Admin Console. Each
entry links to the relevant AI session, the verification evidence, and the
commit(s). All decisions in this build were made during session
`ses_e45378c5bfferVVEWBKnPnKFq2` (opencode, model
`deepseek-ai/DeepSeek-V4-Flash`, provider `siliconflow`).

## Timeline / evidence
- Session export: `ai/sessions/ses_e45378c5bfferVVEWBKnPnKFq2.json`
- Acceptance results: `npm run verify` -> "38 passed, 0 failed"
  (A1-A7; recorded in the session transcript near the end)

## D1 — Accepted AI suggestion: better-sqlite3 + precomputed tenant-local date

- **Decision:** Use better-sqlite3 (synchronous) in WAL mode, and store a
  precomputed `certificates.local_date` (`YYYY-MM-DD` in the tenant's IANA
  timezone) alongside `issued_at_utc`.
- **Why accepted:** Transactions (idempotency, audit, bulk issue) are trivial to
  make atomic and correct; the stored local calendar date makes tenant-local
  sorting/filtering/CSV (A5, A6) indexable and free of timezone logic in SQL;
  `Intl.DateTimeFormat` with Node's built-in ICU handles Australia/Sydney DST
  with zero dependencies.
- **Verification:** A5 checks (East `2026-01-11 00:30`, West `2026-01-10 21:30`)
  and A6 list-sorted checks pass on `npm run verify`.
- **Commits:** (final build commit)

## D2 — Rejected/corrected AI output: unaliased column references in ORDER BY

- **Suggestion produced:** `ORDER BY certificates.local_date` while the FROM
  clause aliases the table (`FROM certificates c`). SQLite rejects the original
  table name once aliased -> `SqliteError: no such column: certificates.local_date`
  (observed live: list endpoint returned HTTP 500).
- **Correction applied:** SORT_COLS now map to aliased columns
  (`c.local_date`, `l.name`, `c.serial`, `c.id`) shared by list and export.
- **Verification:** reproduce-and-fix cycle visible in the transcript + A6 list
  check passes.
- **Commits:** (final build commit)

## D3 — Correction found by verification: route ordering /certs/export vs /certs/:id

- **Bug:** `GET /certs/export` was declared after `GET /certs/:id`, so Express
  matched `export` as `:id` and returned 404 (export silently produced
  `{"error":"not found"}`). Not caught by reasoning; caught by the standalone
  export probe, then the A6 check in the verify suite.
- **Correction applied:** declare `/certs/export` before `/certs/:id`.
- **Verification:** `npm run verify` A6 now exports the exact matching rows and
  repeated exports are byte-identical.

## D4 — Scope/design tradeoff: dedicated readonly connection for CSV export

- **Tradeoff:** A single better-sqlite3 connection cannot run a second statement
  while a cursor is iterating. Rather than buffering 100k+ rows in memory, the
  export opens a dedicated readonly connection (same file, WAL) and streams with
  periodic yields so the event loop keeps serving other requests (A6: list
  request succeeds while export runs).
- **Cost:** one extra file handle per export; mitigated by closing it in
  `finally`.
- **Verification:** A6 "list request succeeds while export is running" passes and
  export of 100k rows completes in ~0.1s.

## D5 — Normalization correction: serial prefix casing

- **Suggestion produced:** seeded demo serials `EAST-...`/`WEST-...` but runtime
  bulk-issue serials derived from the lowercase DB slugs (`east-...`).
- **Correction accepted:** `reserveSerials` uppercases the slug so all serials
  follow `<TENANT>-<YYYY>-<SEQ>` (e.g. `EAST-2026-000002`).
- **Verification:** A2 "exactly one audit per actually-issued certificate" passes
  with the normalized serials.