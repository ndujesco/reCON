'use strict';

const { CHECKPOINTS, ORDER, byId, SOURCES, OWNERS } = require('./checkpoints');

const NGN = (kobo) =>
  '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Reconciliation engine.
 *
 * Input:  the raw, normalised event stream for ONE transaction reference —
 *         events pulled from core banking, the NIP gateway, beneficiary bank
 *         responses and the suspense ledger.
 * Output: an evidence-backed view of where the money actually is, what broke,
 *         who owns the break, and what to say to the customer.
 *
 * The engine never trusts a stored "status" field. It derives state purely from
 * the events, which is the point: a transaction stuck in someone else's system
 * has no status to read, only a missing event.
 */

const SEVERITY_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0 };

function reconcile(txn, events, now = Date.now()) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const seen = new Map();
  for (const ev of sorted) {
    // Last event per checkpoint wins: a retry or a late callback supersedes.
    if (ev.checkpoint) seen.set(ev.checkpoint, ev);
  }

  const suspense = sorted.find((e) => e.source === 'SUSPENSE_LEDGER' && !e.sweptAt);
  const reversal = sorted.find((e) => e.type === 'REVERSAL');

  // ---- 1. Build the checkpoint chain -------------------------------------
  const chain = CHECKPOINTS.map((cp) => {
    const ev = seen.get(cp.id);
    return {
      id: cp.id,
      label: cp.label,
      owner: cp.owner,
      ownerLabel: OWNERS[cp.owner],
      sourceSystem: SOURCES[cp.source],
      customer: cp.customer,
      customerPending: cp.customerPending,
      state: !ev ? 'PENDING' : ev.status === 'FAILED' ? 'FAILED' : 'CONFIRMED',
      at: ev ? ev.ts : null,
      evidence: ev
        ? {
            eventId: ev.id,
            source: SOURCES[ev.source],
            code: ev.code || null,
            amount: ev.amount != null ? ev.amount : null,
            detail: ev.detail || null,
          }
        : null,
    };
  });

  const lastConfirmedIdx = chain.reduce((acc, c, i) => (c.state === 'CONFIRMED' ? i : acc), -1);
  const failedIdx = chain.findIndex((c) => c.state === 'FAILED');
  const complete = chain[ORDER.indexOf('CREDITED')].state === 'CONFIRMED';

  // The break point is the first checkpoint that should have fired and hasn't.
  const breakIdx = failedIdx !== -1 ? failedIdx : complete ? -1 : lastConfirmedIdx + 1;
  const breakpoint = breakIdx >= 0 && breakIdx < chain.length ? chain[breakIdx] : null;

  // ---- 2. Age the chain against the SLA of the stalled hop ---------------
  const lastEventAt = sorted.length ? sorted[sorted.length - 1].ts : txn.initiatedAt;
  const stalledForMs = now - lastEventAt;
  const slaMs = breakpoint ? byId[breakpoint.id].slaMinutes * 60_000 : 0;
  const breachedSla = Boolean(breakpoint) && stalledForMs > slaMs;

  // ---- 3. Integrity checks across hops -----------------------------------
  const anomalies = [];
  const amounts = chain.filter((c) => c.evidence && c.evidence.amount != null).map((c) => c.evidence.amount);
  const mismatch = amounts.find((a) => a !== txn.amount);
  if (mismatch != null) {
    anomalies.push({
      code: 'AMOUNT_MISMATCH',
      severity: 'CRITICAL',
      detail: `A downstream system reported ${NGN(mismatch)} against an instructed ${NGN(txn.amount)}.`,
    });
  }
  if (suspense) {
    anomalies.push({
      code: 'FUNDS_IN_SUSPENSE',
      severity: 'HIGH',
      detail: `${NGN(suspense.amount)} has been parked in suspense account ${suspense.account} since ${new Date(
        suspense.ts,
      ).toISOString()} and has not been swept.`,
    });
  }
  const debited = chain[ORDER.indexOf('DEBITED')].state === 'CONFIRMED';
  if (debited && !complete && !reversal && breachedSla) {
    // A debit with no credit is only critical once it is old enough that the
    // rail can no longer be expected to settle it on its own.
    const critical = stalledForMs > 6 * 3_600_000;
    anomalies.push({
      code: 'DEBIT_NOT_REVERSED',
      severity: critical ? 'CRITICAL' : 'HIGH',
      detail: critical
        ? 'The customer has been out of funds for over six hours with no matching credit and no reversal booked.'
        : 'The customer is out of funds with no matching credit yet, past the expected settlement window.',
    });
  }
  if (failedIdx !== -1) {
    anomalies.push({
      code: 'DOWNSTREAM_REJECT',
      severity: 'HIGH',
      detail: `${chain[failedIdx].sourceSystem} returned ${chain[failedIdx].evidence.code}.`,
    });
  }

  // ---- 4. Resolve the transaction state ----------------------------------
  let state;
  if (complete) state = 'RECONCILED';
  else if (reversal) state = 'REVERSED';
  else if (failedIdx !== -1 || anomalies.some((a) => a.severity === 'CRITICAL')) state = 'BROKEN';
  else if (breachedSla) state = 'DELAYED';
  else state = 'IN_FLIGHT';

  const severity =
    state === 'RECONCILED' || state === 'REVERSED'
      ? 'NONE'
      : anomalies.reduce((worst, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[worst] ? a.severity : worst), breachedSla ? 'MEDIUM' : 'LOW');

  const diagnosis = diagnose({ state, breakpoint, anomalies, suspense, reversal, txn });

  // Exception priority: money at risk, weighted by how long it has been stuck
  // and how bad the break is. This is what orders the support queue.
  const priority =
    state === 'RECONCILED' || state === 'REVERSED'
      ? 0
      : Math.round(
          (txn.amount / 100_000) * SEVERITY_RANK[severity] * (1 + stalledForMs / 3_600_000),
        );

  return {
    reference: txn.reference,
    state,
    severity,
    priority,
    amount: txn.amount,
    amountFormatted: NGN(txn.amount),
    sender: txn.sender,
    beneficiary: txn.beneficiary,
    channel: txn.channel,
    initiatedAt: txn.initiatedAt,
    lastEventAt,
    stalledForMs: state === 'RECONCILED' || state === 'REVERSED' ? 0 : stalledForMs,
    breachedSla,
    slaMinutes: breakpoint ? byId[breakpoint.id].slaMinutes : null,
    confirmedCount: chain.filter((c) => c.state === 'CONFIRMED').length,
    chain,
    breakpoint: breakpoint ? { id: breakpoint.id, label: breakpoint.label, owner: breakpoint.owner, ownerLabel: breakpoint.ownerLabel } : null,
    anomalies,
    diagnosis,
    suspense: suspense
      ? { account: suspense.account, amount: suspense.amount, since: suspense.ts, ageMs: now - suspense.ts }
      : null,
    events: sorted.map((e) => ({
      id: e.id,
      ts: e.ts,
      source: SOURCES[e.source],
      checkpoint: e.checkpoint ? byId[e.checkpoint].label : e.type || 'Ledger entry',
      status: e.status || 'OK',
      code: e.code || null,
      amount: e.amount != null ? NGN(e.amount) : null,
      detail: e.detail || null,
    })),
  };
}

