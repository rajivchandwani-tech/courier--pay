'use strict';

const MAX_BODY = 32 * 1024;

function send(res, status, payload) {
  res.statusCode = status;
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

function validRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (typeof record.id !== 'string' || record.id.length < 8 || record.id.length > 100) return false;
  if (!['purchase', 'salary', 'utilities'].includes(record.kind)) return false;
  if (typeof record.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) return false;
  // Optional date fields must be valid ISO dates too — a stray extra digit (e.g.
  // "20226-10-11") used to pass validation and surface as a broken date in reports.
  for (const dateKey of ['dueDate', 'paidDate']) {
    if (record[dateKey] !== undefined && record[dateKey] !== null && record[dateKey] !== ''
      && (typeof record[dateKey] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record[dateKey]))) return false;
  }
  const taxable = Number(record.taxable);
  const gst = Number(record.gst);
  const paid = Number(record.paid);
  if (![taxable, gst, paid].every(Number.isFinite) || taxable < 0 || gst < 0 || paid < 0 || paid > taxable + gst) return false;
  if (!['none', 'cgst_sgst', 'igst'].includes(record.gstMode) || typeof record.itcEligible !== 'boolean' || typeof record.voided !== 'boolean') return false;
  if (gst > 0 && record.gstMode === 'none') return false;
  if (record.kind === 'purchase' && (!['Blue Dart', 'Delhivery', 'Shree Maruti Couriers', 'Ekart'].includes(record.vendor) || typeof record.reference !== 'string' || !record.reference.trim())) return false;
  if ((record.kind === 'salary' || record.kind === 'utilities') && (typeof record.payee !== 'string' || !record.payee.trim())) return false;
  if (record.whatsappPhone !== undefined && (typeof record.whatsappPhone !== 'string' || record.whatsappPhone.length > 24)) return false;
  const allowed = ['id','kind','vendor','payee','whatsappPhone','reference','date','dueDate','taxable','gst','gstMode','itcEligible','paid','paidDate','notes','voided','createdAt','updatedAt'];
  return Object.keys(record).every(key => allowed.includes(key));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'Method not allowed.' });
  }
  const origin = req.headers && req.headers.origin;
  const allowedHosts = [req.headers && req.headers.host, req.headers && req.headers['x-forwarded-host'], process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean);
  if (origin && allowedHosts.length) {
    try {
      if (allowedHosts.indexOf(new URL(origin).host) < 0) return send(res, 403, { error: 'Cross-site request blocked.' });
    } catch { return send(res, 403, { error: 'Invalid request origin.' }); }
  }
  if (!process.env.DATABASE_URL) return send(res, 503, { error: 'Shared ledger database is not connected yet.' });

  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS courierpay_finance_entries (
      id text PRIMARY KEY,
      record jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS courierpay_activity_events (
      id bigserial PRIMARY KEY,
      event jsonb NOT NULL,
      client_id text NOT NULL DEFAULT 'unknown',
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS courierpay_purchase_bill_unique
      ON courierpay_finance_entries (lower(record->>'vendor'), lower(record->>'reference'))
      WHERE record->>'kind' = 'purchase' AND record->>'voided' IS DISTINCT FROM 'true'`;

    if (req.method === 'GET') {
      const rows = await sql`SELECT record FROM courierpay_finance_entries ORDER BY created_at ASC`;
      return send(res, 200, { records: rows.map(row => row.record) });
    }

    let body;
    try { body = await readBody(req); }
    catch (error) { return send(res, error.status || 400, { error: error.message || 'Could not read request.' }); }
    const record = body.record;
    if (!validRecord(record)) return send(res, 400, { error: 'The purchase or expense entry is invalid.' });
    if (JSON.stringify(record).length > 24000) return send(res, 413, { error: 'The entry is too large.' });
    const data = JSON.stringify(record);
    const clientId = typeof body.clientId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(body.clientId) ? body.clientId : 'unknown';
    // Deletion is the one operation that must NOT be an upsert — a stale sync
    // payload replayed against the DB used to resurrect a deleted entry.
    if (body.operation === 'delete') {
      try {
        const deleted = await sql`DELETE FROM courierpay_finance_entries WHERE id = ${record.id} RETURNING id`;
        console.log('ledger delete rows removed:', deleted.length, 'id:', record.id);
        if (deleted.length) {
          const ref = record.payee || record.vendor || '';
          try {
            await sql`INSERT INTO courierpay_activity_events (event, client_id)
              VALUES (jsonb_build_object('type','finance_entry_deleted','category','finance','recordId',${record.id}::text,
                       'reference',${ref},'party',${ref},
                       'amount',0,'transactionDate',${record.date},'summary','Finance entry deleted'), ${clientId})`;
            console.log('ledger delete event logged for', record.id);
          } catch (eventError) {
            // The entry is already deleted; a failed audit write must not turn the
            // whole operation into a 503 and make the UI think nothing happened.
            console.error('ledger delete audit write failed:', eventError && eventError.message);
          }
        }
        return send(res, 200, { saved: true, id: record.id, deleted: true });
      } catch (error) {
        console.error('Shared ledger delete failed:', error && error.message);
        return send(res, 503, { error: 'Shared ledger is temporarily unavailable. Try again later.' });
      }
    }
    try {
      await sql`WITH previous AS MATERIALIZED (
          SELECT record FROM courierpay_finance_entries WHERE id = ${record.id}
        ), saved AS (
          INSERT INTO courierpay_finance_entries (id, record) VALUES (${record.id}, ${data}::jsonb)
          ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record, updated_at = now()
          RETURNING id, record
        ), audit_rows AS (
          SELECT saved.id, saved.record AS current_record, previous.record AS previous_record
          FROM saved LEFT JOIN previous ON true
        ), events AS (
          SELECT 'finance_entry_created'::text AS type, current_record AS record, previous_record FROM audit_rows WHERE previous_record IS NULL
          UNION ALL
          SELECT 'finance_payment_recorded', current_record, previous_record FROM audit_rows
            WHERE COALESCE((current_record->>'paid')::numeric, 0) > COALESCE((previous_record->>'paid')::numeric, 0)
          UNION ALL
          SELECT 'finance_entry_voided', current_record, previous_record FROM audit_rows
            WHERE previous_record IS NOT NULL AND COALESCE(current_record->>'voided','false') <> 'true' AND current_record->>'voided' = 'true'
          UNION ALL
          SELECT 'finance_entry_updated', current_record, previous_record FROM audit_rows
            WHERE previous_record IS NOT NULL AND current_record IS DISTINCT FROM previous_record
              AND COALESCE((current_record->>'paid')::numeric, 0) <= COALESCE((previous_record->>'paid')::numeric, 0)
              AND COALESCE(current_record->>'voided','false') = COALESCE(previous_record->>'voided','false')
        ), logged AS (
          INSERT INTO courierpay_activity_events (event, client_id)
          SELECT jsonb_build_object(
            'type', events.type,
            'category', CASE WHEN events.type = 'finance_payment_recorded' THEN 'payment' ELSE 'finance' END,
            'recordId', events.record->>'id',
            'reference', COALESCE(events.record->>'reference', events.record->>'vendor', ''),
            'party', COALESCE(NULLIF(events.record->>'payee',''), NULLIF(events.record->>'vendor',''), ''),
            'amount', CASE WHEN events.type = 'finance_payment_recorded'
              THEN COALESCE((events.record->>'paid')::numeric,0) - COALESCE((events.previous_record->>'paid')::numeric,0)
              ELSE COALESCE((events.record->>'taxable')::numeric,0) + COALESCE((events.record->>'gst')::numeric,0) END,
            'transactionDate', CASE WHEN events.type = 'finance_payment_recorded' THEN events.record->>'paidDate' ELSE events.record->>'date' END,
            'summary', CASE events.type
              WHEN 'finance_entry_created' THEN initcap(events.record->>'kind') || ' entry recorded'
              WHEN 'finance_payment_recorded' THEN initcap(events.record->>'kind') || ' payment amount updated'
              WHEN 'finance_entry_voided' THEN initcap(events.record->>'kind') || ' entry voided'
              ELSE initcap(events.record->>'kind') || ' entry updated' END
          ), ${clientId} FROM events
          RETURNING id
        ) SELECT id FROM saved`;
    } catch (error) {
      if (error && error.code === '23505') return send(res, 409, { error: 'This provider bill number is already recorded.' });
      throw error;
    }
    return send(res, 200, { saved: true, id: record.id });
  } catch (error) {
    console.error('Shared ledger request failed:', error.message);
    return send(res, 503, { error: 'Shared ledger is temporarily unavailable. Try again later.' });
  }
};
