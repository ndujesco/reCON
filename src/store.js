'use strict';

const { ORDER } = require('./checkpoints');
const { reconcile } = require('./engine');

/**
 * Event source + in-memory store.
 *
 * In production this layer is replaced by real feeds: core banking postings,
 * NIP gateway traffic and beneficiary bank callbacks. Everything above it —
 * the reconciliation engine, the API, the dashboard — stays exactly the same,
 * because the engine only ever sees normalised events.
 */

// Deterministic PRNG so every run of the demo tells the same story.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260818);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (a, b) => a + Math.floor(rand() * (b - a));

const MIN = 60_000;
const HOUR = 60 * MIN;

const BANKS = ['GTBank', 'Access Bank', 'Zenith Bank', 'UBA', 'Kuda MFB', 'First Bank', 'Opay', 'Moniepoint MFB', 'Stanbic IBTC'];
const FIRST = ['Adaeze', 'Tunde', 'Ifeoma', 'Musa', 'Chiamaka', 'Segun', 'Halima', 'Emeka', 'Bisi', 'Yusuf', 'Ngozi', 'Damilola', 'Kelechi', 'Aisha', 'Obinna', 'Folake'];
const LAST = ['Okonkwo', 'Adeyemi', 'Bello', 'Eze', 'Balogun', 'Nwosu', 'Ibrahim', 'Ogunleye', 'Chukwu', 'Sanni', 'Afolabi', 'Umeh'];
const CHANNELS = ['Mobile App', 'USSD *945#', 'Internet Banking', 'ALAT', 'POS Terminal', 'API / Corporate'];

let seq = 4416; // the hero case below lands on 004417
const nextRef = (date) => `WEM-${date}-${String(++seq).padStart(6, '0')}`;
let eventSeq = 100000;
const nextEventId = () => `EVT-${++eventSeq}`;

const name = () => `${pick(FIRST)} ${pick(LAST)}`;
const acct = () => String(between(1000000000, 9999999999));

/** Builds one transaction plus the raw events it produced. */
function makeTransaction(now, spec) {
  const initiatedAt = now - spec.ageMs;
  const bank = spec.bank || pick(BANKS);
  const txn = {
    reference: nextRef('20260818'),
    amount: spec.amount,
    sender: { name: spec.senderName || name(), account: acct(), bank: 'Wema Bank' },
    beneficiary: { name: spec.beneficiaryName || name(), account: acct(), bank },
    channel: spec.channel || pick(CHANNELS),
    initiatedAt,
    sessionId: `0900${between(10000000, 99999999)}${between(1000, 9999)}`,
    // How far the chain got, and what happened at the edge.
    reach: spec.reach,
    outcome: spec.outcome, // 'ok' | 'stalled' | 'failed' | 'reversed' | 'suspense'
  };

  const events = [];
  let t = initiatedAt;
  const reachIdx = ORDER.indexOf(spec.reach);

  for (let i = 0; i <= reachIdx; i++) {
    const id = ORDER[i];
    t += between(2_000, 45_000);
    events.push({
      id: nextEventId(),
      ref: txn.reference,
      checkpoint: id,
      source: sourceFor(id),
      ts: t,
      status: 'OK',
      amount: txn.amount,
      code: codeFor(id),
      detail: detailFor(id, txn),
    });
  }

  if (spec.outcome === 'failed') {
    const failIdx = reachIdx + 1;
    if (failIdx < ORDER.length) {
      t += between(5_000, 60_000);
      events.push({
        id: nextEventId(),
        ref: txn.reference,
        checkpoint: ORDER[failIdx],
        source: sourceFor(ORDER[failIdx]),
        ts: t,
        status: 'FAILED',
        amount: txn.amount,
        code: spec.failCode || '25 — Unable to locate record',
        detail: 'Beneficiary bank rejected the instruction.',
      });
    }
  }

  if (spec.outcome === 'reversed') {
    t += between(20 * MIN, 90 * MIN);
    events.push({
      id: nextEventId(),
      ref: txn.reference,
      type: 'REVERSAL',
      source: 'CORE_BANKING',
      ts: t,
      status: 'OK',
      amount: txn.amount,
      code: 'RVSL-AUTO',
      detail: 'Auto-reversal posted to the originating account.',
    });
  }

  if (spec.outcome === 'suspense') {
    t += between(3 * MIN, 25 * MIN);
    events.push({
      id: nextEventId(),
      ref: txn.reference,
      type: 'SUSPENSE_PARK',
      source: 'SUSPENSE_LEDGER',
      ts: t,
      status: 'OK',
      amount: txn.amount,
      account: `SUSP-${between(100, 999)}-NIP`,
      sweptAt: null,
      detail: 'Funds credited to a suspense account pending beneficiary resolution.',
    });
  }

  return { txn, events };
}

