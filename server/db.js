import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  tz TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  email TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS learners (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  title TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  learner_id INTEGER NOT NULL REFERENCES learners(id),
  status TEXT NOT NULL CHECK (status IN ('completed','incomplete')),
  UNIQUE (course_id, learner_id)
);
CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  learner_id INTEGER NOT NULL REFERENCES learners(id),
  serial TEXT UNIQUE NOT NULL,
  issued_at_utc INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  revoked_at_utc INTEGER,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_cert_tenant ON certificates(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cert_local ON certificates(tenant_id, local_date);
CREATE INDEX IF NOT EXISTS idx_cert_serial ON certificates(serial);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  actor TEXT NOT NULL,
  cert_id INTEGER NOT NULL REFERENCES certificates(id),
  action TEXT NOT NULL CHECK (action IN ('issue','revoke')),
  at_utc INTEGER NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_cert ON audit_events(cert_id, action);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','done','error')),
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, key)
);
CREATE TABLE IF NOT EXISTS serial_counters (
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  year INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, year)
);
`;

export function defaultDbPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'data.db');
}

export function openDb(dbPath = process.env.DB_PATH || defaultDbPath()) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

export function closeDb(db) {
  try { db.close(); } catch { /* already closed */ }
}