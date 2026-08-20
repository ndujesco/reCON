'use strict';

const { CATEGORIES, byId: categoryById } = require('./classify');

/**
 * Data validation and settlement matching.
 *
 * Tracing one transfer down the six checkpoints answers "where is this
 * customer's money". This layer answers the question the reconciliation desk
 * asks about the whole book at once: do the bank's records and the rail's
 * settlement report actually agree, and is anything in either pool malformed,
 * duplicated or unexplained?
 *
 * Six checks run over both pools:
 *
 *   DUPLICATE_POSTING   the same instruction posted more than once
 *   UNMATCHED_IN_NIP    in the bank's books, absent from the settlement report
 *   UNMATCHED_IN_CORE   on the settlement report, never posted in the books
 *   AMOUNT_MISMATCH     both sides carry it, the figures disagree
 *   BALANCE_BREAK       a closing balance that did not carry forward
 *   UNSTRUCTURED        no reference to match on; held for labelling
 *
 * Every finding names the records it is drawn from, so nothing has to be taken
 * on trust: the evidence is one click away, the same as in the transfer trail.
 */

const SEVERITY_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const NGN = (kobo) =>
  '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** How close in time two records have to be to be considered the same event. */
const FUZZY_WINDOW_MS = 30 * 60_000;

/**
 * A transfer instructed two minutes ago is not missing from the settlement
 * report, it is simply younger than the report. Only postings older than the
 * NIP settlement window count as one-sided.
 */
const SETTLEMENT_WINDOW_MS = 30 * 60_000;

/**
 * Matches core banking transfer postings against the NIP settlement report.
 *
 * Structured records carry a reference, so they match exactly: that is the
 * whole reason a reference exists. Records that arrived with nothing but free
 * text get a second pass, matched on amount, beneficiary account and value
 * date. A fuzzy match is never treated as settled fact. It is proposed, scored,
 * and flagged for a human to confirm, because a probable match booked as a
 * certain one is worse than no match at all.
 */
function matchSettlement(ledger, now = ledger.builtAt || Date.now()) {
  const settled = (record) => now - record.valueDate > SETTLEMENT_WINDOW_MS;
  const transfers = ledger.core.filter((r) => r.category === 'CUSTOMER_TRANSFER');
  const byReference = new Map();
  for (const line of ledger.settlement) byReference.set(line.reference, line);

  const matched = [];
  const unmatchedInNip = [];
  const mismatched = [];
  const probable = [];
  const awaitingSettlement = [];
  const duplicateClaims = [];
  const claimed = new Set();

  const structured = transfers.filter((r) => r.reference);
  // Pass two draws from every referenceless posting, not just the ones the
  // narration already looked like a transfer. A record whose narration says
  // only "CR ADJ" is exactly the record that needs matching the most.
  const loose = ledger.core.filter((r) => !r.structured);

  // ---- pass one: exact, on the reference ---------------------------------
  for (const record of structured) {
    const line = byReference.get(record.reference);
    if (!line) {
      if (settled(record)) unmatchedInNip.push(record);
      else awaitingSettlement.push(record);
      continue;
    }

    // One instruction settles once. A second posting against a line that is
    // already matched is not a match, it is the duplicate, and counting it as
    // a match would hide the very thing that makes it a problem.
    if (claimed.has(line.settlementId)) {
      duplicateClaims.push({ record, line });
      continue;
    }
    claimed.add(line.settlementId);

    if (line.amount !== record.amount) mismatched.push({ record, line, delta: record.amount - line.amount });
    else matched.push({ record, line });
  }

  // ---- pass two: probable, for records with no reference to match on -----
  const openLines = ledger.settlement.filter((line) => !claimed.has(line.settlementId));
  for (const record of loose) {
    const candidate = openLines.find(
      (line) =>
        !claimed.has(line.settlementId) &&
        line.amount === record.amount &&
        line.beneficiaryAccount === record.beneficiaryAccount &&
        Math.abs(line.valueDate - record.valueDate) <= FUZZY_WINDOW_MS,
    );

    if (!candidate) {
      if (settled(record)) unmatchedInNip.push(record);
      else awaitingSettlement.push(record);
      continue;
    }

    claimed.add(candidate.settlementId);
    // Amount, account and value date all agreeing is strong, but it is still
    // three coincidences rather than one identifier, so it stays provisional.
    // The match also proposes the two things the record was missing: the
    // reference it should have carried, and what kind of transaction it is.
    probable.push({
      record,
      line: candidate,
      confidence: 0.82,
      basis: 'Amount, beneficiary account and value date all agree, but the posting carries no reference.',
      proposes: {
        reference: candidate.reference,
        category: 'CUSTOMER_TRANSFER',
        wasClassifiedAs: record.category,
      },
    });
  }

  const unmatchedInCore = ledger.settlement.filter((line) => !claimed.has(line.settlementId));

  return {
    matched,
    mismatched,
    probable,
    awaitingSettlement,
    duplicateClaims,
    unmatchedInNip,
    unmatchedInCore,
    totals: {
      coreRecords: structured.length + loose.length,
      settlementLines: ledger.settlement.length,
      matched: matched.length,
      probable: probable.length,
      awaitingSettlement: awaitingSettlement.length,
      duplicateClaims: duplicateClaims.length,
      exceptions:
        mismatched.length + unmatchedInNip.length + unmatchedInCore.length + duplicateClaims.length,
      matchRate: structured.length ? Math.round((matched.length / structured.length) * 100) : 0,
      autoMatchRate: structured.length + loose.length
        ? Math.round(((matched.length + probable.length) / (structured.length + loose.length)) * 100)
        : 0,
    },
  };
}

