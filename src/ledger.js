'use strict';

const { classify, nipFee, vatOn, emtlOn } = require('./classify');

/**
 * The two data pools ReCON sits between.
 *
 *   pool A: Wema core banking postings   (the bank's own books)
 *   pool B: the NIBSS NIP settlement report (what the rail says it settled)
 *
 * Reconciliation is not just "did the transfer arrive". It is also: does the
 * bank's own ledger agree with the rail's settlement report, line for line, and
 * do the general ledger balances roll forward without a break?
 *
 * Nothing here is uploaded by hand. Both pools are pulled on a schedule from
 * systems the bank already runs, which is why ReCON has no login and no import
 * screen: the data is already inside the bank, it just has never been joined.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Free-text narrations a real core banking extract carries when the channel
 *  never populated a structured reference. These are the records that cannot be
 *  matched on a reference and have to be flagged rather than guessed at. */
const LOOSE_NARRATIONS = [
  'TRF/GTB/URGENT PLS',
  'PAYMENT 8899',
  'NIP XFER OFFICE',
  'MOB TRF',
  'REF 00 SCHOOL FEES',
  'CR ADJ',
];

/**
 * Record ids are derived from the reference and the posting, not handed out by
 * a counter. The pools are rebuilt whenever the feed moves, and an id that
 * changed every rebuild would be useless as evidence.
 */
const recordId = (reference, suffix) => `LDG-${String(reference).slice(-6)}-${suffix}`;
const settlementId = (reference) => `STL-${String(reference).slice(-6)}`;

/**
 * Builds both pools from the reconciled transaction set, then deliberately
 * seeds the discrepancy classes a reconciliation officer actually chases:
 * duplicates, one-sided records, amount disagreements, and postings whose
 * narration carries no reference at all.
 */
function buildLedger(transactions, now = Date.now()) {
  const core = [];
  const settlement = [];

  transactions.forEach((t, i) => {
    const structured = i % 11 !== 7; // most feeds are clean; some records arrive loose

    // ---- pool A: core banking postings ----------------------------------
    const base = {
      recordId: recordId(t.reference, 'TRF'),
      reference: structured ? t.reference : null,
      source: 'CORE_BANKING',
      valueDate: t.initiatedAt,
      account: t.sender.account,
      beneficiaryAccount: t.beneficiary.account,
      counterparty: `${t.beneficiary.name} · ${t.beneficiary.bank}`,
      structured,
    };

    core.push(
      withCategory({
        ...base,
        postingCode: structured ? 'TRF-NIP-OUT' : null,
        narration: structured
          ? `NIP TRF TO ${t.beneficiary.bank.toUpperCase()} ${t.reference}`
          : LOOSE_NARRATIONS[i % LOOSE_NARRATIONS.length],
        amount: t.amount,
        drcr: 'DR',
      }),
    );

    // Fee, VAT and levy postings ride alongside every transfer. They are the
    // reason classification has to happen before matching: four postings, one
    // instruction, and only one of them is the customer's money moving.
    const fee = nipFee(t.amount);
    core.push(
      withCategory({
        ...base,
        recordId: recordId(t.reference, 'FEE'),
        postingCode: 'CHG-NIP-FEE',
        narration: `NIP TRANSFER FEE ${t.reference}`,
        amount: fee,
        drcr: 'DR',
        structured: true,
        reference: t.reference,
      }),
    );
    core.push(
      withCategory({
        ...base,
        recordId: recordId(t.reference, 'VAT'),
        postingCode: 'TAX-VAT-FEE',
        narration: `VAT ON NIP FEE ${t.reference}`,
        amount: vatOn(fee),
        drcr: 'DR',
        structured: true,
        reference: t.reference,
      }),
    );
    const emtl = emtlOn(t.amount);
    if (emtl) {
      core.push(
        withCategory({
          ...base,
          recordId: recordId(t.reference, 'LVY'),
          postingCode: 'TAX-EMTL-50',
          narration: `EMTL ${t.reference}`,
          amount: emtl,
          drcr: 'DR',
          structured: true,
          reference: t.reference,
        }),
      );
    }

    // A reversal books its own posting, on its own day, against the same
    // instruction. Counting it as a second transfer would double the book.
    if (t.state === 'REVERSED') {
      core.push(
        withCategory({
          ...base,
          recordId: recordId(t.reference, 'RVS'),
          postingCode: 'RVSL-NIP-IN',
          narration: `RVSL NIP RETURNED ${t.reference}`,
          amount: t.amount,
          drcr: 'CR',
          structured: true,
          reference: t.reference,
          valueDate: t.lastEventAt,
        }),
      );
    }

    // ---- pool B: the NIP settlement report ------------------------------
    // Only instructions that actually reached the rail appear on it.
    const reachedRail = t.chain.find((c) => c.id === 'SENT_TO_NIBSS')?.state === 'CONFIRMED';
    if (!reachedRail) return;

    // Deliberate discrepancies, seeded deterministically so the demo is stable.
    const dropFromSettlement = i === 9; // in the bank's books, absent from the rail's report
    const amountDisagreement = i === 14; // both sides have it, the figures differ

    if (dropFromSettlement) return;

    settlement.push({
      settlementId: settlementId(t.reference),
      reference: t.reference,
      source: 'NIP_SETTLEMENT_REPORT',
      sessionId: `0900${String(t.reference).slice(-8)}`,
      valueDate: t.initiatedAt,
      beneficiaryBank: t.beneficiary.bank,
      beneficiaryAccount: t.beneficiary.account,
      amount: amountDisagreement ? t.amount - 100_00 : t.amount,
      responseCode: t.state === 'RECONCILED' ? '00' : '09',
      category: 'SETTLEMENT',
    });
  });

  // A posting that went in twice: same reference, same amount, minutes apart.
  // The classic double-debit that only shows up when you count the lines. It is
  // deliberately not the hero transfer: each finding should tell one story.
  const dupSource = core.filter((r) => r.category === 'CUSTOMER_TRANSFER' && r.reference)[6];
  if (dupSource) {
    core.push({
      ...dupSource,
      recordId: recordId(dupSource.reference, 'TRF-DUP'),
      valueDate: dupSource.valueDate + 4 * MIN,
      narration: `${dupSource.narration} (RETRY)`,
    });
  }

  // A settlement line the rail reports that the bank's own books never posted.
  settlement.push({
    settlementId: settlementId('WEM-20260818-004901'),
    reference: 'WEM-20260818-004901',
    source: 'NIP_SETTLEMENT_REPORT',
    sessionId: '090000048891123',
    valueDate: now - 5 * HOUR,
    beneficiaryBank: 'Access Bank',
    beneficiaryAccount: '0447120933',
    amount: 8_450_000,
    responseCode: '00',
    category: 'SETTLEMENT',
  });

  return { core, settlement, balances: buildBalances(core, now), builtAt: now };
}

