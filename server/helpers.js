import { createHash } from 'node:crypto';

// Tenant-local timezone formatting and serial reservation helpers.

function fmt(parts, keys) {
  const out = {};
  for (const p of parts) out[p.type] = p.value;
  return keys.map((k) => out[k]).join('-');
}

// Returns YYYY-MM-DD calendar date of `utcMs` in the given IANA timezone.
export function tenantLocalDate(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt(dtf.formatToParts(new Date(utcMs)), ['year', 'month', 'day']);
}

// Returns { date: 'YYYY-MM-DD', time: 'HH:mm' } in the tenant timezone.
export function tenantLocalDateTime(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export function tenantLocalYear(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' });
  return Number(dtf.format(new Date(utcMs)));
}

// Reserve `n` serial numbers for (tenant, year). Must be called inside a transaction.
export function reserveSerials(db, tenantId, year, n, slug) {
  const upd = db.prepare(
    `INSERT INTO serial_counters(tenant_id, year, last_seq) VALUES (?, ?, ?)
     ON CONFLICT(tenant_id, year) DO UPDATE SET last_seq = serial_counters.last_seq + ?
     RETURNING last_seq`
  );
  const { last_seq } = upd.get(tenantId, year, n, n);
  const seqs = [];
  const prefix = String(slug).toUpperCase();
  for (let s = last_seq - n + 1; s <= last_seq; s++) seqs.push(`${prefix}-${year}-${String(s).padStart(6, '0')}`);
  return seqs;
}

// CSV field escaping per RFC 4180.
export function csvField(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function hashRequest(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}