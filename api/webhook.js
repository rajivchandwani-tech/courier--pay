'use strict';

/**
 * FYERS webhook listener (order status updates)
 * ============================================
 * Receives the raw JSON POST Fyers sends on every order status change
 * (Pending / Rejected / Cancelled / Traded) and forwards a plain-text summary
 * to Rajiv's Rashari Telegram bot.
 *
 * Fyers requirements that this file must respect:
 *   - reply HTTP 200 to EVERY post, or the URL gets blacklisted for 30 minutes
 *     (and after repeated failures, permanently)
 *   - read the RAW request body, not a parsed one
 *   - `secret` is configured on the app but Fyers does not sign the payload with
 *     HMAC, so the secret cannot be verified here. The route is instead gated
 *     by a random path segment (set as WEBHOOK_PATH) plus a check that the
 *     payload looks like a Fyers order object.
 *
 * Env vars:
 *   RASHARI_BOT_TOKEN   Telegram bot token (required)
 *   RASHARI_CHAT_ID     Telegram chat id (required)
 *   WEBHOOK_PATH        secret path segment, e.g. "f7k2m9x4" (required)
 *   WEBHOOK_LOG_PATH    optional file to append raw payloads to (for debugging)
 */

function send(res, status, payload) {
  res.statusCode = status;
  if (status === 204 || payload === '') { res.end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

// Fyers status codes -> human text
const STATUS = {
  1: 'CANCELLED',
  2: 'TRADED / FILLED',
  3: '(unused)',
  4: 'TRANSIT',
  5: 'REJECTED',
  6: 'PENDING',
  7: 'EXPIRED',
};

const SIDE = { 1: 'BUY', '-1': 'SELL', '-1': 'SELL' };

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > 4 * 1024 * 1024) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function telegram(text) {
  const token = process.env.RASHARI_BOT_TOKEN;
  const chat = process.env.RASHARI_CHAT_ID;
  if (!token || !chat) return { ok: false, why: 'missing RASHARI_BOT_TOKEN/RASHARI_CHAT_ID' };
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body: body.slice(0, 300) };
}

function summarise(o) {
  const st = STATUS[o.status] || `status ${o.status}`;
  const side = SIDE[o.side] || `side ${o.side}`;
  const filled = o.filledQty ?? 0;
  const qty = o.qty ?? 0;
  const rem = o.remainingQuantity ?? (qty - filled);
  const price = o.tradedPrice ?? o.limitPrice ?? 0;
  const lines = [
    `🔔 FYERS ORDER UPDATE`,
    ``,
    `Symbol : ${o.symbol || '—'}`,
    `Status : ${st}`,
    `Side   : ${side}`,
    `Qty    : ${filled}/${qty} filled${rem ? ` (${rem} left)` : ''}`,
    `Price  : ${price}`,
  ];
  if (o.message) lines.push(`Msg    : ${o.message}`);
  if (o.id) lines.push(`Order  : ${o.id}`);
  return lines.join('\n');
}

module.exports = async function handler(req, res) {
  // CORS preflight first — a 405 here would look like a server fault.
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return send(res, 204, '');
  }

  const expected = process.env.WEBHOOK_PATH;
  if (expected) {
    const path = (req.url || '').split('?')[0];
    if (path.indexOf('/' + expected) === -1) {
      return send(res, 404, { error: 'not found' });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return send(res, 405, { error: 'Method not allowed.' });
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (e) {
    // Still answer 200 so Fyers does not blacklist us; a body-read failure is
    // our problem, not Fyers'.
    return send(res, 200, { received: true, parsed: false });
  }

  let payload = null;
  try { payload = JSON.parse(raw || '{}'); } catch { /* leave null */ }

  // Reject anything that is not a Fyers order object — keeps random probes out
  // of the log and stops a mistyped URL from spamming Telegram.
  const looksLikeFyers = payload && (
    typeof payload.id === 'string' ||
    typeof payload.fyToken === 'string' ||
    (typeof payload.symbol === 'string' && typeof payload.status === 'number')
  );
  if (!looksLikeFyers) {
    return send(res, 200, { received: true, ignored: 'not a fyers payload' });
  }

  if (process.env.WEBHOOK_LOG_PATH) {
    try {
      const fs = require('node:fs');
      fs.appendFileSync(
        process.env.WEBHOOK_LOG_PATH,
        `${new Date().toISOString()} ${JSON.stringify(payload)}\n`
      );
    } catch { /* logging must never break the 200 */ }
  }

  const text = summarise(payload);
  const t = await telegram(text);

  return send(res, 200, { ok: true, telegram: t.ok, telegramStatus: t.status });
};