/**
 * Turns the break point into the three things a human actually needs:
 * what happened, who has to move, and what the customer should be told.
 */
function diagnose({ state, breakpoint, anomalies, suspense, reversal, txn }) {
  if (state === 'RECONCILED') {
    return {
      headline: 'Fully reconciled',
      cause: 'Every debit has a matching credit. All six checkpoints are confirmed by source events.',
      ownedBy: 'WEMA',
      action: 'No action required.',
      customerMessage: `Your transfer of ${NGN(txn.amount)} to ${txn.beneficiary.name} at ${txn.beneficiary.bank} was completed successfully.`,
    };
  }

  if (state === 'REVERSED') {
    return {
      headline: 'Failed and reversed',
      cause: `The transfer could not be completed downstream and ${NGN(txn.amount)} was returned to the customer's account.`,
      ownedBy: 'WEMA',
      action: 'Confirm the reversal value date, then close the case.',
      customerMessage: `Your transfer to ${txn.beneficiary.name} did not go through, and ${NGN(txn.amount)} has been returned to your account.`,
    };
  }

  const inSuspense = Boolean(suspense);
  const id = breakpoint ? breakpoint.id : 'CREDITED';

  const playbook = {
    DEBITED: {
      headline: 'Debit not confirmed by core banking',
      cause: 'The transfer was accepted but core banking has not posted the debit.',
      action: 'Check the posting queue on core banking; re-drive the posting if the hold is still open.',
      customer: 'We have received your transfer request. Your account has not been debited yet.',
    },
    SENT_TO_NIBSS: {
      headline: 'Debited, but never left Wema',
      cause: 'The customer was debited but the instruction was never handed to the NIBSS NIP gateway. The money is still inside Wema.',
      action: 'Re-drive the NIP submission from the gateway queue, or reverse the debit if the window has closed.',
      customer: 'Your account was debited, but the transfer has not yet left the bank. We are resolving this now.',
    },
    PROCESSED_BY_NIBSS: {
      headline: 'Sitting at the NIBSS rail',
      cause: 'NIBSS acknowledged receipt but has not routed the instruction to the beneficiary bank.',
      action: 'Raise a NIP trace with the session ID. Do not resend — the instruction is live.',
      customer: 'Your transfer has left Wema and is with the payment network. It has not yet reached the receiving bank.',
    },
    RECEIVED_BY_BANK: {
      headline: 'Routed, but the beneficiary bank has not acknowledged',
      cause: 'NIBSS routed the instruction but the beneficiary bank has returned no acknowledgement.',
      action: 'Escalate to the beneficiary bank via the NIBSS dispute channel with the session ID attached.',
      customer: 'Your transfer has been sent to the receiving bank. We are waiting for them to confirm receipt.',
    },
    CREDITED: {
      headline: 'Received by the beneficiary bank, beneficiary not credited',
      cause: inSuspense
        ? 'The beneficiary bank confirmed receipt but the funds are sitting in a suspense account instead of the beneficiary account.'
        : 'The beneficiary bank confirmed receipt but has not posted the credit to the beneficiary account.',
      action: inSuspense
        ? 'Attach the suspense ledger entry and escalate for a sweep to the beneficiary account.'
        : 'Escalate to the beneficiary bank with the confirmed receipt event as evidence.',
      customer: 'Your account was successfully debited and the transfer reached the receiving bank, but the receiver has not been credited yet. Reconciliation is in progress.',
    },
  };

  const p = playbook[id] || playbook.CREDITED;
  const critical = anomalies.find((a) => a.severity === 'CRITICAL');

  return {
    headline: p.headline,
    cause: critical ? `${p.cause} ${critical.detail}` : p.cause,
    ownedBy: breakpoint ? breakpoint.owner : 'WEMA',
    ownedByLabel: breakpoint ? breakpoint.ownerLabel : OWNERS.WEMA,
    action: p.action,
    customerMessage: p.customer,
  };
}

module.exports = { reconcile, NGN };
