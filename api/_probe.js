'use strict';

// TEMPORARY read-only diagnostic — removed once the activity-log question is
// answered. Returns the raw activity rows plus a count, gated by APP_PASSWORD
// so it is not a public data leak.

const crypto = require('node:crypto');

const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'travel-point-os-session-key';

function send(res, status, payload) {
  res.statusCode = status;
  if (status === 204 || payload === '') { res.end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const dot = token.indexOf('.');
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Token');
    return send(res, 204, '');
  }
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET, OPTIONS'); return send(res, 405, { error: 'Method not allowed.' }); }

  // Gate: either a valid session token, or the app password itself.
  const hdr = req.headers['x-app-token'] || '';
  const ok = verify(hdr) || (APP_PASSWORD && req.headers['x-app-password'] === APP_PASSWORD);
  if (!ok) return send(res, 401, { error: 'Authentication required.' });

  if (!process.env.DATABASE_URL) return send(res, 503, { error: 'DATABASE_URL missing.' });

  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);

    const tables = await sql`SELECT table_name FROM information_schema.tables
                              WHERE table_schema='public' ORDER BY 1`;
    const tablesList = tables.map(t => t.table_name);

    const out = { tables: tablesList };

    if (tablesList.includes('courierpay_activity_events')) {
      const c = await sql`SELECT count(*)::int AS n, max(id)::int AS maxid,
                                  max(created_at) AS last
                           FROM courierpay_activity_events`;
      out.activity = { count: c[0].n, maxId: c[0].maxid, lastCreatedAt: c[0].last };

      const rows = await sql`SELECT id, event, client_id, created_at
                              FROM courierpay_activity_events
                              ORDER BY id DESC LIMIT 40`;
      out.activity.recent = rows.map(r => ({
        id: Number(r.id),
        type: r.event && (r.event.type || r.event.action || r.event.kind) || null,
        actor: r.event && (r.event.actor || r.event.user || r.event.userName || r.event.by) || null,
        clientId: r.client_id,
        createdAt: r.created_at,
        eventKeys: r.event ? Object.keys(r.event) : [],
      }));
    } else {
      out.activity = { error: 'table courierpay_activity_events does not exist' };
    }

    return send(res, 200, out);
  } catch (error) {
    console.error('debug route failed:', error.message);
    return send(res, 503, { error: 'probe failed', detail: error.message });
  }
};