/** Runs every validation check over both pools and returns ranked findings. */
function validate(ledger) {
  const findings = [];
  const match = matchSettlement(ledger);

  // ---- duplicates --------------------------------------------------------
  const seen = new Map();
  for (const record of ledger.core) {
    if (!record.reference) continue;
    const key = `${record.reference}|${record.category}|${record.amount}`;
    if (seen.has(key)) {
      const first = seen.get(key);
      findings.push({
        code: 'DUPLICATE_POSTING',
        severity: 'CRITICAL',
        reference: record.reference,
        amount: record.amount,
        headline: 'The same posting was booked twice',
        detail: `${categoryById[record.category].label} of ${NGN(record.amount)} on ${record.reference} appears twice in core banking, ${Math.round(
          (record.valueDate - first.valueDate) / 60_000,
        )} minutes apart. Only one instruction was ever sent to NIP, so the customer has been charged twice.`,
        action: 'Reverse the duplicate posting and confirm only one settlement line exists for the reference.',
        records: [first.recordId, record.recordId],
      });
    } else {
      seen.set(key, record);
    }
  }

  // ---- one-sided and disagreeing records ---------------------------------
  for (const record of match.unmatchedInNip) {
    const named = record.reference
      ? record.reference
      : `the posting narrated “${record.narration}”`;
    findings.push({
      code: 'UNMATCHED_IN_NIP',
      severity: 'HIGH',
      reference: record.reference,
      amount: record.amount,
      headline: 'Posted by Wema, missing from the NIP settlement report',
      detail: `${NGN(record.amount)} was debited and booked in core banking, but ${named} does not appear on the NIBSS settlement report for the session. Either the instruction never reached the rail, or it settled without being reported. Until one of those is true, the customer is out of funds that the rail has no record of.`,
      action: record.reference
        ? 'Raise a NIP trace on the session ID before the settlement window closes.'
        : 'Label the posting so it can be traced, then raise a NIP trace before the settlement window closes.',
      records: [record.recordId],
    });
  }

  for (const line of match.unmatchedInCore) {
    findings.push({
      code: 'UNMATCHED_IN_CORE',
      severity: 'CRITICAL',
      reference: line.reference,
      amount: line.amount,
      headline: 'Settled by NIBSS, never posted in Wema’s books',
      detail: `The NIP settlement report carries ${NGN(line.amount)} against ${line.reference} on session ${line.sessionId}, but core banking has no posting for it. Wema has settled money it has not booked.`,
      action: 'Post the missing entry against the settlement line, or dispute the line with NIBSS.',
      records: [line.settlementId],
    });
  }

  for (const { record, line, delta } of match.mismatched) {
    findings.push({
      code: 'AMOUNT_MISMATCH',
      severity: 'CRITICAL',
      reference: record.reference,
      amount: Math.abs(delta),
      headline: 'The two sides disagree on the amount',
      detail: `Core banking booked ${NGN(record.amount)} and the NIP settlement report carries ${NGN(
        line.amount,
      )} for ${record.reference}: a difference of ${NGN(Math.abs(delta))}.`,
      action: 'Confirm the instructed amount against the original request, then correct the side that is wrong.',
      records: [record.recordId, line.settlementId],
    });
  }

  // ---- general ledger continuity ----------------------------------------
  for (const account of ledger.balances) {
    for (const period of account.periods) {
      if (!period.break) continue;
      findings.push({
        code: 'BALANCE_BREAK',
        severity: 'CRITICAL',
        reference: account.code,
        amount: period.break.amount,
        headline: 'A closing balance did not carry forward',
        detail: `${account.name} (${account.code}) closed at ${NGN(period.closing)} on ${new Date(
          period.date,
        ).toDateString()} but opened the next day at ${NGN(period.carriedForward)}. ${NGN(
          period.break.amount,
        )} moved with no posting to explain it.`,
        action: 'Trace the difference against the suspense entries for that value date.',
        records: [account.code],
      });
    }
  }

  // ---- records that cannot be matched on a reference at all --------------
  const loose = ledger.core.filter((r) => !r.structured);
  const unclassified = loose.filter((r) => r.category === 'UNCLASSIFIED');
  if (loose.length) {
    findings.push({
      code: 'UNSTRUCTURED',
      severity: 'MEDIUM',
      reference: null,
      amount: loose.reduce((s, r) => s + r.amount, 0),
      headline: `${loose.length} records arrived without a reference`,
      detail: `These postings carry free-text narration only, so there is no reference to match them on. ${match.probable.length} were matched to a settlement line on amount, account and value date, and are held as probable rather than booked as certain. ${unclassified.length} could not even be classified from the narration, and have been held rather than guessed at.`,
      action: 'Confirm or reject the probable matches, and label the held records so they join the matched set on the next run.',
      records: loose.slice(0, 6).map((r) => r.recordId),
    });
  }

  findings.sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.amount - a.amount,
  );

  const exposure = findings
    .filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH')
    .reduce((s, f) => s + f.amount, 0);

  return {
    findings,
    match,
    summary: {
      total: findings.length,
      critical: findings.filter((f) => f.severity === 'CRITICAL').length,
      high: findings.filter((f) => f.severity === 'HIGH').length,
      medium: findings.filter((f) => f.severity === 'MEDIUM').length,
      exposure,
      exposureFormatted: NGN(exposure),
    },
  };
}

