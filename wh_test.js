// Test the webhook handler with a Fyers-shaped payload, using a stubbed fetch.
const handler = require('./api/webhook.js');

const sample = {
  orderDateTime: '18-Jul-2023 11:44:29',
  id: '23071800238607',
  exchOrdId: '2500000061319029',
  side: -1,
  segment: 20,
  instrument: 15,
  productType: 'INTRADAY',
  status: 2,
  qty: 10,
  remainingQuantity: 0,
  filledQty: 10,
  limitPrice: 9584,
  stopPrice: 0,
  type: 2,
  orderValidity: 'DAY',
  tradedPrice: 9584,
  symbol: 'MCX:CRUDEOILM26OCTFUT',
  message: 'Completed',
  fyToken: '1120260718225167'
};

function mkRes() {
  const r = { statusCode: 200, headers: {}, body: null };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { r.body = b; };
  return r;
}

function mkReq(url, body) {
  // Raw-body path: no req.body, so the handler must stream it from 'data'.
  const req = {
    method: 'POST',
    url,
    headers: {},
    on(evt, cb) {
      if (evt === 'data') cb(Buffer.from(JSON.stringify(body == null ? null : body)));
      if (evt === 'end') cb();
      return req;
    },
    setEncoding() {},
    destroy() {},
  };
  return req;
}

(async () => {
  const sent = [];
  global.fetch = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
  };

  process.env.WEBHOOK_PATH = 'testsecret';

  let res = mkRes();
  await handler(mkReq('/api/webhook', sample), res);
  console.log('wrong path  ->', res.statusCode, res.body);

  res = mkRes();
  await handler(mkReq('/api/webhook/testsecret', sample), res);
  console.log('right path  ->', res.statusCode, res.body);
  console.log('telegram    ->', sent.length, 'call(s)');
  if (sent.length) console.log(sent[0].body.text);

  sent.length = 0;
  res = mkRes();
  await handler(mkReq('/api/webhook/testsecret', { hello: 'world' }), res);
  console.log('garbage     ->', res.statusCode, res.body, '| telegram calls:', sent.length);

  sent.length = 0;
  res = mkRes();
  await handler(mkReq('/api/webhook/testsecret', null), res);
  console.log('null body   ->', res.statusCode, res.body, '| telegram calls:', sent.length);
})();
