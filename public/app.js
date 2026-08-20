'use strict';

/* ReCON dashboard: talks to the reconciliation API and renders the trail. */

const $ = (sel) => document.querySelector(sel);
const api = (path) => fetch(path).then((r) => r.json());

const recordState = { query: '', category: 'all' };

const state = {
  filter: 'exceptions',
  query: '',
  selected: null,
  mode: 'support', // 'support' | 'customer'
  transactions: [],
  known: new Set(),
};

const NGN = (kobo) => '₦' + (kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 });

function ago(ms) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const hours = ms / 3_600_000;
  // Support staff think in hours, not days: a stuck transfer is "26h", not "1.1d".
  if (hours < 10) return `${hours.toFixed(1)}h`;
  if (hours < 72) return `${Math.round(hours)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

const clock = (ts) =>
  new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const STATE_LABEL = {
  RECONCILED: 'Reconciled',
  IN_FLIGHT: 'In flight',
  DELAYED: 'Delayed',
  BROKEN: 'Broken chain',
  REVERSED: 'Reversed',
};

/* ---------------------------------- KPIs --------------------------------- */
function renderKpis(s) {
  const tiles = [
    { label: 'Reconciled', value: `${s.reconciledPct}%`, sub: `${s.reconciled} of ${s.total} transactions`, cls: 'is-ok' },
    { label: 'Exception queue', value: s.exceptions, sub: `${s.broken} broken · ${s.delayed} delayed`, cls: 'is-bad' },
    { label: 'Value at risk', value: NGN(s.valueAtRisk), sub: 'customer funds not yet settled', cls: 'is-bad' },
    { label: 'In suspense', value: NGN(s.suspenseValue), sub: `${s.suspenseCount} entries awaiting sweep`, cls: 'is-warn' },
    { label: 'Time to locate', value: `${s.avgLocateMs.toFixed(2)}ms`, sub: 'per transaction, vs 24–48h today', cls: '' },
  ];
  $('#kpis').innerHTML = tiles
    .map(
      (t) => `<div class="kpi ${t.cls}">
        <div class="kpi-label">${t.label}</div>
        <div class="kpi-value">${t.value}</div>
        <div class="kpi-sub">${t.sub}</div>
      </div>`,
    )
    .join('');
}

/* --------------------------------- Queue --------------------------------- */
function renderQueue() {
  const list = $('#txn-list');
  $('#queue-count').textContent = `${state.transactions.length} transactions`;

  list.innerHTML = state.transactions
    .map((t) => {
      const isNew = !state.known.has(t.reference);
      state.known.add(t.reference);
      const pips = Array.from({ length: 6 }, (_, i) => `<i class="pip ${i < t.confirmedCount ? 'on' : ''}"></i>`).join('');
      return `<li class="txn s-${t.state} ${t.reference === state.selected ? 'is-selected' : ''} ${isNew ? 'is-new' : ''}"
                  data-ref="${t.reference}" role="button" tabindex="0">
        <span class="txn-bar s-${t.state}"></span>
        <span class="txn-main">
          <span class="txn-ref">${t.reference}</span>
          <span class="txn-meta">${t.beneficiary.name} · ${t.beneficiary.bank}</span>
          <span class="pips">${pips}</span>
        </span>
        <span class="txn-right">
          <span class="txn-amount">${t.amountFormatted.replace('.00', '')}</span>
          <span class="txn-age">${t.state === 'RECONCILED' ? STATE_LABEL[t.state] : 'stuck ' + ago(t.stalledForMs)}</span>
        </span>
      </li>`;
    })
    .join('');
}

/* -------------------------------- Detail --------------------------------- */
const tick = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const cross = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>';

function renderDetail(t) {
  const head = `
    <div class="detail-head">
      <div class="detail-title">
        <div class="detail-ref">
          ${t.reference}
          <span class="badge s-${t.state}">${STATE_LABEL[t.state]}</span>
        </div>
        <div class="detail-parties">
          <b>${t.sender.name}</b> (Wema ••${t.sender.account.slice(-4)}) →
          <b>${t.beneficiary.name}</b> (${t.beneficiary.bank} ••${t.beneficiary.account.slice(-4)}) · ${t.channel}
        </div>
      </div>
      <div class="toggle" id="mode-toggle">
        <button data-mode="support" class="${state.mode === 'support' ? 'is-active' : ''}">Support view</button>
        <button data-mode="customer" class="${state.mode === 'customer' ? 'is-active' : ''}">Customer view</button>
      </div>
      <div class="detail-amount">
        <div class="v">${t.amountFormatted}</div>
        <div class="l">${t.state === 'RECONCILED' ? 'settled' : 'stuck for ' + ago(t.stalledForMs)}</div>
      </div>
    </div>`;

  $('#detail').innerHTML = head + (state.mode === 'support' ? supportView(t) : customerView(t));
  $('#mode-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    renderDetail(t);
  });
}

function supportView(t) {
  const broken = t.state === 'BROKEN' || t.state === 'DELAYED';

  const rail = t.chain
    .map((c) => {
      const isBreak = t.breakpoint && c.id === t.breakpoint.id;
      const cls = c.state === 'CONFIRMED' ? 'done' : isBreak ? 'broken' : 'pending';
      const body =
        c.state === 'CONFIRMED'
          ? `<div class="hop-evidence"><span class="src">${c.sourceSystem}</span> · ${c.evidence.eventId} · ${c.evidence.code}</div>`
          : isBreak
            ? `<div class="hop-missing">No event received from ${c.sourceSystem}. The chain breaks here.</div>`
            : `<div class="hop-evidence">Awaiting ${c.sourceSystem}</div>`;
      return `<li class="hop ${cls}">
        <span class="hop-node">${c.state === 'CONFIRMED' ? tick : isBreak ? cross : ''}</span>
        <span><span class="hop-label">${c.label}</span>${body}</span>
        <span class="hop-time">${c.at ? clock(c.at) : '–'}</span>
      </li>`;
    })
    .join('');

  const anomalies = t.anomalies.length
    ? `<ul class="anomalies">${t.anomalies
        .map((a) => `<li class="anomaly sev-${a.severity}"><code>${a.code}</code><span>${a.detail}</span></li>`)
        .join('')}</ul>`
    : '';

  const diagnosis = `
    <div class="diagnosis ${broken ? '' : 'ok'}">
      <h3>${t.diagnosis.headline}</h3>
      <p>${t.diagnosis.cause}</p>
      <div class="diag-grid">
        <div class="diag-cell"><div class="k">Owned by</div><div class="v">${t.diagnosis.ownedByLabel || 'Wema Bank'}</div></div>
        <div class="diag-cell"><div class="k">Recommended action</div><div class="v">${t.diagnosis.action}</div></div>
      </div>
      ${anomalies}
    </div>`;

  const events = t.events
    .map(
      (e) => `<tr class="${e.status === 'FAILED' ? 'row-fail' : ''}">
        <td class="mono">${clock(e.ts)}</td>
        <td>${e.source}</td>
        <td>${e.checkpoint}</td>
        <td class="mono">${e.code || '–'}</td>
        <td class="num">${e.amount || '–'}</td>
      </tr>`,
    )
    .join('');

  return `<div class="detail-body">
      ${diagnosis}
      <div class="section-label">Checkpoint trail: every hop proven by a source event</div>
      <ul class="rail">${rail}</ul>
      <div class="section-label">Raw evidence log: ${t.events.length} normalised events</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th class="mono">Time</th><th>Source system</th><th>Checkpoint</th><th class="mono">Code</th><th class="num">Amount</th></tr></thead>
          <tbody>${events}</tbody>
        </table>
      </div>
    </div>`;
}

function customerView(t) {
  const breakIdx = t.breakpoint ? t.chain.findIndex((c) => c.id === t.breakpoint.id) : -1;

  const steps = t.chain
    .map((c, i) => {
      const done = c.state === 'CONFIRMED';
      const isBreak = i === breakIdx;
      const cls = done ? '' : isBreak ? 'broken' : 'pending';
      const sub = done
        ? `Confirmed at ${clock(c.at)}`
        : isBreak
          ? 'This is where your transfer stopped.'
          : 'Not yet reached';
      return `<li class="cust-step ${cls}">
        <span class="cust-icon">${done ? '✓' : isBreak ? '!' : ''}</span>
        <span><span class="cust-text">${done ? c.customer : c.customerPending}</span><span class="cust-sub">${sub}</span></span>
      </li>`;
    })
    .join('');

  return `<div class="detail-body">
      <div class="customer">
        <div class="phone-note">Exactly what the customer sees in the Wema app: the same trail, no internal system detail.</div>
        <div class="cust-message">
          <div class="k">Status of your ${t.amountFormatted.replace('.00', '')} transfer</div>
          <p>${t.diagnosis.customerMessage}</p>
        </div>
        <div class="section-label">Your transfer, step by step</div>
        <ul class="cust-steps">${steps}</ul>
      </div>
    </div>`;
}

/* ----------------------------- Data sources ------------------------------ */
const CATEGORY_TONE = {
  CUSTOMER_TRANSFER: 'cat-transfer',
  FEE: 'cat-fee',
  TAX: 'cat-tax',
  REVERSAL: 'cat-reversal',
  SETTLEMENT: 'cat-settlement',
  UNCLASSIFIED: 'cat-unclassified',
};

async function renderSources() {
  const s = await api('/api/sources');
  $('#sources-count').textContent = `${s.sources.length} feeds · ${s.totals.records.toLocaleString()} records ingested`;

  $('#source-grid').innerHTML = s.sources
    .map(
      (src) => `<div class="source-card">
        <div class="source-top">
          <span class="source-name">${src.name}</span>
          <span class="source-status">${src.status === 'CONNECTED' ? 'Connected' : src.status}</span>
        </div>
        <div class="source-kind">${src.kind}</div>
        <p class="source-detail">${src.detail}</p>
        <div class="source-stats">
          <div><span class="k">Records</span><span class="v">${src.records.toLocaleString()}</span></div>
          <div><span class="k">Last sync</span><span class="v">${ago(Date.now() - src.lastSync)} ago</span></div>
          <div><span class="k">Cadence</span><span class="v">${src.cadence}</span></div>
        </div>
      </div>`,
    )
    .join('') +
    `<div class="source-card is-scope">
        <div class="source-top"><span class="source-name">Scope</span></div>
        <div class="source-kind">${s.scope.rail}</div>
        <p class="source-detail">${s.scope.included}</p>
        <div class="scope-out">Out of scope this phase: ${s.scope.excluded.join(' · ')}</div>
        <p class="source-detail">${s.scope.note}</p>
      </div>`;

  // Structured vs unstructured, and what each record was classified as.
  $('#shape-count').textContent = `${s.totals.structuredPct}% structured · ${s.totals.classifiedPct}% classified`;
  const maxCount = Math.max(...s.breakdown.map((b) => b.count), 1);
  $('#shape-grid').innerHTML = `
    <div class="shape-split">
      <div class="split-bar">
        <span class="seg seg-ok" style="width:${s.totals.structuredPct}%"></span>
        <span class="seg seg-warn" style="width:${100 - s.totals.structuredPct}%"></span>
      </div>
      <div class="split-legend">
        <span><i class="sw sw-ok"></i>${s.totals.structured.toLocaleString()} structured, matched on their reference</span>
        <span><i class="sw sw-warn"></i>${s.totals.unstructured.toLocaleString()} free text, flagged and held</span>
      </div>
    </div>
    <div class="cat-bars">
      ${s.breakdown
        .map(
          (b) => `<div class="cat-row">
            <span class="cat-chip ${CATEGORY_TONE[b.id]}">${b.short}</span>
            <span class="cat-track"><i style="width:${Math.round((b.count / maxCount) * 100)}%"></i></span>
            <span class="cat-count">${b.count}</span>
            <span class="cat-value">${NGN(b.value)}</span>
          </div>`,
        )
        .join('')}
    </div>`;
}

async function renderRecords() {
  const params = new URLSearchParams();
  if (recordState.query) params.set('q', recordState.query);
  if (recordState.category !== 'all') params.set('category', recordState.category);
  const data = await api(`/api/records?${params}`);

  $('#records-count').textContent = `${data.count.toLocaleString()} records · ${NGN(data.totalValue)}`;

  $('#record-filters').innerHTML =
    `<button class="chip ${recordState.category === 'all' ? 'is-active' : ''}" data-category="all">All</button>` +
    data.categories
      .map(
        (c) =>
          `<button class="chip ${recordState.category === c.id ? 'is-active' : ''}" data-category="${c.id}" title="${c.description}">${c.short} <b>${c.count}</b></button>`,
      )
      .join('');

  $('#records-body').innerHTML = data.records.length
    ? data.records
        .map(
          (r) => `<tr class="${r.structured ? '' : 'row-loose'}">
            <td class="mono">${r.recordId}</td>
            <td><span class="cat-chip ${CATEGORY_TONE[r.category]}">${r.categoryLabel}</span></td>
            <td class="mono">${r.reference || '<span class="flag">no reference</span>'}</td>
            <td class="narration">${r.narration}</td>
            <td>${r.source === 'CORE_BANKING' ? 'Core banking' : 'NIP settlement'}</td>
            <td class="num">${r.drcr === 'CR' ? '' : '−'}${NGN(r.amount)}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="6" class="empty-row">No records match that query.</td></tr>';
}

