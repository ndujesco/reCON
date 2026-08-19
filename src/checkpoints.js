'use strict';

/**
 * The six checkpoints a Nigerian interbank transfer passes through.
 * ReCON's whole model is: a transaction is not a status, it is a chain of
 * checkpoints, each one proven by an event from a system Wema already sees.
 */
const CHECKPOINTS = [
  {
    id: 'INITIATED',
    label: 'Initiated',
    source: 'CORE_BANKING',
    owner: 'WEMA',
    slaMinutes: 1,
    customer: 'You started the transfer.',
    customerPending: 'You started the transfer.',
  },
  {
    id: 'DEBITED',
    label: 'Debited',
    source: 'CORE_BANKING',
    owner: 'WEMA',
    slaMinutes: 2,
    customer: 'Your Wema account was debited.',
    customerPending: 'Your Wema account has not been debited yet.',
  },
  {
    id: 'SENT_TO_NIBSS',
    label: 'Sent to NIBSS',
    source: 'NIP_GATEWAY',
    owner: 'WEMA',
    slaMinutes: 5,
    customer: 'The transfer left Wema and was sent to NIBSS.',
    customerPending: 'The transfer has not left Wema yet.',
  },
  {
    id: 'PROCESSED_BY_NIBSS',
    label: 'Processed by NIBSS',
    source: 'NIP_GATEWAY',
    owner: 'NIBSS',
    slaMinutes: 15,
    customer: 'NIBSS routed the transfer to the receiving bank.',
    customerPending: 'NIBSS has not routed the transfer to the receiving bank yet.',
  },
  {
    id: 'RECEIVED_BY_BANK',
    label: 'Received by beneficiary bank',
    source: 'BENEFICIARY_RESPONSE',
    owner: 'BENEFICIARY_BANK',
    slaMinutes: 30,
    customer: 'The receiving bank confirmed it got the transfer.',
    customerPending: 'The receiving bank has not confirmed it got the transfer.',
  },
  {
    id: 'CREDITED',
    label: 'Credited to beneficiary',
    source: 'BENEFICIARY_RESPONSE',
    owner: 'BENEFICIARY_BANK',
    slaMinutes: 60,
    customer: 'The receiver was credited. The transfer is complete.',
    customerPending: 'The receiver has not been credited yet.',
  },
];

const ORDER = CHECKPOINTS.map((c) => c.id);
const byId = Object.fromEntries(CHECKPOINTS.map((c) => [c.id, c]));

const SOURCES = {
  CORE_BANKING: 'Wema Core Banking',
  NIP_GATEWAY: 'NIBSS NIP Gateway',
  BENEFICIARY_RESPONSE: 'Beneficiary Bank Response',
  SUSPENSE_LEDGER: 'Suspense Account Ledger',
};

const OWNERS = {
  WEMA: 'Wema Bank',
  NIBSS: 'NIBSS',
  BENEFICIARY_BANK: 'Beneficiary bank',
};

module.exports = { CHECKPOINTS, ORDER, byId, SOURCES, OWNERS };
