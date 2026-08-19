'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconcile } = require('../src/engine');
const { ORDER } = require('../src/checkpoints');

const NOW = Date.parse('2026-08-18T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

const txn = (over = {}) => ({
  reference: 'WEM-TEST-000001',
  amount: 25_000_000,
  sender: { name: 'Adaeze Okonkwo', account: '0123456789', bank: 'Wema Bank' },
  beneficiary: { name: 'Chinedu Balogun', account: '9876543210', bank: 'GTBank' },
  channel: 'Mobile App',
  initiatedAt: NOW - 2 * HOUR,
  ...over,
});

/** Events for the first `n` checkpoints, one minute apart. */
const chainTo = (n, amount = 25_000_000, start = NOW - 2 * HOUR) =>
  ORDER.slice(0, n).map((id, i) => ({
    id: `EVT-${i}`,
    checkpoint: id,
    source: i < 2 ? 'CORE_BANKING' : i < 4 ? 'NIP_GATEWAY' : 'BENEFICIARY_RESPONSE',
    ts: start + i * MIN,
    status: 'OK',
    amount,
  }));

test('a complete chain reconciles', () => {
  const r = reconcile(txn(), chainTo(6), NOW);
  assert.equal(r.state, 'RECONCILED');
  assert.equal(r.breakpoint, null);
  assert.equal(r.severity, 'NONE');
  assert.equal(r.priority, 0);
  assert.equal(r.stalledForMs, 0);
});

test('the break point is the first checkpoint that never fired', () => {
  const r = reconcile(txn(), chainTo(5), NOW);
  assert.equal(r.breakpoint.id, 'CREDITED');
  assert.equal(r.breakpoint.owner, 'BENEFICIARY_BANK');
  assert.match(r.diagnosis.headline, /not credited/i);
});

test('a fresh transfer inside its SLA is in flight, not an exception', () => {
  const r = reconcile(txn({ initiatedAt: NOW - 60_000 }), chainTo(3, 25_000_000, NOW - 60_000), NOW);
  assert.equal(r.state, 'IN_FLIGHT');
  assert.equal(r.breachedSla, false);
});

test('a debit stuck past its SLA is escalated, and becomes critical after six hours', () => {
  const recent = reconcile(txn(), chainTo(2, 25_000_000, NOW - 30 * MIN), NOW);
  assert.equal(recent.state, 'DELAYED');
  assert.equal(recent.anomalies.find((a) => a.code === 'DEBIT_NOT_REVERSED').severity, 'HIGH');

  const old = reconcile(txn(), chainTo(2, 25_000_000, NOW - 26 * HOUR), NOW);
  assert.equal(old.state, 'BROKEN');
  assert.equal(old.severity, 'CRITICAL');
});

test('funds left in a suspense account are flagged and surfaced', () => {
  const events = [
    ...chainTo(5, 25_000_000, NOW - 26 * HOUR),
    {
      id: 'EVT-S',
      type: 'SUSPENSE_PARK',
      source: 'SUSPENSE_LEDGER',
      ts: NOW - 25 * HOUR,
      status: 'OK',
      amount: 25_000_000,
      account: 'SUSP-230-NIP',
      sweptAt: null,
    },
  ];
  const r = reconcile(txn(), events, NOW);
  assert.equal(r.suspense.account, 'SUSP-230-NIP');
  assert.ok(r.anomalies.some((a) => a.code === 'FUNDS_IN_SUSPENSE'));
  assert.match(r.diagnosis.cause, /suspense account/i);
  assert.match(r.diagnosis.action, /sweep/i);
});

test('an amount that changes between hops is a critical mismatch', () => {
  const events = chainTo(4);
  events[3].amount = 24_000_000; // NIBSS reports a different value
  const r = reconcile(txn(), events, NOW);
  assert.equal(r.state, 'BROKEN');
  assert.ok(r.anomalies.some((a) => a.code === 'AMOUNT_MISMATCH'));
});

test('a downstream rejection is attributed, not left as pending', () => {
  const events = [
    ...chainTo(4),
    {
      id: 'EVT-F',
      checkpoint: 'RECEIVED_BY_BANK',
      source: 'BENEFICIARY_RESPONSE',
      ts: NOW - 90 * MIN,
      status: 'FAILED',
      amount: 25_000_000,
      code: '25: Unable to locate record',
    },
  ];
  const r = reconcile(txn(), events, NOW);
  assert.equal(r.state, 'BROKEN');
  assert.equal(r.breakpoint.id, 'RECEIVED_BY_BANK');
  assert.ok(r.anomalies.some((a) => a.code === 'DOWNSTREAM_REJECT'));
});

test('a reversal closes the case and tells the customer their money is back', () => {
  const events = [
    ...chainTo(3),
    { id: 'EVT-R', type: 'REVERSAL', source: 'CORE_BANKING', ts: NOW - 30 * MIN, status: 'OK', amount: 25_000_000 },
  ];
  const r = reconcile(txn(), events, NOW);
  assert.equal(r.state, 'REVERSED');
  assert.match(r.diagnosis.customerMessage, /returned to your account/i);
});

test('the exception queue ranks bigger, older, worse breaks first', () => {
  const big = reconcile(txn({ amount: 25_000_000 }), chainTo(5, 25_000_000, NOW - 26 * HOUR), NOW);
  const small = reconcile(txn({ amount: 1_000_000 }), chainTo(5, 1_000_000, NOW - 26 * HOUR), NOW);
  const recent = reconcile(txn({ amount: 25_000_000 }), chainTo(5, 25_000_000, NOW - 2 * HOUR), NOW);
  assert.ok(big.priority > small.priority);
  assert.ok(big.priority > recent.priority);
});

test('every confirmed hop carries the evidence that proves it', () => {
  const r = reconcile(txn(), chainTo(5), NOW);
  const confirmed = r.chain.filter((c) => c.state === 'CONFIRMED');
  assert.equal(confirmed.length, 5);
  for (const hop of confirmed) {
    assert.ok(hop.evidence.eventId, 'hop must name the source event');
    assert.ok(hop.evidence.source, 'hop must name the source system');
  }
});
