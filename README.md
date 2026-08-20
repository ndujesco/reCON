# ReCON — Automated Reconciliation & Transaction Transparency

## Team Members
- **Opeyemi Kayode** — Team Lead
- Umeozor Chukwuzubelu Benedict
- Ndujekwu Ugochukwu Peter
- Ayomide Rasaq

---

## 🚀 Live Demo

*   **Live Application:** <https://re-con-inky.vercel.app/>
*   **Backend API:** <https://re-con-inky.vercel.app/api/health> — all routes under `/api`, listed below
*   **Recorded Demo:** <https://drive.google.com/drive/folders/1gec3LqSLzwYB-R94BVmGS4D0OEUyE5zl?usp=sharing>

---

## 🎯 The Problem

> **How might we** show a customer and the staff serving them exactly where a delayed or failed
> interbank transfer has stopped, and what is being done about it, instead of asking them to wait
> 24 to 48 hours for an answer nobody can currently give?

Digital payments are now most of how Nigeria moves money: NIBSS processed almost **11 billion instant
payment transactions in 2024**, up from about 5 billion in 2022. At that volume, even a small failure
rate is an enormous number of people. Between October 2023 and September 2024 the CBN handled
**19,988 complaints** against financial institutions and helped customers recover about **₦7.05 billion**.

The real problem is not that transfers occasionally fail. It is that when one does, **nobody can see
where it stopped.** The debit sits in core banking. The routing sits in the NIBSS gateway. The
acknowledgement sits in the beneficiary bank's response. The money may be sitting in a suspense
account. Each system holds one true fact, and nothing joins them up, so the honest answer the bank can
give today is "please wait 24 to 48 hours."

What the customer actually wants to know is simple: *Did the money leave my bank? Did the receiving
bank get it? Why has the receiver not been credited? Is anyone working on it?*

## ✨ Our Solution

**ReCON** is an automated reconciliation and transaction transparency layer that sits between Wema's
own core banking records and the NIBSS NIP data, and joins them up. It does two things at once.

**Down one transaction.** Every transfer is tracked across **six checkpoints**, from the customer's
debit to the beneficiary's credit. ReCON matches the events each system produces against a single
reference and derives the transaction's true state — it never trusts a stored status field, because a
transfer stuck inside someone else's system has no status to read, only a missing event. The break
point is the first checkpoint that should have fired and didn't, which turns an unexplained "pending"
into a specific, evidence-backed statement about where the money is:

> *"Your account was successfully debited and the transfer reached the receiving bank, but the
> receiver has not been credited yet. Reconciliation is in progress."*

**Across the whole book.** ReCON matches Wema's core banking postings against the **NIBSS NIP
settlement report**, line by line, and reports everything that does not agree: the same instruction
booked twice, records that exist on one side and not the other, amounts the two sides disagree on, and
general ledger balances that did not carry forward. Every finding names the records that prove it and
what to do next.

Both data feeds are **pulled automatically** from systems the bank already runs, so there is no login,
no import screen and no spreadsheet to export. This build deliberately covers **one rail, the NIP
instant payment rail**, reconciled properly, rather than four rails badly.

---

## 🛠️ Tech Stack

*   **Frontend:** Vanilla HTML, CSS and JavaScript, with server-sent events for the live feed. No framework, no build step.
*   **Backend:** Node.js using the built-in `http` module. **Zero runtime dependencies.**
*   **Database:** In-memory, deterministically seeded, so every run reconciles the same book. The store is one module (`src/store.js`); swapping it for real feeds changes nothing above it.
*   **Deployment:** Vercel (frontend and API together). `PORT` is respected, so the same command runs on Render, Railway, Fly or any Node host.
*   **AI/APIs:** None. The reconciliation is deterministic by design — a bank needs an answer it can audit and reproduce, not one it has to trust.
*   **Testing:** `node:test`, 32 tests.

---

## ⚙️ How to Set Up and Run Locally

Node 18 or later. There are no dependencies to install and nothing to configure.

1.  Clone the repository:
    ```bash
    git clone https://github.com/Wema-Hackaholics-Hackathon/wema-hackaholics7-0-hackathon-yabatech-project-recon.git
    ```