/* ------------------------------ Validation ------------------------------- */
async function renderValidation() {
  const [match, data, balances] = await Promise.all([
    api('/api/settlement'),
    api('/api/validation'),
    api('/api/balances'),
  ]);

  // ---- settlement match --------------------------------------------------
  const t = match.totals;
  $('#match-count').textContent = `${t.coreRecords} core postings vs ${t.settlementLines} settlement lines`;
  const tiles = [
    { label: 'Matched on reference', value: t.matched, sub: `${t.matchRate}% of referenced postings`, cls: 'is-ok' },
    { label: 'Matched on amount, account & date', value: t.probable, sub: 'proposed, awaiting confirmation', cls: 'is-warn' },
    { label: 'Still inside the settlement window', value: t.awaitingSettlement, sub: 'too young to be missing yet', cls: '' },
    { label: 'Posted, not on the NIP report', value: match.unmatchedInNip.length, sub: 'debited but never settled', cls: 'is-bad' },
    { label: 'Settled, not in Wema’s books', value: match.unmatchedInCore.length, sub: 'money moved with no posting', cls: 'is-bad' },
    { label: 'Amounts disagree', value: match.mismatched.length, sub: 'both sides carry it, figures differ', cls: 'is-bad' },
  ];
  $('#match-grid').innerHTML =
    `<div class="match-tiles">${tiles
      .map(
        (x) => `<div class="kpi ${x.cls}">
          <div class="kpi-label">${x.label}</div>
          <div class="kpi-value">${x.value}</div>
          <div class="kpi-sub">${x.sub}</div>
        </div>`,
      )
      .join('')}</div>` +
    (match.probable.length
      ? `<div class="section-label">Proposed matches for records that arrived with no reference</div>
         <div class="table-wrap">
           <table>
             <thead><tr><th>Record</th><th>Narration as received</th><th>Proposed reference</th><th>Proposed label</th><th class="num">Amount</th><th class="num">Confidence</th></tr></thead>
             <tbody>${match.probable
               .map(
                 (p) => `<tr>
                   <td class="mono">${p.recordId}</td>
                   <td class="narration">${p.narration}</td>
                   <td class="mono">${p.proposes.reference}</td>
                   <td><span class="cat-chip cat-transfer">Transfer</span>${
                     p.proposes.wasClassifiedAs === 'UNCLASSIFIED'
                       ? '<span class="was">was unclassified</span>'
                       : ''
                   }</td>
                   <td class="num">${NGN(p.amount)}</td>
                   <td class="num">${Math.round(p.confidence * 100)}%</td>
                 </tr>`,
               )
               .join('')}</tbody>
           </table>
         </div>`
      : '');

  // ---- findings ----------------------------------------------------------
  const sum = data.summary;
  $('#findings-count').textContent = `${sum.total} findings · ${sum.exposureFormatted} exposed`;
  $('#findings-list').innerHTML = data.findings
    .map(
      (f) => `<li class="finding sev-${f.severity}">
        <div class="finding-head">
          <code>${f.code}</code>
          <span class="finding-title">${f.headline}</span>
          <span class="finding-amount">${NGN(f.amount)}</span>
        </div>
        <p class="finding-detail">${f.detail}</p>
        <div class="finding-foot">
          <span class="finding-action"><b>Next:</b> ${f.action}</span>
          <span class="finding-records">${f.records.join(' · ')}</span>
        </div>
      </li>`,
    )
    .join('');

  // ---- general ledger continuity ----------------------------------------
  const broken = balances.accounts.filter((a) => a.periods.some((p) => p.break));
  $('#balance-count').textContent = `${balances.accounts.length} accounts · ${
    broken.length ? `${broken.length} break${broken.length > 1 ? 's' : ''}` : 'all carry forward'
  }`;
  $('#balance-grid').innerHTML = balances.accounts
    .map((a) => {
      const rows = a.periods
        .map((p) => {
          const gap = p.closing - p.carriedForward;
          return `<tr class="${p.break ? 'row-fail' : ''}">
            <td class="mono">${new Date(p.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</td>
            <td class="num">${NGN(p.opening)}</td>
            <td class="num">${NGN(p.debits)}</td>
            <td class="num">${NGN(p.credits)}</td>
            <td class="num">${NGN(p.closing)}</td>
            <td class="num">${gap ? `<b class="gap">−${NGN(gap)}</b>` : '<span class="tickmark">carried</span>'}</td>
          </tr>`;
        })
        .join('');
      const brk = a.periods.find((p) => p.break);
      return `<div class="balance-card ${brk ? 'has-break' : ''}">
        <div class="balance-head">
          <span class="balance-name">${a.name}</span>
          <span class="mono balance-code">${a.code}</span>
          ${brk ? `<span class="balance-flag">break of ${NGN(brk.break.amount)}</span>` : '<span class="balance-ok">continuous</span>'}
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th class="mono">Date</th><th class="num">Opening</th><th class="num">Debits</th><th class="num">Credits</th><th class="num">Closing</th><th class="num">Carried forward</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${brk ? `<p class="balance-note">${brk.break.detail}</p>` : ''}
      </div>`;
    })
    .join('');
}

