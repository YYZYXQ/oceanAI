import { pathToFileURL } from 'node:url';
import { openDb, closeDb } from '../db.js';
import { tenantLocalDate, tenantLocalYear, reserveSerials } from '../helpers.js';
import { setup } from './setup.js';

// Generates `--count` certificate rows for one tenant (default east) without
// touching the quick-start demo dataset. Also creates matching learners and
// completed enrollments so the rows are joined cleanly in list/export.
export function seedBulk(dbPath, { tenant = 'east', count = 100000 } = {}) {
  const db = openDb(dbPath);
  const { seeded } = setup(db);
  if (seeded) console.log('(demo data seeded first)');

  const tenantId = db.prepare(`SELECT id, slug, tz FROM tenants WHERE slug = ?`).get(tenant);
  if (!tenantId) throw new Error(`unknown tenant slug: ${tenant}`);

  const course = db.prepare(`SELECT id, title FROM courses WHERE tenant_id = ? AND title = 'Safety 101'`).get(tenantId.id)
    || db.prepare(`SELECT id, title FROM courses WHERE tenant_id = ? ORDER BY id LIMIT 1`).get(tenantId.id);
  if (!course) throw new Error(`no course found for tenant ${tenant}`);

  const now = Date.now();
  const localDate = tenantLocalDate(now, tenantId.tz);
  const year = tenantLocalYear(now, tenantId.tz);

  const tx = db.transaction(() => {
    const insLearner = db.prepare(`INSERT INTO learners(tenant_id, name) VALUES (?, ?) RETURNING id`);
    const insEnroll = db.prepare(
      `INSERT INTO enrollments(tenant_id, course_id, learner_id, status) VALUES (?, ?, ?, 'completed')`
    );
    const insCert = db.prepare(
      `INSERT INTO certificates(tenant_id, course_id, learner_id, serial, issued_at_utc, local_date, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`
    );

    const serials = reserveSerials(db, tenantId.id, year, count, tenantId.slug);

    for (let i = 0; i < count; i++) {
      const name = `Bulk Learner-${String(i + 1).padStart(6, '0')}`;
      const lid = insLearner.get(tenantId.id, name).id;
      insEnroll.run(tenantId.id, course.id, lid);
      insCert.run(tenantId.id, course.id, lid, serials[i], now, localDate);
    }
  });

  const t0 = Date.now();
  tx();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`inserted ${count} certificate rows for tenant '${tenant}' in ${secs}s (local_date ${localDate})`);
  closeDb(db);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const getArg = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
  };
  seedBulk(null, { tenant: String(getArg('--tenant', 'east')), count: Number(getArg('--count', 100000)) });
}