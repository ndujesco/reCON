'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Store } = require('../src/store');
const { classify, nipFee, vatOn, emtlOn } = require('../src/classify');
const { validate, matchSettlement } = require('../src/validation');

const store = new Store();
const ledger = store.ledger();
const result = store.validation();

const find = (code) => result.findings.filter((f) => f.code === code);

/* ------------------------------ Classification --------------------------- */

test('a posting code classifies exactly, with no guessing involved', () => {
  const out = classify({ postingCode: 'TAX-EMTL-50', narration: 'anything at all' });
  assert.equal(out.category, 'TAX');
  assert.equal(out.confidence, 1);
});

test('a narration with no code is read, but never over-trusted', () => {
  const out = classify({ narration: 'NIP TRF TO GTBANK URGENT' });
  assert.equal(out.category, 'CUSTOMER_TRANSFER');
  assert.ok(out.confidence < 1, 'a pattern match is weaker evidence than a posting code');
});

test('a narration that says nothing is held, not guessed at', () => {
  const out = classify({ narration: 'CR ADJ' });
  assert.equal(out.category, 'UNCLASSIFIED');
  assert.equal(out.confidence, 0);
});

test('NIP fees, VAT and the levy follow the published bands', () => {
  assert.equal(nipFee(4_000_00), 10_00, '₦4,000 sits in the ₦10 band');
  assert.equal(nipFee(40_000_00), 25_00, '₦40,000 sits in the ₦25 band');
  assert.equal(nipFee(250_000_00), 50_00, 'above ₦50,000 the fee is ₦50');
  assert.equal(vatOn(50_00), 375, 'VAT is 7.5% of the fee');
  assert.equal(emtlOn(9_999_00), 0, 'the levy does not apply below ₦10,000');
  assert.equal(emtlOn(10_000_00), 50_00, 'the levy is ₦50 from ₦10,000 up');
});

test('one transfer produces the transfer, the fee, the VAT and the levy', () => {
  const hero = 'WEM-20260818-004417';
  const postings = ledger.core.filter((r) => r.reference === hero);
  const categories = postings.map((r) => r.category).sort();
  assert.deepEqual(categories, ['CUSTOMER_TRANSFER', 'FEE', 'TAX', 'TAX']);
});

/* --------------------------- Settlement matching ------------------------- */

test('a record with a reference matches the settlement report exactly', () => {
  const match = matchSettlement(ledger);
  assert.ok(match.matched.length > 50, 'the clean majority matches on its reference');
  for (const { record, line } of match.matched) {
    assert.equal(record.reference, line.reference);
    assert.equal(record.amount, line.amount);
  }
});

test('a record with no reference is matched on amount, account and date, and only proposed', () => {
  const match = matchSettlement(ledger);
  assert.ok(match.probable.length > 0, 'the loose records do get matched');
  for (const p of match.probable) {
    assert.equal(p.record.reference, null, 'only referenceless records go through the fuzzy pass');
    assert.ok(p.confidence < 1, 'a probable match is never booked as certain');
    assert.equal(p.line.amount, p.record.amount);
    assert.ok(p.proposes.reference, 'the match proposes the reference the record was missing');
  }
});

test('a match is never claimed twice', () => {
  const match = matchSettlement(ledger);
  const used = [...match.matched, ...match.probable, ...match.mismatched].map((m) => m.line.settlementId);
  assert.equal(new Set(used).size, used.length, 'one settlement line, one match');
});

test('a transfer younger than the settlement window is not reported as missing', () => {
  const match = matchSettlement(ledger);
  for (const record of match.unmatchedInNip) {
    assert.ok(
      ledger.builtAt - record.valueDate > 30 * 60_000,
      'a transfer instructed minutes ago is in flight, not one-sided',
    );
  }
});

/* ------------------------------- Validation ------------------------------ */

test('the same posting booked twice is found and called critical', () => {
  const [dupe] = find('DUPLICATE_POSTING');
  assert.ok(dupe, 'the duplicate is detected');
  assert.equal(dupe.severity, 'CRITICAL');
  assert.equal(dupe.records.length, 2, 'both sides of the duplicate are named as evidence');
});

test('a settlement line with no posting behind it is critical, not a rounding note', () => {
  const [orphan] = find('UNMATCHED_IN_CORE');
  assert.ok(orphan, 'money settled with nothing booked against it is surfaced');
  assert.equal(orphan.severity, 'CRITICAL');
});

test('when the two sides disagree on an amount, the difference is stated', () => {
  const [mismatch] = find('AMOUNT_MISMATCH');
  assert.ok(mismatch);
  assert.ok(mismatch.amount > 0, 'the finding carries the size of the disagreement');
  assert.equal(mismatch.records.length, 2, 'both the posting and the settlement line are cited');
});

test('a closing balance that does not carry forward is caught, with the gap quantified', () => {
  const [gap] = find('BALANCE_BREAK');
  assert.ok(gap, 'the ledger break is detected');
  assert.equal(gap.amount, 250_000_00, 'the gap is the amount to go looking for');
  assert.equal(gap.severity, 'CRITICAL');
});

test('every finding names the records it is drawn from', () => {
  for (const f of result.findings) {
    assert.ok(f.records.length > 0, `${f.code} cites no evidence`);
    assert.ok(f.action, `${f.code} says what is wrong but not what to do`);
  }
});

test('findings are ranked worst first', () => {
  const rank = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  const order = result.findings.map((f) => rank[f.severity]);
  assert.deepEqual(order, [...order].sort((a, b) => b - a));
});

/* -------------------------------- Sources -------------------------------- */

test('both feeds are pulled, so neither needs anyone to sign in or upload', () => {
  const { sources } = store.sources();
  assert.equal(sources.length, 2);
  for (const s of sources) {
    assert.equal(s.status, 'CONNECTED');
    assert.ok(s.cadence, 'a pulled feed has a cadence; an uploaded one would not');
  }
});

test('the scope is stated: this build reconciles NIP and says so', () => {
  const { scope } = store.sources();
  assert.match(scope.rail, /NIP/);
  assert.ok(scope.excluded.includes('ATM'));
  assert.ok(scope.excluded.includes('Remittance'));
});

test('structured and unstructured records are counted separately, never merged', () => {
  const { totals } = store.sources();
  assert.ok(totals.unstructured > 0, 'the demo carries real loose records');
  assert.equal(totals.structured + totals.unstructured, totals.records);
});

/* ------------------------------ Query engine ----------------------------- */

test('the query bar filters on a field without anyone writing SQL', () => {
  const tax = store.records({ q: 'category:TAX' });
  assert.ok(tax.count > 0);
  assert.ok(tax.records.every((r) => r.category === 'TAX'));
});

test('unstructured:true returns exactly the records that need labelling', () => {
  const loose = store.records({ q: 'unstructured:true' });
  assert.ok(loose.count > 0);
  assert.ok(loose.records.every((r) => !r.structured));
});

test('terms combine, and free text still searches the narration', () => {
  const combined = store.records({ q: 'source:CORE_BANKING min:1000 NIP' });
  assert.ok(combined.records.every((r) => r.source === 'CORE_BANKING'));
  assert.ok(combined.records.every((r) => r.amount >= 1000 * 100));
  assert.ok(combined.records.every((r) => /nip/i.test(r.narration)));
});

test('a query that matches nothing returns nothing rather than everything', () => {
  assert.equal(store.records({ q: 'category:NONSENSE' }).count, 0);
});