function withCategory(record) {
  const { category, confidence, basis } = classify(record);
  return { ...record, category, classification: { confidence, basis } };
}

/**
 * Seven days of general ledger movement for the NIP-facing accounts.
 *
 * Yesterday's closing balance has to equal today's opening balance. Where it
 * does not, money entered or left an account without a posting to explain it,
 * and the gap is the amount to go looking for.
 */
function buildBalances(core, now) {
  const ACCOUNTS = [
    { code: 'GL-1042', name: 'NIP Outward Settlement', opening: 4_820_000_00 },
    { code: 'GL-2210', name: 'NIP Fee Income', opening: 61_400_00 },
    { code: 'GL-2255', name: 'EMTL Payable', opening: 128_900_00 },
    { code: 'GL-3390', name: 'Suspense — NIP Unapplied', opening: 1_940_000_00 },
  ];

  const days = 7;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);

  return ACCOUNTS.map((acct) => {
    const periods = [];
    let opening = acct.opening;

    for (let d = days - 1; d >= 0; d--) {
      const date = startOfToday - d * DAY;
      // Deterministic movement, so the same story is told on every run.
      const seed = (acct.code.charCodeAt(3) * 31 + d * 17) % 97;
      const debits = (seed + 12) * 41_500;
      const credits = (seed + 5) * 39_800;
      const closing = opening + debits - credits;

      // The break: on the suspense account, one day's closing does not carry
      // forward. The gap is exactly the hero transfer, parked and never swept.
      const carryBreak = acct.code === 'GL-3390' && d === 2 ? 250_000_00 : 0;

      periods.push({
        date,
        opening,
        debits,
        credits,
        closing,
        carriedForward: closing - carryBreak,
        break: carryBreak
          ? {
              amount: carryBreak,
              detail: 'Closing balance did not carry forward into the next day. Nothing was posted to explain the difference.',
            }
          : null,
      });

      opening = closing - carryBreak;
    }

    const held = core
      .filter((r) => r.category === 'FEE' && acct.code === 'GL-2210')
      .reduce((s, r) => s + r.amount, 0);

    return { ...acct, periods, todaysFeeAccrual: held || null };
  });
}

module.exports = { buildLedger };
