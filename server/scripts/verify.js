import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb, closeDb } from '../db.js';
import { setup } from './setup.js';
import { seedBulk } from './seed-bulk.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 3123;

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(base, p, opts = {}) {
  const res = await fetch(base + p, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

async function waitHealth(base, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await call(base, '/api/health');
      if (r.status === 200) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not become healthy');
}

async function runChecks(base, dbPath, tmp) {
  const db = openDb(dbPath);
  const q = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);

  const eastTenant = q(`SELECT id, slug, tz FROM tenants WHERE slug = 'east'`);
  const westTenant = q(`SELECT id, slug, tz FROM tenants WHERE slug = 'west'`);
  const eastCourse = q(`SELECT id, title FROM courses WHERE tenant_id = ? AND title = 'Safety 101'`, eastTenant.id);
  const eastCourse2 = q(`SELECT id, title FROM courses WHERE tenant_id = ? AND title = 'First Aid Refresher'`, eastTenant.id);
  const westCourse = q(`SELECT id, title FROM courses WHERE tenant_id = ? AND title = 'Safety 101'`, westTenant.id);
  const eastAlex = q(`SELECT l.id FROM learners l JOIN tenants t ON t.id = l.tenant_id WHERE t.slug='east' AND l.name='Alex Lee'`).id;
  const eastCert = q(`SELECT id, serial, status FROM certificates WHERE tenant_id = ? AND serial = 'EAST-2026-000001'`, eastTenant.id);
  const westCert = q(`SELECT id, serial, status FROM certificates WHERE tenant_id = ? AND serial = 'WEST-2026-000001'`, westTenant.id);

  const H_ALICE = { 'X-User': 'alice@east.test' };
  const H_BOB = { 'X-User': 'bob@west.test' };

  console.log('\nA1 — tenant isolation');
  {
    const beforeWest = q(`SELECT COUNT(*) AS n FROM certificates WHERE tenant_id = ?`, westTenant.id).n;
    const list = await call(base, '/api/certs?size=100', { headers: H_BOB });
    ok('bob list returns 200', list.status === 200);
    ok(
      'bob sees only West certificates',
      list.json.items.length > 0 && list.json.items.every((r) => r.serial.startsWith('WEST-'))
    );
    const cross = await call(base, `/api/certs/${eastCert.id}`, { headers: H_BOB });
    ok('bob gets 404 on East detail', cross.status === 404);
    const bulk = await call(base, '/api/certs/bulk', {
      method: 'POST',
      headers: { ...H_BOB, 'idempotency-key': 'a1-cross' },
      body: JSON.stringify({ courseId: eastCourse.id }),
    });
    ok('bob bulk-issue on East course rejected (404)', bulk.status === 404);
    const afterWest = q(`SELECT COUNT(*) AS n FROM certificates WHERE tenant_id = ?`, westTenant.id).n;
    const afterEast = q(`SELECT COUNT(*) AS n FROM certificates WHERE tenant_id = ?`, eastTenant.id).n;
    ok('cross-tenant bulk created no certificates (West unchanged)', beforeWest === afterWest, `before ${beforeWest} after ${afterWest}`);
    ok('cross-tenant bulk created no East certificates', afterEast <= 3);
    const auditCross = all(
      `SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = ? AND action = 'revoke'`,
      eastTenant.id
    )[0].n;
    ok('no unintended audit events from cross-tenant attempt', auditCross === 0);
  }

  console.log('\nA2 + A4 — idempotent bulk issue & per-learner outcomes');
  {
    const key = 'bulk-e1';
    const r1 = await call(base, '/api/certs/bulk', {
      method: 'POST',
      headers: { ...H_ALICE, 'idempotency-key': key },
      body: JSON.stringify({ courseId: eastCourse.id }),
    });
    ok('first bulk returns 200', r1.status === 200);
    const outcomes = r1.json.outcomes;
    const byName = Object.fromEntries(outcomes.map((o) => [o.name, o]));
    ok('Riley Stone issued', byName['Riley Stone']?.outcome === 'issued');
    ok('Casey Wren issued', byName['Casey Wren']?.outcome === 'issued');
    ok('Alex Lee skipped (already_certified)', byName['Alex Lee']?.outcome === 'skipped' && byName['Alex Lee']?.reason === 'already_certified');
    ok('Jordan Blake skipped (not_completed)', byName['Jordan Blake']?.outcome === 'skipped' && byName['Jordan Blake']?.reason === 'not_completed');
    ok('counts consistent', r1.json.counts.issued === 2 && r1.json.counts.skipped === 2);

    const certsE1 = q(
      `SELECT COUNT(*) AS n FROM certificates c JOIN audit_events a ON a.cert_id = c.id
       WHERE c.tenant_id = ? AND a.action = 'issue' AND c.serial IN ('EAST-2026-000002','EAST-2026-000003')`,
      eastTenant.id
    ).n;
    ok('exactly one audit per actually-issued certificate', certsE1 === 2);

    // A2 sequential+concurrent same key -> one logical operation
    const r2 = await call(base, '/api/certs/bulk', {
      method: 'POST',
      headers: { ...H_ALICE, 'idempotency-key': key },
      body: JSON.stringify({ courseId: eastCourse.id }),
    });
    ok('sequential replay returns 200', r2.status === 200);
    ok(
      'sequential replay returns same logical result',
      r2.json.counts.issued === r1.json.counts.issued && JSON.stringify(r2.json.outcomes) === JSON.stringify(outcomes)
    );

    const five = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(base, '/api/certs/bulk', {
          method: 'POST',
          headers: { ...H_ALICE, 'idempotency-key': key },
          body: JSON.stringify({ courseId: eastCourse.id }),
        })
      )
    );
    ok('all concurrent duplicates return 200', five.every((r) => r.status === 200));
    ok(
      'concurrent duplicates return same logical result',
      five.every((r) => JSON.stringify(r.json.outcomes) === JSON.stringify(outcomes))
    );
    const certTotal = q(`SELECT COUNT(*) AS n FROM certificates WHERE tenant_id = ?`, eastTenant.id).n;
    ok('no duplicate certificates after concurrent replay', certTotal === 3);
    const issueAudits = q(
      `SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = ? AND action = 'issue'`,
      eastTenant.id
    ).n;
    ok('audit count matches actual issuances (2 from this bulk)', issueAudits === 2);
  }

  console.log('\nA3 — idempotency key misuse');
  {
    const key = 'a3-key';
    const r1 = await call(base, '/api/certs/bulk', {
      method: 'POST',
      headers: { ...H_ALICE, 'idempotency-key': key },
      body: JSON.stringify({ courseId: eastCourse.id }),
    });
    const r2 = await call(base, '/api/certs/bulk', {
      method: 'POST',
      headers: { ...H_ALICE, 'idempotency-key': key },
      body: JSON.stringify({ courseId: eastCourse2.id }),
    });
    ok('reusing key with different payload returns 409', r2.status === 409);
    const firstPreserved = q(
      `SELECT result_json FROM idempotency_keys WHERE tenant_id = ? AND key = ?`,
      eastTenant.id, key
    );
    const parsed = firstPreserved ? JSON.parse(firstPreserved.result_json) : null;
    ok(
      'first stored result not overwritten by second payload',
      parsed && parsed.courseId === eastCourse.id && parsed.counts.issued === 0
    );
  }

  console.log('\nA5 — DST and tenant-local dates');
  {
    const east = await call(base, `/api/certs/${eastCert.id}`, { headers: H_ALICE });
    ok('East detail shows 2026-01-11 00:30', east.json.localDateTime === '2026-01-11 00:30', east.json.localDateTime);
    ok('East stored local_date is 2026-01-11', east.json.local_date === '2026-01-11');
    const west = await call(base, `/api/certs/${westCert.id}`, { headers: H_BOB });
    ok('West detail shows 2026-01-10 21:30', west.json.localDateTime === '2026-01-10 21:30', west.json.localDateTime);
    ok('West stored local_date is 2026-01-10', west.json.local_date === '2026-01-10');
    const eastList = await call(base, '/api/certs?sort=local_date&order=desc&size=100', {
      headers: H_ALICE,
    });
    const dates = eastList.json.items.map((r) => r.local_date);
    ok('list sorted desc by tenant-local date', dates.length > 1 && dates.every((d, i) => i === 0 || dates[i - 1] >= d));
  }

  console.log('\nA7 — revocation audit (no duplicates)');
  {
    const before = q(`SELECT COUNT(*) AS n FROM audit_events WHERE cert_id = ? AND action = 'revoke'`, eastCert.id).n;
    const r1 = await call(base, `/api/certs/${eastCert.id}/revoke`, {
      method: 'POST',
      headers: H_ALICE,
      body: JSON.stringify({ reason: 'policy review' }),
    });
    ok('revoke returns 200', r1.status === 200 && r1.json.status === 'revoked');
    const r2 = await call(base, `/api/certs/${eastCert.id}/revoke`, {
      method: 'POST',
      headers: H_ALICE,
      body: JSON.stringify({ reason: 'policy review' }),
    });
    const after = q(`SELECT COUNT(*) AS n FROM audit_events WHERE cert_id = ? AND action = 'revoke'`, eastCert.id).n;
    ok('first revoke wrote one audit event', after === before + 1, `before ${before} after ${after}`);
    ok('repeat revoke did not add another audit event', after === 1);
    ok('repeat revoke acknowledged as already revoked', r2.json.alreadyRevoked === true);
  }

  console.log('\nA6 — export growth (100,000 rows)');
  {
    const tGen = Date.now();
    seedBulk(dbPath, { tenant: 'east', count: 100000 });
    const genSecs = ((Date.now() - tGen) / 1000).toFixed(1);
    console.log(`  (seeded 100k East certs in ${genSecs}s)`);

    // deterministic expected count from the DB for search q
    const expectedRow = q(
      `SELECT COUNT(*) AS n FROM certificates c
        JOIN learners l ON l.id = c.learner_id
       WHERE c.tenant_id = ?
         AND (l.name LIKE '%000001%' ESCAPE '\\' OR c.serial LIKE '%000001%' ESCAPE '\\')`,
      eastTenant.id
    );
    const expected = expectedRow.n;
    ok('search query matches >0 rows', expected > 0, `expected=${expected}`);
    const qstr = 'sort=local_date&order=asc&q=000001';

    // first export, timed, with a list request issued DURING the export
    const t1 = Date.now();
    const [exp1, listDuring] = await Promise.all([
      call(base, `/api/certs/export?${qstr}`, { headers: H_ALICE }),
      call(base, '/api/certs?size=20', { headers: H_ALICE }),
    ]);
    const t1ms = Date.now() - t1;
    ok('list request succeeds while export is running', listDuring.status === 200);
    const csv1 = exp1.text;
    const dataLines1 = csv1.split('\n').filter((line) => line && !line.includes('learner_name,course_title'));
    const dataCount1 = dataLines1.length;
    ok('first export contains exactly the matching rows', dataCount1 === expected, `csv=${dataCount1} expected=${expected}`);
    ok(`first export completed within 60s (${(t1ms / 1000).toFixed(1)}s)`, t1ms < 60000);

    // second export, timed
    const t2 = Date.now();
    const exp2 = await call(base, `/api/certs/export?${qstr}`, { headers: H_ALICE });
    const t2ms = Date.now() - t2;
    const csv2 = exp2.text;
    const dataLines2 = csv2.split('\n').filter((line) => line && !line.includes('learner_name,course_title'));
    ok(`second export completed within 60s (${(t2ms / 1000).toFixed(1)}s)`, t2ms < 60000);
    ok('second export has same row count', dataLines2.length === expected);

    // stability of equal sort keys: successive exports identical (incl. order)
    ok('row order identical across repeated exports', csv1 === csv2);
  }

  closeDb(db);
  return { pass, fail };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oceanai-verify-'));
  const dbPath = path.join(tmp, 'verify.db');
  try {
    setup(null, dbPath);
    const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
      env: { ...process.env, DB_PATH: dbPath, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    const base = `http://127.0.0.1:${PORT}`;
    try {
      await waitHealth(base);
      const { pass: p, fail: f } = await runChecks(base, dbPath, tmp);
      console.log(`\n${p} passed, ${f} failed`);
      if (f > 0) process.exitCode = 1;
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

main().catch((e) => {
  console.error('verify failed to run', e);
  process.exitCode = 2;
});