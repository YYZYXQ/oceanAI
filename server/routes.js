import { Router } from 'express';
import Database from 'better-sqlite3';
import {
  tenantLocalDate,
  tenantLocalDateTime,
  tenantLocalYear,
  reserveSerials,
  csvField,
  hashRequest,
} from './helpers.js';

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const SORT_COLS = {
  local_date: 'c.local_date',
  learner_name: 'l.name',
  serial: 'c.serial',
  id: 'c.id',
};

function escapeLike(s) {
  return String(s || '').replace(/[\\%_]/g, (m) => `\\${m}`);
}

const CERT_DETAIL_QUERY = `
  SELECT c.id, c.serial, c.status, c.issued_at_utc, c.local_date,
         c.revoked_at_utc, c.revoke_reason,
         l.id AS learner_id, l.name AS learner_name,
         co.id AS course_id, co.title AS course_title
  FROM certificates c
   JOIN learners l ON l.id = c.learner_id
   JOIN courses co ON co.id = c.course_id
  WHERE c.id = ?
`;

function actorMiddleware(db) {
  const get = db.prepare(
    `SELECT a.id AS admin_id, a.email,
            t.id AS tenant_id, t.slug AS tenant_slug, t.tz AS tenant_tz
     FROM admins a JOIN tenants t ON t.id = a.tenant_id
     WHERE a.email = ?`
  );
  return (req, res, next) => {
    const email = String(req.headers['x-user'] || '').trim().toLowerCase();
    if (!email) return res.status(401).json({ error: 'missing X-User header' });
    const admin = get.get(email);
    if (!admin) return res.status(401).json({ error: 'unknown actor' });
    req.actor = admin;
    next();
  };
}

