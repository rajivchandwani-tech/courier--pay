'use strict';

const { isAuthenticated } = require('./auth');

const MAX_BODY = 3 * 1024 * 1024;
const MAX_INVOICES = 10000;

function send(res, status, payload) {
  res.statusCode = status;
  if (status === 204 || payload === '') { res.end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  if (req.body !== undefined) {
    try { return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})); }
    catch { return Promise.reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 })); }
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > MAX_BODY) {
        reject(Object.assign(new Error('Request is too large.'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function validState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  if (!Array.isArray(state.invoices) || state.invoices.length > MAX_INVOICES) return false;
  if (!Array.isArray(state.deleted) || state.deleted.length > MAX_INVOICES) return false;
  if (!state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings)) return false;
  if (!Number.isSafeInteger(Number(state.counter)) || Number(state.counter) < 0) return false;
  const ids = new Set();
  for (const invoice of state.invoices) {
    if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) return false;
    if (!(typeof invoice.id === 'string' || (typeof invoice.id === 'number' && Number.isFinite(invoice.id)))) return false;
    if (!String(invoice.id).trim() || String(invoice.id).length > 100 || ids.has(String(invoice.id))) return false;
    ids.add(String(invoice.id));
    if (typeof invoice.num !== 'string' || invoice.num.length > 160 || typeof invoice.client !== 'string' || invoice.client.length > 240) return false;
    if (![Number(invoice.amount), Number(invoice.gst || 0)].every(Number.isFinite) || Number(invoice.amount) < 0 || Number(invoice.gst || 0) < 0) return false;
    // Cash/Credit customer type — default 'credit' for backward compatibility
    if (invoice.customer_type !== undefined && !['cash', 'credit'].includes(invoice.customer_type)) return false;
    // paid_amount must be a non-negative number when present
    if (invoice.paid_amount !== undefined && (!Number.isFinite(Number(invoice.paid_amount)) || Number(invoice.paid_amount) < 0)) return false;
    // part_payments must be an array of valid payment objects
    if (invoice.part_payments !== undefined) {
      if (!Array.isArray(invoice.part_payments)) return false;
      for (const p of invoice.part_payments) {
        if (!p || typeof p !== 'object') return false;
        if (typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return false;
        if (!Number.isFinite(Number(p.amount)) || Number(p.amount) <= 0) return false;
        if (p.mode !== undefined && typeof p.mode !== 'string') return false;
        if (p.ref !== undefined && typeof p.ref !== 'string') return false;
      }
    }
    if (JSON.stringify(invoice).length > 50000) return false;
  }
  for (const item of state.deleted) {
    if (!item || (typeof item.id !== 'string' && typeof item.id !== 'number') || !Number.isFinite(Date.parse(item.deletedAt))) return false;
  }
  for (const value of Object.values(state.settings)) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) return false;
  }
  const size = Buffer.byteLength(JSON.stringify(state), 'utf8');
  return size <= MAX_BODY - 256;
}

const ACTIVITY_TYPES = new Set(['invoice_created', 'invoice_updated', 'invoice_deleted', 'invoice_marked_paid', 'payment_recorded', 'settings_updated', 'history_initialized', 'bulk_invoice_change', 'data_changed', 'finance_entry_created', 'finance_entry_updated', 'finance_entry_deleted', 'finance_entry_voided', 'finance_payment_recorded']);
// Which categories are allowed to be written through this endpoint. `finance`
// was missing, so every expense/salary/vehicle activity event that a browser
// tried to record through /api/app-state was rejected with a 400 and silently
// lost — while the identical event written directly by ledger.js succeeded,
// which is why some finance events appear and others do not.
const ACTIVITY_CATEGORIES = new Set(['sale', 'payment', 'settings', 'system', 'finance']);
function cleanActivityEvents(input) {
  if (!Array.isArray(input) || input.length > 1000) return null;
  const allowedKeys = new Set(['type', 'category', 'recordId', 'reference', 'party', 'amount', 'transactionDate', 'summary', 'count']);
  const result = [];
  for (const event of input) {
    if (!event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).some(key => !allowedKeys.has(key))) return null;
    if (!ACTIVITY_TYPES.has(event.type) || !ACTIVITY_CATEGORIES.has(event.category)) return null;
    if (event.amount !== null && event.amount !== undefined && (!Number.isFinite(Number(event.amount)) || Number(event.amount) < 0)) return null;
    if (event.count !== undefined && (!Number.isSafeInteger(Number(event.count)) || Number(event.count) < 0 || Number(event.count) > 10000)) return null;
    const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
    const transactionDate = text(event.transactionDate, 10);
    if (transactionDate && !/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) return null;
    result.push({
      type: event.type, category: event.category,
      recordId: text(event.recordId, 100), reference: text(event.reference, 160),
      party: text(event.party, 240), amount: event.amount === null || event.amount === undefined ? null : Number(event.amount),
      transactionDate, summary: text(event.summary, 300),
      ...(event.count === undefined ? {} : { count: Number(event.count) })
    });
  }
  return result;
}

