'use strict';

const { isAuthenticated } = require('./auth');

const MAX_BODY = 1 * 1024 * 1024;

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

const BILLING_PERIODS = new Set(['none', 'weekly', 'monthly', 'custom']);

function validClient(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  if (typeof c.id !== 'string' || c.id.length > 100) return false;
  if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 240) return false;
  if (c.phone !== undefined && c.phone !== '' && (typeof c.phone !== 'string' || c.phone.length > 24)) return false;
  if (c.email !== undefined && c.email !== '' && (typeof c.email !== 'string' || c.email.length > 200)) return false;
  if (c.type !== undefined && !['cash', 'credit'].includes(c.type)) return false;
  if (c.billing_period !== undefined && !BILLING_PERIODS.has(c.billing_period)) return false;
  if (c.prefix !== undefined && c.prefix !== '' && (typeof c.prefix !== 'string' || c.prefix.length > 20)) return false;
  if (c.notes !== undefined && c.notes !== '' && (typeof c.notes !== 'string' || c.notes.length > 2000)) return false;
  return true;
}

function cleanClient(c) {
  return {
    id: c.id,
    name: c.name.trim(),
    phone: c.phone || '',
    email: c.email || '',
    type: c.type || 'credit',
    billing_period: c.billing_period || 'none',
    prefix: c.prefix || '',
    notes: c.notes || ''
  };
}

module.exports = function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
    return send(res, 204, '');
  }
  if (!isAuthenticated(req)) return send(res, 401, { error: 'Authentication required.' });
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, PUT, DELETE, OPTIONS');
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

  return import('@neondatabase/serverless').then(({ neon }) => {
    const sql = neon(process.env.DATABASE_URL);
    return sql`CREATE TABLE IF NOT EXISTS courierpay_clients (
      id text PRIMARY KEY,
      name text NOT NULL,
      phone text DEFAULT '',
      email text DEFAULT '',
      type text NOT NULL DEFAULT 'credit',
      billing_period text NOT NULL DEFAULT 'none',
      prefix text DEFAULT '',
      notes text DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
          )`.then(() => {
      if (req.method === 'GET') {
        return sql`SELECT * FROM courierpay_clients ORDER BY name`
          .then(rows => send(res, 200, { clients: rows }))
          .catch(error => send(res, 503, { error: 'Client storage is temporarily unavailable. Try again shortly.' }));
      }

      return readBody(req).then(body => {
        if (req.method === 'POST') {
          if (!validClient(body)) return send(res, 400, { error: 'Invalid client data.' });
          const c = cleanClient(body);
          return sql`SELECT id FROM courierpay_clients WHERE id = ${c.id}`
            .then(existing => {
              if (existing.length) return send(res, 409, { error: 'Client with this ID already exists.' });
              return sql`INSERT INTO courierpay_clients (id, name, phone, email, type, billing_period, prefix, notes)
                        VALUES (${c.id}, ${c.name}, ${c.phone}, ${c.email}, ${c.type}, ${c.billing_period}, ${c.prefix}, ${c.notes})`
                .then(() => send(res, 201, { client: c }));
            });
        }

        if (req.method === 'PUT') {
          if (!validClient(body)) return send(res, 400, { error: 'Invalid client data.' });
          const c = cleanClient(body);
          return sql`UPDATE courierpay_clients
                    SET name = ${c.name}, phone = ${c.phone}, email = ${c.email},
                        type = ${c.type}, billing_period = ${c.billing_period},
                        prefix = ${c.prefix}, notes = ${c.notes}, updated_at = now()
                    WHERE id = ${c.id} RETURNING *`
            .then(updated => {
              if (!updated.length) return send(res, 404, { error: 'Client not found.' });
              return send(res, 200, { client: updated[0] });
            });
        }

        if (req.method === 'DELETE') {
          if (!body.id || typeof body.id !== 'string') return send(res, 400, { error: 'Client ID is required.' });
          return sql`DELETE FROM courierpay_clients WHERE id = ${body.id} RETURNING id`
            .then(deleted => {
              if (!deleted.length) return send(res, 404, { error: 'Client not found.' });
              return send(res, 204, '');
            });
        }
      });
    })
    .catch(error => {
      console.error('Clients request failed:', error.message);
      return send(res, 503, { error: 'Client storage is temporarily unavailable. Try again shortly.' });
    });
  })
  .catch(error => {
    console.error('Clients request failed:', error.message);
    return send(res, 503, { error: 'Client storage is temporarily unavailable. Try again shortly.' });
  });
};
