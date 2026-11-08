import { pathToFileURL } from 'node:url';
import { openDb, closeDb } from '../db.js';
import { tenantLocalDate } from '../helpers.js';

// Demo dataset (idempotent: does nothing if admins already exist).
// East and West tenants; two admins; "Safety 101" course in each tenant;
// Alex Lee in both; a mixed eligibility set for A4; two A5 certificates
// issued at 2026-01-10T13:30:00Z.
const A5_TIMESTAMP = Date.parse('2026-01-10T13:30:00Z');

export function setup(database, dbPath) {
  const db = database || openDb(dbPath);
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM admins`).get();
  if (existing.n > 0) {
    if (!database) closeDb(db);
    return { seeded: false, db };
  }

  const tx = db.transaction(() => {
    // Tenants
    const insTenant = db.prepare(`INSERT INTO tenants(slug, tz) VALUES (?, ?) RETURNING id`);
    const eastId = insTenant.get('east', 'Australia/Sydney').id;
    const westId = insTenant.get('west', 'Australia/Perth').id;

    // Admins
    const insAdmin = db.prepare(`INSERT INTO admins(tenant_id, email) VALUES (?, ?)`);
    insAdmin.run(eastId, 'alice@east.test');
    insAdmin.run(westId, 'bob@west.test');

    // Courses (East also carries a second course so the reuse-of-an-idempotency-key
    // with a *different* payload scenario in A3 has a distinct courseId to use.)
    const insCourse = db.prepare(`INSERT INTO courses(tenant_id, title) VALUES (?, ?) RETURNING id`);
    const eastCourseId = insCourse.get(eastId, 'Safety 101').id;
    const eastCourse2Id = insCourse.get(eastId, 'First Aid Refresher').id;
    const westCourseId = insCourse.get(westId, 'Safety 101').id;

    // Learners + enrollments (East)
    const insLearner = db.prepare(`INSERT INTO learners(tenant_id, name) VALUES (?, ?) RETURNING id`);
    const insEnroll = db.prepare(
      `INSERT INTO enrollments(tenant_id, course_id, learner_id, status) VALUES (?, ?, ?, ?)`
    );

    // East: Alex Lee (completed + already certified), Riley Stone (completed,
    // eligible), Casey Wren (completed, eligible), Jordan Blake (incomplete).
    const eastLearners = [
      ['Alex Lee', 'completed', true],
      ['Riley Stone', 'completed', false],
      ['Casey Wren', 'completed', false],
      ['Jordan Blake', 'incomplete', false],
    ];
    const eastIds = eastLearners.map(([name]) => {
      const r = insLearner.get(eastId, name);
      return { name, id: r.id };
    });
    for (let i = 0; i < eastLearners.length; i++) {
      const [name, status] = eastLearners[i];
      const lid = eastIds.find((e) => e.name === name).id;
      insEnroll.run(eastId, eastCourseId, lid, status);
    }

    // West: Alex Lee (completed + already certified), Riley Stone (completed,
    // eligible), Morgan Reed (incomplete).
    const westLearners = [
      ['Alex Lee', 'completed', true],
      ['Riley Stone', 'completed', false],
      ['Morgan Reed', 'incomplete', false],
    ];
    const westIds = westLearners.map(([name]) => {
      const r = insLearner.get(westId, name);
      return { name, id: r.id };
    });
    for (let i = 0; i < westLearners.length; i++) {
      const [name, status] = westLearners[i];
      const lid = westIds.find((e) => e.name === name).id;
      insEnroll.run(westId, westCourseId, lid, status);
    }

    // Certificates for the A5 scenario: same UTC instant, different local dates.
    const insCert = db.prepare(
      `INSERT INTO certificates(tenant_id, course_id, learner_id, serial, issued_at_utc, local_date, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`
    );
    const eastAlex = eastIds.find((e) => e.name === 'Alex Lee').id;
    const westAlex = westIds.find((e) => e.name === 'Alex Lee').id;
    insCert.run(eastId, eastCourseId, eastAlex, 'EAST-2026-000001', A5_TIMESTAMP, tenantLocalDate(A5_TIMESTAMP, 'Australia/Sydney'));
    insCert.run(westId, westCourseId, westAlex, 'WEST-2026-000001', A5_TIMESTAMP, tenantLocalDate(A5_TIMESTAMP, 'Australia/Perth'));

    // Serial counters already advanced by the two seeded certs via RETURNING-path:
    // reserve the two serials explicitly so later bulk issues continue sequentially.
    const insCounter = db.prepare(
      `INSERT INTO serial_counters(tenant_id, year, last_seq) VALUES (?, ?, ?)
       ON CONFLICT(tenant_id, year) DO UPDATE SET last_seq = serial_counters.last_seq`
    );
    insCounter.run(eastId, 2026, 1);
    insCounter.run(westId, 2026, 1);
  });

  tx();
  if (!database) closeDb(db);
  return { seeded: true, db };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { seeded } = setup(null);
  console.log(seeded ? 'demo data seeded' : 'demo data already present');
}