function sourceFor(id) {
  if (id === 'INITIATED' || id === 'DEBITED') return 'CORE_BANKING';
  if (id === 'SENT_TO_NIBSS' || id === 'PROCESSED_BY_NIBSS') return 'NIP_GATEWAY';
  return 'BENEFICIARY_RESPONSE';
}

function codeFor(id) {
  return {
    INITIATED: 'CBS-ACPT-00',
    DEBITED: 'CBS-DR-00',
    SENT_TO_NIBSS: 'NIP-REQ-00',
    PROCESSED_BY_NIBSS: 'NIP-RTE-00',
    RECEIVED_BY_BANK: 'NIP-ACK-00',
    CREDITED: '00 — Approved or completed successfully',
  }[id];
}

function detailFor(id, txn) {
  return {
    INITIATED: `${txn.channel} request accepted for ${txn.beneficiary.bank}.`,
    DEBITED: `Debit posted to ${txn.sender.account}.`,
    SENT_TO_NIBSS: `Instruction submitted on session ${txn.sessionId}.`,
    PROCESSED_BY_NIBSS: `Routed to ${txn.beneficiary.bank}.`,
    RECEIVED_BY_BANK: `${txn.beneficiary.bank} acknowledged receipt.`,
    CREDITED: `${txn.beneficiary.account} credited.`,
  }[id];
}

class Store {
  constructor() {
    this.transactions = new Map(); // reference -> { txn, events }
    this.listeners = new Set();
    this.seed();
  }

  seed() {
    const now = Date.now();

    // ---- The hero case the demo turns on ---------------------------------
    // ₦250,000 debited, routed, acknowledged by the beneficiary bank — and
    // then nothing. Today this customer is told "wait 24–48 hours".
    const hero = makeTransaction(now, {
      amount: 25_000_000,
      ageMs: 26 * HOUR,
      reach: 'RECEIVED_BY_BANK',
      outcome: 'suspense',
      bank: 'GTBank',
      senderName: 'Adaeze Okonkwo',
      beneficiaryName: 'Chinedu Balogun',
      channel: 'Mobile App',
    });
    this.add(hero);

    // ---- A realistic mix around it ---------------------------------------
    const mix = [
      { reach: 'CREDITED', outcome: 'ok', weight: 52 },
      { reach: 'RECEIVED_BY_BANK', outcome: 'stalled', weight: 4 },
      { reach: 'PROCESSED_BY_NIBSS', outcome: 'stalled', weight: 3 },
      { reach: 'DEBITED', outcome: 'stalled', weight: 2 },
      { reach: 'RECEIVED_BY_BANK', outcome: 'suspense', weight: 6 },
      { reach: 'PROCESSED_BY_NIBSS', outcome: 'failed', weight: 2 },
      { reach: 'SENT_TO_NIBSS', outcome: 'reversed', weight: 2 },
    ];

    for (const m of mix) {
      for (let i = 0; i < m.weight; i++) {
        const stuck = m.outcome !== 'ok';
        this.add(
          makeTransaction(now, {
            amount: between(5, 180) * 100_000, // ₦500 – ₦180,000
            ageMs: stuck ? between(35 * MIN, 30 * HOUR) : between(2 * MIN, 8 * HOUR),
            reach: m.reach,
            outcome: m.outcome,
          }),
        );
      }
    }

    // A handful of genuinely fresh, healthy transactions still in flight.
    for (let i = 0; i < 5; i++) {
      this.add(
        makeTransaction(now, {
          amount: between(5, 180) * 100_000,
          ageMs: between(10_000, 90_000),
          reach: pick(['DEBITED', 'SENT_TO_NIBSS', 'PROCESSED_BY_NIBSS']),
          outcome: 'stalled',
        }),
      );
    }
  }

