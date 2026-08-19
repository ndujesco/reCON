'use strict';

/* ReCON dashboard: talks to the reconciliation API and renders the trail. */

const $ = (sel) => document.querySelector(sel);
const api = (path) => fetch(path).then((r) => r.json());

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

document.querySelector('.nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-btn');
  if (!btn) return;
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
  document.querySelectorAll('.layout').forEach((l) => (l.hidden = l.dataset.view !== btn.dataset.view));
  if (btn.dataset.view === 'suspense') renderSuspense();
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