2.  Navigate to the project directory:
    ```bash
    cd wema-hackaholics7-0-hackathon-yabatech-project-recon
    ```
3.  Start it:
    ```bash
    npm start          # http://localhost:4317
    ```
4.  Run the tests:
    ```bash
    npm test           # 32 tests covering reconciliation, matching, validation and the query engine
    ```

No `.env` file is needed. `PORT` is the only variable read, and it defaults to `4317`.

---

# Technical detail

Everything below is the detail behind the summary above: the model, the checks, the API and the
architecture.

## The six checkpoints

Every transfer is modelled as a chain. A transaction is not a status field; it is a sequence of
events, each proven by the system that produced it.

| # | Checkpoint | Proven by | Owned by | SLA |
|---|---|---|---|---|
| 1 | Initiated | Wema Core Banking | Wema | 1 min |
| 2 | Debited | Wema Core Banking | Wema | 2 min |
| 3 | Sent to NIBSS | NIBSS NIP Gateway | Wema | 5 min |
| 4 | Processed by NIBSS | NIBSS NIP Gateway | NIBSS | 15 min |
| 5 | Received by beneficiary bank | Beneficiary Bank Response | Beneficiary bank | 30 min |
| 6 | Credited to beneficiary | Beneficiary Bank Response | Beneficiary bank | 60 min |

**The break point is the first checkpoint that should have fired and didn't.** That single rule turns
an unexplained "pending" into a specific, actionable statement about where the money is.

## Where the data comes from

Both feeds are **pulled on a schedule** from systems Wema already runs. Nothing is uploaded, nothing is
exported to a spreadsheet, and there is no separate portal to sign into: the data is already inside the
bank, it has simply never been put side by side.

| Feed | Kind | Carries | Cadence |
|---|---|---|---|
| Wema Core Banking | Internal | Postings, charges and general ledger movement | every 60 seconds |
| NIBSS NIP | External rail | Gateway traffic and the NIP net settlement report | every settlement session |

**Scope: the NIP rail only.** ATM, remittance, cheque clearing and card settlement are deliberately out
of scope for this phase. The engine only ever sees normalised records, so adding one of them later is a
new feed, not a new product.

### Structured and unstructured records

Reconciliation works on structured records: a reference, an amount, an account, a value date. Real bank
data is not always that tidy, and some postings arrive carrying nothing but free-text narration.

ReCON never quietly guesses at those. It flags them, then makes a second pass matching on **amount,
beneficiary account and value date**, and *proposes* both the reference the record should have carried
and what kind of transaction it is. A proposal is scored and held for confirmation, never booked — a
probable match treated as a certain one is worse than no match at all.

### Classification

One ₦250,000 transfer produces four separate postings: the transfer, the NIP fee, the VAT on that fee,
and the ₦50 electronic money transfer levy. Reconcile them as one undifferentiated pile and a fee break
reads as a missing transfer, so every record is classified *before* it is matched.

`CUSTOMER_TRANSFER` · `FEE` · `TAX` · `REVERSAL` · `SETTLEMENT` · `UNCLASSIFIED`

A posting code classifies exactly. Failing that, the narration is read for a recognisable pattern, at
lower confidence. Failing that, the record is held as `UNCLASSIFIED` rather than guessed at.

### Querying it

The record explorer takes free text plus `field:value` terms, so the desk can ask a real question
without anyone writing SQL for them:

```
category:TAX bank:gtbank        every levy and VAT posting against GTBank
unstructured:true               the exact records that need a human to label them
source:CORE_BANKING min:100000  large postings from the bank's own books
```

## Data validation

Six checks run over both pools. Every finding names the records it is drawn from, states how much is
exposed, and says what to do next; they are ranked worst first.

| Check | What it catches |
|---|---|
| `DUPLICATE_POSTING` | The same instruction booked more than once, so the customer was charged twice |
| `UNMATCHED_IN_NIP` | In Wema's books, absent from the settlement report: debited but never settled |
| `UNMATCHED_IN_CORE` | On the settlement report, never posted in Wema's books: money moved unbooked |
| `AMOUNT_MISMATCH` | Both sides carry the reference, the figures disagree |
| `BALANCE_BREAK` | A closing balance that did not carry forward into the next day's opening |
| `UNSTRUCTURED` | Records with no reference to match on, held for labelling |