module.exports = async function handler(req, res) {
  // CORS preflight must be answered before the origin check — otherwise any
  // cross-origin caller gets a 405 and the browser reports a generic network error.
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
    return send(res, 204, '');
  }
  // Auth gate — every protected endpoint requires a valid session token
  if (!isAuthenticated(req)) return send(res, 401, { error: 'Authentication required.' });
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return send(res, 405, { error: 'Method not allowed.' });
  }
  const origin = req.headers && req.headers.origin;
  const allowedHosts = [req.headers && req.headers.host, req.headers && req.headers['x-forwarded-host'], process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean);
  if (origin && allowedHosts.length) {
    try {
      if (allowedHosts.indexOf(new URL(origin).host) < 0) return send(res, 403, { error: 'Cross-site request blocked.' });
    } catch { return send(res, 403, { error: 'Invalid request origin.' }); }
  }
  if (!process.env.DATABASE_URL) return send(res, 503, { error: 'Shared database is not connected.' });

  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS courierpay_app_state (
      id text PRIMARY KEY,
      state jsonb NOT NULL,
      revision bigint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS courierpay_activity_events (
      id bigserial PRIMARY KEY,
      event jsonb NOT NULL,
      client_id text NOT NULL DEFAULT 'unknown',
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    if (req.method === 'GET') {
      const rows = await sql`SELECT state, revision FROM courierpay_app_state WHERE id = 'shared'`;
      return send(res, 200, { state: rows.length ? rows[0].state : null, revision: rows.length ? Number(rows[0].revision) : 0 });
    }

    let body;
    try { body = await readBody(req); }
    catch (error) { return send(res, error.status || 400, { error: error.message || 'Could not read request.' }); }
    const expectedRevision = Number(body.expectedRevision);
    const rawActivityEvents = body.activityEvents === undefined ? [{ type: 'data_changed', category: 'system', recordId: '', reference: '', party: '', amount: null, transactionDate: '', summary: 'Shared invoice or settings data changed in an older CourierPay browser.' }] : body.activityEvents;
    const activityEvents = cleanActivityEvents(rawActivityEvents);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !validState(body.state) || !activityEvents) return send(res, 400, { error: 'The shared invoice data is invalid.' });
    const encoded = JSON.stringify(body.state);
    const encodedEvents = JSON.stringify(activityEvents);
    const clientId = typeof body.clientId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(body.clientId) ? body.clientId : 'unknown';

    if (expectedRevision === 0) {
      const inserted = await sql`WITH saved AS (
          INSERT INTO courierpay_app_state (id, state, revision) VALUES ('shared', ${encoded}::jsonb, 1)
          ON CONFLICT (id) DO NOTHING RETURNING revision
        ), logged AS (
          INSERT INTO courierpay_activity_events (event, client_id)
          SELECT item.event, ${clientId} FROM saved CROSS JOIN jsonb_array_elements(${encodedEvents}::jsonb) AS item(event)
          RETURNING id
        ) SELECT revision FROM saved`;
      if (inserted.length) return send(res, 200, { saved: true, revision: Number(inserted[0].revision) });
    } else {
      const updated = await sql`WITH saved AS (
          UPDATE courierpay_app_state SET state = ${encoded}::jsonb, revision = revision + 1, updated_at = now()
          WHERE id = 'shared' AND revision = ${expectedRevision} RETURNING revision
        ), logged AS (
          INSERT INTO courierpay_activity_events (event, client_id)
          SELECT item.event, ${clientId} FROM saved CROSS JOIN jsonb_array_elements(${encodedEvents}::jsonb) AS item(event)
          RETURNING id
        ) SELECT revision FROM saved`;
      if (updated.length) return send(res, 200, { saved: true, revision: Number(updated[0].revision) });
    }

    const latest = await sql`SELECT state, revision FROM courierpay_app_state WHERE id = 'shared'`;
    return send(res, 409, { conflict: true, state: latest.length ? latest[0].state : null, revision: latest.length ? Number(latest[0].revision) : 0 });
  } catch (error) {
    console.error('Shared app state request failed:', error.message);
    return send(res, 503, { error: 'Shared invoice storage is temporarily unavailable. Try again shortly.' });
  }
};
