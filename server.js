'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./src/store');
const { CHECKPOINTS } = require('./src/checkpoints');
const { CATEGORIES } = require('./src/classify');

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

  'GET /api/categories': (req, res) => json(res, CATEGORIES),

  // Where the data comes from, how much of it arrives matchable, and what is
  // in scope. Both feeds are pulled: there is nothing here to log into.
  'GET /api/sources': (req, res) => json(res, store.sources()),

  // The whole-book view: duplicates, one-sided records, amount disagreements
  // and general ledger breaks, ranked worst first.
  'GET /api/validation': (req, res) => {
    const { findings, summary } = store.validation();
    json(res, { summary, findings });
  },

  // Core banking postings matched line by line against the NIP settlement report.
  'GET /api/settlement': (req, res) => {
    const { match } = store.validation();
    json(res, {
      totals: match.totals,
      probable: match.probable.map((p) => ({
        recordId: p.record.recordId,
        narration: p.record.narration,
        amount: p.record.amount,
        valueDate: p.record.valueDate,
        settlementId: p.line.settlementId,
        confidence: p.confidence,
        basis: p.basis,
        proposes: p.proposes,
      })),
      mismatched: match.mismatched.map((m) => ({
        reference: m.record.reference,
        coreAmount: m.record.amount,
        nipAmount: m.line.amount,
        delta: m.delta,
      })),
      unmatchedInNip: match.unmatchedInNip.map((r) => ({
        recordId: r.recordId,
        reference: r.reference,
        narration: r.narration,
        amount: r.amount,
      })),
      unmatchedInCore: match.unmatchedInCore.map((l) => ({
        settlementId: l.settlementId,
        reference: l.reference,
        sessionId: l.sessionId,
        amount: l.amount,
        beneficiaryBank: l.beneficiaryBank,
      })),
    });
  },

  // General ledger continuity: does each closing balance carry forward?
  'GET /api/balances': (req, res) => json(res, { accounts: store.ledger().balances }),

  // The record explorer. Accepts free text plus `field:value` terms, so the
  // desk can ask a real question without anyone writing SQL for them.
  'GET /api/records': (req, res, url) => {
    const structuredParam = url.searchParams.get('structured');
    json(
      res,
      store.records({
        q: url.searchParams.get('q') || '',
        category: url.searchParams.get('category'),
        structured: structuredParam == null ? null : structuredParam === 'true',
        limit: Number(url.searchParams.get('limit') || 120),
      }),
    );
  },

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