A transfer instructed two minutes ago is *not* missing from the settlement report, it is younger than
the report. Only postings older than the settlement window count as one-sided, so the exception list
does not fill up with transfers that are simply still in flight.

**The two ₦250,000s.** The demo data makes the same amount surface twice from two independent
directions: once as an unexplained gap between a suspense account's closing and opening balance, and
once as a real customer's transfer, debited and acknowledged but never credited. They are the same
money, found by two different checks. That is the point of reconciling the book and the transaction
together rather than separately.

## What the engine actually does

`src/engine.js` takes the raw event stream for one reference and derives everything else. It never
trusts a stored status: a transaction stuck inside someone else's system has no status to read,
only a missing event.

- **Chain reconstruction:** replays events onto the six checkpoints; the last event per checkpoint
  wins, so retries and late callbacks supersede correctly.
- **Break detection:** locates the first checkpoint with no confirming event, or the first explicit
  downstream rejection.
- **SLA ageing:** measures how long the transaction has sat at the stalled hop against that hop's
  own SLA, so a 40-second-old transfer is *in flight* and a 26-hour-old one is *broken*.
- **Integrity checks:** amount mismatches between hops, funds parked in suspense and never swept,
  and debits with no matching credit and no reversal booked.
- **Diagnosis:** maps the break point to a likely cause, the institution that owns it, a recommended
  action for support, and a plain-language message for the customer.
- **Prioritisation:** ranks the exception queue by money at risk, weighted by how long it has been
  stuck and how severe the break is.

Resulting states: `RECONCILED`, `IN_FLIGHT`, `DELAYED`, `BROKEN`, `REVERSED`.

## What you see in the app

Four views, no login on any of them.

**Reconciliation**
- **Exception queue:** every broken or delayed transaction, worst first, with a six-pip progress
  indicator showing how far down the chain each one got.
- **Support view:** the full checkpoint trail with the source event, event ID and response code
  behind every hop; the diagnosis; and the raw normalised evidence log.
- **Customer view:** the same trail in the customer's own words, with no internal system detail.

**Data sources**
- The two connected feeds, with sync state, and the scope this build covers.
- Structured versus free-text split, and what every record was classified as.
- The record explorer and its query bar.

**Validation**
- Settlement match: matched on reference, matched on amount/account/date, still inside the settlement
  window, one-sided each way, and amounts that disagree.
- The proposed matches for referenceless records, with confidence and the label being suggested.
- Ranked findings, each citing its evidence.
- General ledger continuity, seven days per account, with any break quantified.

**Suspense monitor**
- Funds that arrived but were never swept to the beneficiary account, aged automatically so stuck
  money surfaces on its own instead of being found weeks later.

Throughout: a **live feed** over server-sent events, where new transfers originate and in-flight ones
advance.

## API

| Method | Route | Returns |
|---|---|---|
| `GET` | `/api/health` | service heartbeat |
| `GET` | `/api/stats` | reconciliation health: totals, value at risk, suspense, time-to-locate |
| `GET` | `/api/transactions?state=&q=&limit=` | queue, ranked by priority; `state` accepts `exceptions`, `all` or any state |
| `GET` | `/api/transactions/:reference` | full reconciliation: chain, break point, anomalies, diagnosis, evidence |
| `GET` | `/api/suspense` | suspense ledger, oldest first |
| `GET` | `/api/sources` | connected feeds, sync state, structured/unstructured split, scope |
| `GET` | `/api/validation` | ranked findings across both pools, with evidence and next actions |
| `GET` | `/api/settlement` | core banking matched against the NIP settlement report, line by line |
| `GET` | `/api/balances` | seven days of general ledger movement per account, and any break |
| `GET` | `/api/records?q=&category=&structured=` | the record explorer; `q` takes free text plus `field:value` terms |
| `GET` | `/api/categories` | the classification model |
| `GET` | `/api/checkpoints` | the six-checkpoint model |
| `GET` | `/api/stream` | server-sent events; pushes on every state change |
| `POST` | `/api/tick` | advance the simulated event feed by one step |

