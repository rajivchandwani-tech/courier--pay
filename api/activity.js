'use strict';

function send(res, status, payload) {
  res.statusCode = status;
  if (status === 204 || payload === '') { res.end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  // CORS preflight must be answered before the origin check — otherwise any
  // cross-origin caller gets a 405 and the browser reports a generic network error.
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return send(res, 204, '');
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return send(res, 405, { error: 'Method not allowed.' });
  }
  const origin = req.headers && req.headers.origin;
  const allowedHosts = [req.headers && req.headers.host, req.headers && req.headers['x-forwarded-host'], process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean);
  if (origin && allowedHosts.length) {
    try {
      if (allowedHosts.indexOf(new URL(origin).host) < 0) return send(res, 403, { error: 'Cross-site request blocked.' });
    } catch { return send(res, 403, { error: 'Invalid request origin.' }); }
  }
  if (!process.env.DATABASE_URL) return send(res, 503, { error: 'Shared activity history is not connected.' });

  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS courierpay_activity_events (
      id bigserial PRIMARY KEY,
      event jsonb NOT NULL,
      client_id text NOT NULL DEFAULT 'unknown',
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    const url = new URL(req.url, 'https://courierpay.local');
    const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50));
    const beforeRaw = url.searchParams.get('before');
    const afterRaw = url.searchParams.get('after');
    let rows;
    let hasMore = false;
    if (url.searchParams.get('latest') === '1') {
      rows = await sql`SELECT id, event, client_id, created_at FROM courierpay_activity_events ORDER BY id DESC LIMIT ${limit + 1}`;
      hasMore = rows.length > limit;
      rows = rows.slice(0, limit).reverse();
    } else if (beforeRaw !== null) {
      const before = Number.parseInt(beforeRaw, 10);
      if (!Number.isSafeInteger(before) || before < 1) return send(res, 400, { error: 'Invalid activity cursor.' });
      rows = await sql`SELECT id, event, client_id, created_at FROM courierpay_activity_events WHERE id < ${before} ORDER BY id DESC LIMIT ${limit + 1}`;
      hasMore = rows.length > limit;
      rows = rows.slice(0, limit).reverse();
    } else {
      const after = Number.parseInt(afterRaw || '0', 10);
      if (!Number.isSafeInteger(after) || after < 0) return send(res, 400, { error: 'Invalid activity cursor.' });
      rows = await sql`SELECT id, event, client_id, created_at FROM courierpay_activity_events WHERE id > ${after} ORDER BY id ASC LIMIT ${limit}`;
    }
    const events = rows.map(row => ({ id: Number(row.id), event: row.event, clientId: row.client_id, recordedAt: row.created_at }));
    const [latest] = await sql`SELECT COALESCE(MAX(id), 0) AS latest_id FROM courierpay_activity_events`;
    return send(res, 200, { events, cursor: events.length ? events[events.length - 1].id : Number(latest.latest_id) || 0, hasMore });
  } catch (error) {
    console.error('Activity log request failed:', error.message);
    return send(res, 503, { error: 'Shared activity history is temporarily unavailable.' });
  }
};