export function buildRouter(db) {
  const router = Router();
  const auth = actorMiddleware(db);

  router.get('/health', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });

  router.get('/schema', (req, res) => {
    const tenants = db.prepare(`SELECT id, slug, tz FROM tenants ORDER BY id`).all();
    const admins = db
      .prepare(`SELECT a.id, a.email, t.id AS tenant_id, t.slug AS tenant_slug FROM admins a JOIN tenants t ON t.id = a.tenant_id ORDER BY a.id`)
      .all();
    const courses = db
      .prepare(`SELECT co.id, co.title, co.tenant_id, t.slug AS tenant_slug FROM courses co JOIN tenants t ON t.id = co.tenant_id ORDER BY co.id`)
      .all();
    res.json({ tenants, admins, courses });
  });

  // ---- Certificate list ---------------------------------------------------
  router.get('/certs', auth, (req, res) => {
    const { q, sort = 'local_date', order = 'desc', page = '1', size = '20' } = req.query;
    const col = SORT_COLS[sort] || SORT_COLS.local_date;
    const ord = order === 'asc' ? 'ASC' : 'DESC';
    const sizeN = Math.min(Math.max(parseInt(size, 10) || 20, 1), 100);
    const pageN = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (pageN - 1) * sizeN;

    const like = q && q.trim() ? `%${escapeLike(q)}%` : null;
    const where = like
      ? `WHERE c.tenant_id = @tid AND (l.name LIKE @q ESCAPE '\\' OR c.serial LIKE @q ESCAPE '\\')`
      : `WHERE c.tenant_id = @tid`;

    const items = db
      .prepare(
        `SELECT c.id, c.serial, c.status, c.issued_at_utc, c.local_date,
                l.name AS learner_name, co.title AS course_title
         FROM certificates c
          JOIN learners l ON l.id = c.learner_id
          JOIN courses co ON co.id = c.course_id
         ${where}
         ORDER BY ${col} ${ord}, c.id ASC
         LIMIT @lim OFFSET @off`
      )
      .all({ tid: req.actor.tenant_id, q: like, lim: sizeN, off: offset });

    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM certificates c JOIN learners l ON l.id = c.learner_id ${where}`)
      .get({ tid: req.actor.tenant_id, q: like }).n;

    res.json({ items, total, page: pageN, size: sizeN });
  });

  // ---- CSV export (streamed, concurrent-safe) -----------------------------
  // Declared BEFORE '/certs/:id' so Express does not route 'export' as an id.
  router.get('/certs/export', auth, async (req, res) => {
    const { q, sort = 'local_date', order = 'desc' } = req.query;
    const col = SORT_COLS[sort] || SORT_COLS.local_date;
    const ord = order === 'asc' ? 'ASC' : 'DESC';
    const like = q && q.trim() ? `%${escapeLike(q)}%` : null;
    const where = like
      ? `WHERE c.tenant_id = @tid AND (l.name LIKE @q ESCAPE '\\' OR c.serial LIKE @q ESCAPE '\\')`
      : `WHERE c.tenant_id = @tid`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="certificates.csv"`);
    res.write('\uFEFF'); // BOM so Excel opens UTF-8 correctly
    res.write(`learner_name,course_title,serial,issue_date\r\n`);

    const dbPath =
      process.env.DB_PATH && process.env.DB_PATH !== ':memory:'
        ? process.env.DB_PATH
        : db.name;
    const conn = new Database(dbPath, { readonly: true });
    try {
      const stmt = conn.prepare(
        `SELECT l.name AS learner_name, co.title AS course_title, c.serial, c.local_date
         FROM certificates c
          JOIN learners l ON l.id = c.learner_id
          JOIN courses co ON co.id = c.course_id
         ${where}
         ORDER BY ${col} ${ord}, c.id ASC`
      );
      const params = { tid: req.actor.tenant_id, q: like };
      let buf = '';
      for (const row of stmt.iterate(params)) {
        buf += `${csvField(row.learner_name)},${csvField(row.course_title)},${csvField(row.serial)},${csvField(row.local_date)}\r\n`;
        if (buf.length >= 262144) {
          res.write(buf);
          buf = '';
          await new Promise((r) => setImmediate(r)); // yield; other requests run
        }
      }
      if (buf) res.write(buf);
      res.end();
    } catch (e) {
      console.error('export failed', e);
      if (!res.headersSent) res.status(500).json({ error: 'export failed' });
      else res.destroy();
    } finally {
      conn.close();
    }
  });

  // ---- Certificate detail (cross-tenant -> 404) -----------------------------
  router.get('/certs/:id', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'not found' });
    const row = db.prepare(`${CERT_DETAIL_QUERY} AND c.tenant_id = ?`).get(id, req.actor.tenant_id);
    if (!row) return res.status(404).json({ error: 'not found' });
    const local = tenantLocalDateTime(row.issued_at_utc, req.actor.tenant_tz);
    const audits = db
      .prepare(`SELECT action, actor, at_utc, reason FROM audit_events WHERE cert_id = ? AND tenant_id = ? ORDER BY id`)
      .all(id, req.actor.tenant_id);
    const { issued_at_utc, ...rest } = row;
    res.json({ ...rest, localDateTime: `${local.date} ${local.time}`, audits });
  });

  // ---- Bulk issue (idempotent) -------------------------------------------------
  const KEY_INSERT = db.prepare(
    `INSERT INTO idempotency_keys(tenant_id, key, request_hash, state, result_json, created_at, updated_at)
     VALUES (?, ?, ?, 'running', NULL, ?, ?)
     ON CONFLICT(tenant_id, key) DO NOTHING`
  );
  const KEY_GET = db.prepare(`SELECT * FROM idempotency_keys WHERE tenant_id = ? AND key = ?`);
  const KEY_DONE = db.prepare(
    `UPDATE idempotency_keys SET state = 'done', result_json = ?, updated_at = ? WHERE tenant_id = ? AND key = ?`
  );
  const KEY_DELETE = db.prepare(`DELETE FROM idempotency_keys WHERE tenant_id = ? AND key = ?`);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitForIdempotency(db, tenantId, key, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const row = KEY_GET.get(tenantId, key);
      if (!row) throw httpErr(409, 'idempotency record disappeared');
      if (row.state === 'done') return row;
      await sleep(25);
    }
    throw httpErr(504, 'idempotent operation still running; try again shortly');
  }

  function issueAll(db, { tenantId, tenantSlug, tenantTz, courseId, actor, now }) {
    const course = db
      .prepare(`SELECT id, title FROM courses WHERE id = ? AND tenant_id = ?`)
      .get(courseId, tenantId);
    if (!course) throw httpErr(404, 'course not found in this tenant');

    const enrolled = db
      .prepare(
        `SELECT l.id AS learner_id, l.name, e.status,
                (SELECT 1 FROM certificates c0
                  WHERE c0.course_id = ? AND c0.learner_id = l.id AND c0.status = 'active') AS already
         FROM learners l
          JOIN enrollments e ON e.learner_id = l.id AND e.course_id = ?
         WHERE e.tenant_id = ? AND e.course_id = ?
         ORDER BY l.id`
      )
      .all(courseId, courseId, tenantId, courseId);

    const toIssue = enrolled.filter((r) => r.status === 'completed' && !r.already);
    const year = tenantLocalYear(now, tenantTz);
    const serials = reserveSerials(db, tenantId, year, toIssue.length, tenantSlug);

    const insCert = db.prepare(
      `INSERT INTO certificates(tenant_id, course_id, learner_id, serial, issued_at_utc, local_date, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`
    );
    const insAudit = db.prepare(
      `INSERT INTO audit_events(tenant_id, actor, cert_id, action, at_utc, reason)
       VALUES (?, ?, ?, 'issue', ?, NULL)`
    );

    const outcomes = enrolled.map((r) => {
      if (r.status !== 'completed') {
        return { learnerId: r.learner_id, name: r.name, outcome: 'skipped', reason: 'not_completed' };
      }
      if (r.already) {
        return { learnerId: r.learner_id, name: r.name, outcome: 'skipped', reason: 'already_certified' };
      }
      return null; // filled below
    });

    let issued = 0;
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i];
      if (o) continue;
      const serial = serials[issued];
      issued++;
      const cert = insCert.run(
        tenantId,
        courseId,
        enrolled[i].learner_id,
        serial,
        now,
        tenantLocalDate(now, tenantTz)
      );
      insAudit.run(tenantId, actor, cert.lastInsertRowid, now);
      outcomes[i] = {
        learnerId: enrolled[i].learner_id,
        name: enrolled[i].name,
        outcome: 'issued',
        serial,
      };
    }

    return {
      courseId,
      courseTitle: course.title,
      outcomes,
      counts: { issued, skipped: outcomes.length - issued },
    };
  }

  router.post('/certs/bulk', auth, async (req, res) => {
    try {
      const courseId = Number(req.body && req.body.courseId);
      if (!Number.isInteger(courseId)) throw httpErr(400, 'courseId required');
      const key = String(req.headers['idempotency-key'] || '').trim();
      if (!key) throw httpErr(400, 'Idempotency-Key header required');

      // Course must exist in the caller's tenant BEFORE any write happens
      // (A1: cross-tenant bulk creates no certificates and no audit events).
      const course = db.prepare(`SELECT id FROM courses WHERE id = ? AND tenant_id = ?`).get(courseId, req.actor.tenant_id);
      if (!course) throw httpErr(404, 'course not found in this tenant');

      const hash = hashRequest({ courseId });
      const now = Date.now();
      const inserted = KEY_INSERT.run(req.actor.tenant_id, key, hash, now, now);

      let body;
      if (inserted.changes === 1) {
        try {
          body = db.transaction(() =>
            issueAll(db, {
              tenantId: req.actor.tenant_id,
              tenantSlug: req.actor.tenant_slug,
              tenantTz: req.actor.tenant_tz,
              courseId,
              actor: req.actor.email,
              now,
            })
          )();
          KEY_DONE.run(JSON.stringify(body), Date.now(), req.actor.tenant_id, key);
        } catch (e) {
          KEY_DELETE.run(req.actor.tenant_id, key);
          throw e;
        }
      } else {
        const row = KEY_GET.get(req.actor.tenant_id, key);
        if (row.request_hash !== hash) {
          throw httpErr(409, 'idempotency key already used with a different request payload');
        }
        const done = await waitForIdempotency(db, req.actor.tenant_id, key);
        if (done.state !== 'done') throw httpErr(500, 'original operation did not complete');
        body = JSON.parse(done.result_json);
      }
      res.json(body);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('bulk issue failed', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ---- Revoke (idempotent, audited) -----------------------------------------
  router.post('/certs/:id/revoke', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'not found' });
    const cert = db.prepare(`${CERT_DETAIL_QUERY} AND c.tenant_id = ?`).get(id, req.actor.tenant_id);
    if (!cert) return res.status(404).json({ error: 'not found' });
    const reason = String((req.body && req.body.reason) || '').trim() || null;

    if (cert.status === 'revoked') {
      return res.json({ id, serial: cert.serial, status: 'revoked', alreadyRevoked: true });
    }

    const atUtc = Date.now();
    db.transaction(() => {
      db.prepare(
        `UPDATE certificates SET status = 'revoked', revoked_at_utc = ?, revoke_reason = ? WHERE id = ? AND tenant_id = ?`
      ).run(atUtc, reason, id, req.actor.tenant_id);
      db.prepare(
        `INSERT INTO audit_events(tenant_id, actor, cert_id, action, at_utc, reason) VALUES (?, ?, ?, 'revoke', ?, ?)`
      ).run(req.actor.tenant_id, req.actor.email, id, atUtc, reason);
    })();
    res.json({ id, serial: cert.serial, status: 'revoked' });
  });

  return router;
}