/** Where the data came from, and how much of it arrived in a matchable shape. */
function sourceSummary(ledger, now = Date.now()) {
  const core = ledger.core;
  const structured = core.filter((r) => r.structured).length;
  const classified = core.filter((r) => r.category !== 'UNCLASSIFIED').length;

  const breakdown = CATEGORIES.filter((c) => c.id !== 'SETTLEMENT').map((c) => {
    const rows = core.filter((r) => r.category === c.id);
    return { id: c.id, label: c.label, short: c.short, count: rows.length, value: rows.reduce((s, r) => s + r.amount, 0) };
  });

  return {
    // Both feeds are pulled, not uploaded. There is no import screen and no
    // login because there is nothing for a human to carry across.
    sources: [
      {
        id: 'CORE_BANKING',
        name: 'Wema Core Banking',
        kind: 'Internal',
        detail: 'Postings, charges and general ledger movement, pulled straight from the bank’s own books.',
        records: core.length,
        structured,
        unstructured: core.length - structured,
        lastSync: now - 41_000,
        cadence: 'every 60 seconds',
        status: 'CONNECTED',
      },
      {
        id: 'NIP_SETTLEMENT_REPORT',
        name: 'NIBSS NIP',
        kind: 'External rail',
        detail: 'Gateway traffic and the NIP net settlement report for each session.',
        records: ledger.settlement.length,
        structured: ledger.settlement.length,
        unstructured: 0,
        lastSync: now - 118_000,
        cadence: 'every settlement session',
        status: 'CONNECTED',
      },
    ],
    totals: {
      records: core.length + ledger.settlement.length,
      structured: structured + ledger.settlement.length,
      unstructured: core.length - structured,
      structuredPct: Math.round(((structured + ledger.settlement.length) / (core.length + ledger.settlement.length)) * 100),
      classifiedPct: Math.round((classified / core.length) * 100),
    },
    breakdown,
    scope: {
      rail: 'NIP — NIBSS Instant Payments',
      included: 'Outward interbank transfers on the NIP rail, and the fees, VAT and levies booked against them.',
      excluded: ['ATM', 'Remittance', 'Cheque clearing', 'Card settlement'],
      note: 'One rail, reconciled properly. The engine is shape-agnostic, so a second rail is a new feed, not a new product.',
    },
  };
}

module.exports = { validate, matchSettlement, sourceSummary, NGN };