```bash
curl https://re-con-inky.vercel.app/api/transactions/WEM-20260818-004417 | jq '.diagnosis'
```

## Architecture

```
Pulled feeds           Normalisation        Reconciliation             Surfaces
────────────           ─────────────        ──────────────             ────────
Core banking    ─┐                     ┌─▶ src/engine.js     ──┐       Exception queue
NIBSS NIP gw    ─┼──▶  src/store.js  ──┤   (chain, break,      ├──▶    Support / customer view
NIP settlement  ─┤     src/ledger.js    │    diagnosis)        │       Data sources
Beneficiary resp─┤     (one shape,      │                      │       Validation
Suspense ledger ─┘      one reference)  └─▶ src/validation.js ─┘       Suspense monitor
                       src/classify.js      (settlement match,
                       (what kind of         duplicates, GL
                        record is this)      continuity)
```

The engine only ever sees normalised events. That is the load-bearing design decision: swapping the
simulated feed in `src/store.js` for real core banking, NIP gateway and callback data changes nothing
above it: the engine, the API and the dashboard stay exactly as they are.

| | |
|---|---|
| Backend | Node.js (built-in `http`), zero dependencies |
| Frontend | Vanilla HTML/CSS/JS, server-sent events |
| Data | In-memory, deterministically seeded |
| Tests | `node:test` |

```
server.js              HTTP server, API routes, SSE stream
src/checkpoints.js     the six-checkpoint model
src/engine.js          per-transaction reconciliation, break detection, diagnosis
src/classify.js        transaction categories, NIP fee bands, VAT and levy
src/ledger.js          the two data pools and the GL balance series
src/validation.js      settlement matching and the whole-book checks
src/store.js           event sources, the in-memory ledger and the query engine
public/                dashboard (index.html, app.js, styles.css)
test/engine.test.js    reconciliation rules under test
test/validation.test.js  classification, matching, validation and querying under test
```

## Demo data

The hackathon build simulates the event feeds so the full range of outcomes is visible at once:
clean settlements, transfers still in flight, stalls at each hop, downstream rejections, auto-reversals
and funds sitting in suspense. The generator is deterministically seeded, so every run tells the same
story. The headline case is **`WEM-20260818-004417`**: ₦250,000 debited, routed, acknowledged by the
beneficiary bank, then parked in a suspense account for 26 hours without the beneficiary ever being
credited. Today that customer is told to wait. ReCON locates it in under a millisecond.

The ingested pools carry the discrepancy classes a reconciliation officer actually chases: a posting
booked twice, a settlement line with no posting behind it, an amount the two sides disagree on, records
that arrived with free-text narration and no reference, and a suspense account whose closing balance
does not carry forward. All of it is seeded deterministically, so the same book is reconciled on every
run and the figures in the demo are reproducible.

## What ReCON does not claim

ReCON cannot make another bank move faster, and it does not pretend to. It needs no control over
NIBSS or the receiving bank, only visibility into events Wema already generates and already
receives. So the goal is transparency and faster resolution of the part of the chain Wema owns, plus
correctly attributed, evidence-backed escalation for the part it doesn't. That is also the honest
answer to "why is this feasible": the hardest part of the problem is seeing the full trail, and the
data needed to see it already exists inside the bank today.

## Roadmap

**Phase 2: production integration.** Real core banking and NIP log formats in place of simulated
feeds; confirmation workflow for the proposed matches, so a labelled record stays labelled on the next
run; automatic escalation into the support queue; retained audit history for compliance and complaint
resolution.

**Phase 3: transparency at scale.** The customer tracker inside the Wema app and the USSD flow;
predictive flagging of transfers that look likely to stick before the customer complains; auto-resolution
of well-understood cases such as known suspense-account sweeps.

**Success metrics.** Time to identify where a transaction is stuck (minutes, not hours); share of
failed transfers reconciled without manual log review; reduction in repeat complaints for the same
transaction.

---

Built for **Wema Bank Hackaholics 7.0**. Questions: <opeyemikayode16@gmail.com>
