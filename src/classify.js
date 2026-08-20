'use strict';

/**
 * Transaction classification.
 *
 * The reconciliation officer's point: a bank's ledger is not one kind of thing.
 * A single ₦250,000 transfer produces a transfer posting, a NIP fee, VAT on
 * that fee and an electronic money transfer levy, all on the same day, all
 * against the same customer. Reconciling them as one undifferentiated pile is
 * how a fee break gets mistaken for a missing transfer.
 *
 * So every ingested record is classified before it is matched, and the queue,
 * the validation checks and the settlement match all run per category.
 */

const CATEGORIES = [
  {
    id: 'CUSTOMER_TRANSFER',
    label: 'Customer transfer',
    short: 'Transfer',
    description: 'An outward NIP instruction on behalf of a customer.',
  },
  {
    id: 'FEE',
    label: 'Transfer fee',
    short: 'Fee',
    description: 'The NIP transfer fee charged on the instruction (₦10 / ₦25 / ₦50 by band).',
  },
  {
    id: 'TAX',
    label: 'Tax & levy',
    short: 'Tax',
    description: 'VAT on the transfer fee, and the ₦50 electronic money transfer levy on transfers of ₦10,000 and above.',
  },
  {
    id: 'REVERSAL',
    label: 'Reversal',
    short: 'Reversal',
    description: 'Funds returned to the originating account after a failed instruction.',
  },
  {
    id: 'SETTLEMENT',
    label: 'NIP settlement',
    short: 'Settlement',
    description: 'A line on the NIBSS net settlement report for the session.',
  },
  {
    id: 'UNCLASSIFIED',
    label: 'Unclassified',
    short: 'Unclassified',
    description: 'The narration carries no reference and no recognisable pattern. Held for labelling before it is matched.',
  },
];

const byId = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

/* Nigerian NIP pricing, as the CBN guide to bank charges sets it. */
const NGN = 100; // one naira, in kobo
const EMTL = 50 * NGN; // electronic money transfer levy, on transfers >= ₦10,000
const VAT_RATE = 0.075;

/** The NIP fee band for a transfer amount, in kobo. */
function nipFee(amountKobo) {
  const naira = amountKobo / 100;
  if (naira <= 5_000) return 10 * NGN;
  if (naira <= 50_000) return 25 * NGN;
  return 50 * NGN;
}

const vatOn = (feeKobo) => Math.round(feeKobo * VAT_RATE);
const emtlOn = (amountKobo) => (amountKobo >= 10_000 * NGN ? EMTL : 0);

/**
 * Classifies a raw ledger record from its narration.
 *
 * Structured records carry an explicit posting code, so classification is a
 * lookup. Unstructured ones only have free text, so we read the narration; if
 * nothing matches, the record is UNCLASSIFIED rather than guessed at, and the
 * validation layer surfaces it for labelling.
 */
function classify(record) {
  if (record.postingCode) {
    const fromCode = {
      'TRF-NIP-OUT': 'CUSTOMER_TRANSFER',
      'CHG-NIP-FEE': 'FEE',
      'TAX-VAT-FEE': 'TAX',
      'TAX-EMTL-50': 'TAX',
      'RVSL-NIP-IN': 'REVERSAL',
      'STL-NIP-NET': 'SETTLEMENT',
    }[record.postingCode];
    if (fromCode) return { category: fromCode, confidence: 1, basis: `Posting code ${record.postingCode}` };
  }

  const text = (record.narration || '').toUpperCase();
  const patterns = [
    [/\bEMTL\b|ELECTRONIC MONEY TRANSFER LEVY|STAMP DUTY|\bVAT\b/, 'TAX'],
    [/\bFEE\b|\bCHARGE\b|\bCOMM\b/, 'FEE'],
    [/\bRVSL\b|REVERSAL|RETURNED/, 'REVERSAL'],
    [/\bSETTL|\bNET SETTLEMENT\b/, 'SETTLEMENT'],
    [/\bTRF\b|TRANSFER|\bNIP\b|\bXFER\b/, 'CUSTOMER_TRANSFER'],
  ];
  for (const [re, category] of patterns) {
    if (re.test(text)) return { category, confidence: 0.6, basis: 'Narration pattern' };
  }

  return { category: 'UNCLASSIFIED', confidence: 0, basis: 'No posting code and no recognisable narration' };
}

module.exports = { CATEGORIES, byId, classify, nipFee, vatOn, emtlOn, EMTL, VAT_RATE };
