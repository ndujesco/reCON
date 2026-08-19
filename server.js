'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./src/store');
const { CHECKPOINTS } = require('./src/checkpoints');

const PORT = process.env.PORT || 4317;
const PUBLIC = path.join(__dirname, 'public');
const store = new Store();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const json = (res, body, status = 200) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(payload);
};

const routes = {
  'GET /api/health': (req, res) => json(res, { ok: true, service: 'ReCON', uptimeSec: Math.round(process.uptime()) }),

  'GET /api/checkpoints': (req, res) => json(res, CHECKPOINTS),

  'GET /api/stats': (req, res) => json(res, store.stats()),

  'GET /api/transactions': (req, res, url) => {
    const state = url.searchParams.get('state');
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const limit = Number(url.searchParams.get('limit') || 200);

    let list = store.all();
    if (state === 'exceptions') list = list.filter((t) => t.state === 'BROKEN' || t.state === 'DELAYED');
    else if (state && state !== 'all') list = list.filter((t) => t.state === state);
    if (q) {
      list = list.filter(
        (t) =>
          t.reference.toLowerCase().includes(q) ||
          t.beneficiary.name.toLowerCase().includes(q) ||
          t.beneficiary.bank.toLowerCase().includes(q) ||
          t.sender.name.toLowerCase().includes(q),
      );
    }
    json(res, { count: list.length, transactions: list.slice(0, limit) });
  },

  'GET /api/suspense': (req, res) => json(res, { entries: store.suspenseLedger() }),

  'POST /api/tick': (req, res) => json(res, { changed: store.tick() }),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
    return res.end();
  }

  if (routes[key]) return routes[key](req, res, url);

  // GET /api/transactions/:reference
  const detail = url.pathname.match(/^\/api\/transactions\/([A-Za-z0-9-]+)$/);
  if (req.method === 'GET' && detail) {
    const txn = store.get(detail[1]);
    return txn ? json(res, txn) : json(res, { error: 'Transaction not found', reference: detail[1] }, 404);
  }

  // Server-sent events: pushes the live reconciliation feed to the dashboard.
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(`event: stats\ndata: ${JSON.stringify(store.stats())}\n\n`);
    const unsubscribe = store.subscribe((payload) => {
      res.write(`event: update\ndata: ${JSON.stringify({ ...payload, stats: store.stats() })}\n\n`);
    });
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    return;
  }

  if (req.method !== 'GET') return json(res, { error: 'Method not allowed' }, 405);

  // Static assets
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return json(res, { error: 'Forbidden' }, 403);

  fs.readFile(file, (err, buf) => {
    if (err) return json(res, { error: 'Not found', path: url.pathname }, 404);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

// The live feed: new transfers originate and in-flight ones advance.
const ticker = setInterval(() => store.tick(), 2200);
ticker.unref?.();

server.listen(PORT, () => {
  console.log(`ReCON running on http://localhost:${PORT}`);
  console.log(`  ${store.stats().total} transactions seeded, ${store.stats().exceptions} in the exception queue`);
});
