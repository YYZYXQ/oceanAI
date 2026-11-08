let actor = null;

export function setActor(email) {
  actor = email;
}
export function getActor() {
  return actor;
}

async function req(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (actor) headers['X-User'] = actor;
  const res = await fetch('/api' + path, { ...opts, headers });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {
      /* non-JSON */
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const api = {
  schema: () => req('/schema'),
  list: (p) => req('/certs?' + new URLSearchParams(p)),
  detail: (id) => req('/certs/' + id),
  bulk: (courseId, key) =>
    req('/certs/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ courseId }),
    }),
  revoke: (id, reason) =>
    req(`/certs/${id}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    }),
};

export async function downloadCsv(params) {
  const headers = {};
  if (actor) headers['X-User'] = actor;
  const res = await fetch('/api/certs/export?' + new URLSearchParams(params), { headers });
  if (!res.ok) throw new Error(`export failed (HTTP ${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'certificates.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}