/* ------------------------------- Suspense -------------------------------- */
async function renderSuspense() {
  const { entries } = await api('/api/suspense');
  $('#suspense-count').textContent = `${entries.length} entries · ${NGN(entries.reduce((s, e) => s + e.amount, 0))} held`;
  const oldest = Math.max(...entries.map((e) => e.ageMs), 1);
  $('#suspense-body').innerHTML = entries
    .map(
      (e) => `<tr>
        <td class="mono">${e.reference}</td>
        <td class="mono">${e.account}</td>
        <td>${e.beneficiary.name} · ${e.beneficiary.bank}</td>
        <td class="num">${e.amountFormatted}</td>
        <td class="num">${ago(e.ageMs)}<span class="age-bar" style="width:${Math.round((e.ageMs / oldest) * 70)}px"></span></td>
        <td><span class="badge s-${e.state}">${STATE_LABEL[e.state]}</span></td>
      </tr>`,
    )
    .join('');
}

/* -------------------------------- Loading -------------------------------- */
async function loadQueue({ keepSelection = true } = {}) {
  const params = new URLSearchParams({ state: state.filter });
  if (state.query) params.set('q', state.query);
  const { transactions } = await api(`/api/transactions?${params}`);
  state.transactions = transactions;
  renderQueue();

  if (!keepSelection || !transactions.some((t) => t.reference === state.selected)) {
    if (transactions.length) select(transactions[0].reference);
  }
}