  add(entry) {
    this.transactions.set(entry.txn.reference, entry);
    return entry;
  }

  get(reference) {
    const entry = this.transactions.get(reference);
    return entry ? reconcile(entry.txn, entry.events) : null;
  }

  all() {
    return [...this.transactions.values()]
      .map((e) => reconcile(e.txn, e.events))
      .sort((a, b) => b.priority - a.priority || b.lastEventAt - a.lastEventAt);
  }

  stats() {
    const all = this.all();
    const by = (s) => all.filter((t) => t.state === s).length;
    const exceptions = all.filter((t) => t.state === 'BROKEN' || t.state === 'DELAYED');
    const atRisk = exceptions.reduce((sum, t) => sum + t.amount, 0);
    const suspense = all.filter((t) => t.suspense);
    return {
      total: all.length,
      reconciled: by('RECONCILED'),
      inFlight: by('IN_FLIGHT'),
      delayed: by('DELAYED'),
      broken: by('BROKEN'),
      reversed: by('REVERSED'),
      exceptions: exceptions.length,
      valueAtRisk: atRisk,
      suspenseCount: suspense.length,
      suspenseValue: suspense.reduce((s, t) => s + t.suspense.amount, 0),
      reconciledPct: all.length ? Math.round((by('RECONCILED') / all.length) * 100) : 0,
      // Every transaction is located by replaying its events — measured, not claimed.
      avgLocateMs: this.measureLocateTime(),
    };
  }

  /** Times a full reconciliation sweep: this is ReCON's "time to locate". */
  measureLocateTime() {
    const entries = [...this.transactions.values()];
    if (!entries.length) return 0;
    const start = process.hrtime.bigint();
    for (const e of entries) reconcile(e.txn, e.events);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    return elapsedMs / entries.length;
  }

  suspenseLedger() {
    return this.all()
      .filter((t) => t.suspense)
      .map((t) => ({
        reference: t.reference,
        account: t.suspense.account,
        amount: t.suspense.amount,
        amountFormatted: t.amountFormatted,
        beneficiary: t.beneficiary,
        since: t.suspense.since,
        ageMs: t.suspense.ageMs,
        state: t.state,
      }))
      .sort((a, b) => b.ageMs - a.ageMs);
  }

  /**
   * One tick of the live feed: advance in-flight transactions by ingesting the
   * next event, and occasionally originate a brand new transfer.
   */
  tick() {
    const now = Date.now();
    const changed = [];

    for (const entry of this.transactions.values()) {
      const { txn, events } = entry;
      if (txn.outcome !== 'stalled' && txn.outcome !== 'ok') continue;
      const last = events[events.length - 1];
      if (!last.checkpoint) continue;
      const idx = ORDER.indexOf(last.checkpoint);
      if (idx === ORDER.length - 1) continue;
      // Young transactions keep moving; old ones are genuinely stuck.
      const age = now - txn.initiatedAt;
      if (age > 20 * MIN) continue;
      if (rand() > 0.35) continue;

      const nextId = ORDER[idx + 1];
      events.push({
        id: nextEventId(),
        ref: txn.reference,
        checkpoint: nextId,
        source: sourceFor(nextId),
        ts: now,
        status: 'OK',
        amount: txn.amount,
        code: codeFor(nextId),
        detail: detailFor(nextId, txn),
      });
      changed.push(txn.reference);
    }

    if (rand() < 0.55) {
      const entry = makeTransaction(now, {
        amount: between(5, 180) * 100_000,
        ageMs: between(1_000, 8_000),
        reach: 'INITIATED',
        outcome: 'stalled',
      });
      this.add(entry);
      changed.push(entry.txn.reference);
    }

    if (changed.length) this.emit({ type: 'tick', changed });
    return changed;
  }

  emit(payload) {
    for (const fn of this.listeners) fn(payload);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

module.exports = { Store };
