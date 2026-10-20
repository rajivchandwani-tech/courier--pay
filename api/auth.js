'use strict';

/**
 * App Password Gate — POST /api/auth
 *
 * Verifies the shared password (APP_PASSWORD env var) and returns a signed
 * session token. The token must be sent as the X-App-Token header on all
 * other API calls.
 *
 * Password lives in a Vercel env var, never in code.
 * Authorised users: Rajiv, Riddhima, Shalu, Rasha.
 *
 * Tokens are HMAC-signed with SESSION_SECRET so they survive restarts and
 * redeploys. A random-per-boot secret would invalidate every logged-in
 * session on each deploy.
 */
const crypto = require('node:crypto');

// A token must be verifiable no matter which build instance serves it, so the
// secret MUST come from the environment. A hardcoded fallback silently produces
// tokens that other instances reject with a bare 401 (which reads to the user as
// "the activity log is broken" while the data is sitting in the database).
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;   // 30 days

function send(res, status, payload) {
  res.statusCode = status;
  if (status === 204 || payload === '') { res.end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) {
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

// token = base64url(payloadJson) + '.' + base64url(hmacSha256(payload))
function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function sign(payload) {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
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
function bearerToken(req) {
  const raw = req.headers['x-app-token'] || req.headers.authorization || '';
  return typeof raw === 'string' ? raw.replace(/^Bearer\s+/i, '').trim() : '';
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
    return send(res, 204, '');
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return send(res, 405, { error: 'Method not allowed.' });
  }

  let body;
  try { body = await readJson(req); }
  catch (error) { return send(res, error.status || 400, { error: error.message || 'Could not read request.' }); }

  const password = body.password || '';
  if (!APP_PASSWORD) return send(res, 503, { error: 'App password is not configured.' });
  if (!SESSION_SECRET) return send(res, 503, { error: 'Session secret is not configured.' });
  if (password !== APP_PASSWORD) return send(res, 401, { error: 'Invalid password.' });

  return send(res, 200, { token: sign({ kind: 'password', exp: Date.now() + TOKEN_TTL_MS }) });
};

// Shared helpers for the other api/*.js handlers.
module.exports.sign = sign;
module.exports.verify = verify;
module.exports.bearerToken = bearerToken;
module.exports.isAuthenticated = (req) => !!verify(bearerToken(req));