async function select(reference) {
  state.selected = reference;
  document.querySelectorAll('.txn').forEach((el) => el.classList.toggle('is-selected', el.dataset.ref === reference));
  const txn = await api(`/api/transactions/${reference}`);
  if (!txn.error) renderDetail(txn);
}

async function refreshStats() {
  renderKpis(await api('/api/stats'));
}

/* --------------------------------- Wiring -------------------------------- */
$('#txn-list').addEventListener('click', (e) => {
  const row = e.target.closest('.txn');
  if (row) select(row.dataset.ref);
});

$('#filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
  state.filter = chip.dataset.state;
  loadQueue({ keepSelection: false });
});

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  state.query = e.target.value;
  searchTimer = setTimeout(() => loadQueue({ keepSelection: false }), 180);
});

const VIEW_RENDERERS = {
  suspense: renderSuspense,
  sources: async () => {
    await renderSources();
    await renderRecords();
  },
  validation: renderValidation,
};

document.querySelector('.nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-btn');
  if (!btn) return;
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
  document.querySelectorAll('.layout').forEach((l) => (l.hidden = l.dataset.view !== btn.dataset.view));
  VIEW_RENDERERS[btn.dataset.view]?.();
});

$('#record-filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  recordState.category = chip.dataset.category;
  renderRecords();
});

let recordTimer;
$('#record-query').addEventListener('input', (e) => {
  clearTimeout(recordTimer);
  recordState.query = e.target.value;
  recordTimer = setTimeout(renderRecords, 180);
});

// Live feed: the server pushes whenever the reconciliation state changes.
const stream = new EventSource('/api/stream');
stream.addEventListener('stats', (e) => renderKpis(JSON.parse(e.data)));
stream.addEventListener('update', (e) => {
  renderKpis(JSON.parse(e.data).stats);
  loadQueue();
});

(async function init() {
  await refreshStats();
  await loadQueue({ keepSelection: false });
})();
