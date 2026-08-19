# ReCON

**Automated reconciliation and transaction transparency for Wema Bank.**

When a Nigerian interbank transfer fails, the customer is told to wait 24–48 hours, not because the
problem is hard, but because nobody can see *where* the money stopped. The debit is in core banking,
the routing is in the NIBSS gateway, the acknowledgement is in the beneficiary bank's response, and
nothing joins them up.

ReCON joins them up. It tracks every transfer across **six checkpoints**, matches the events each
system produces against a single reference, and computes the transaction's true state, so support
staff and customers both get a straight answer:

> *"Your account was successfully debited and the transfer reached the receiving bank, but the
> receiver has not been credited yet. Reconciliation is in progress."*

At its core, ReCON answers one question: **when something goes wrong with a transaction, where
exactly is the customer's money, and what is being done about it?**

---

## Submission links

| | |
|---|---|
| **Live application** | <https://re-con-inky.vercel.app/> |
| **Live backend API** | <https://re-con-inky.vercel.app/api/health> (all routes under `/api`, listed below) |
| **Recorded demo** | [Watch the walkthrough](https://drive.google.com/file/d/1lHiYdPMB4T6GzCueF8Qe6-CusJ1hZRGL/view?usp=drive_link) |
| **Repository** | <https://github.com/ndujesco/reCON> |
| **Contact** | <opeyemikayode16@gmail.com> |

---

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

- **Exception queue:** every broken or delayed transaction, worst first, with a six-pip progress
  indicator showing how far down the chain each one got.
- **Support view:** the full checkpoint trail with the source event, event ID and response code
  behind every hop; the diagnosis; and the raw normalised evidence log.
- **Customer view:** the same trail in the customer's own words, with no internal system detail.
- **Suspense monitor:** funds that arrived but were never swept to the beneficiary account, aged
  automatically so stuck money surfaces on its own instead of being found weeks later.
- **Live feed:** new transfers originate and in-flight ones advance over server-sent events.

## Running it

Node 18+. No dependencies, no build step.

```bash
npm start          # http://localhost:4317
npm test           # 10 tests covering the reconciliation rules
```

`PORT` is respected, so the same command works on Render, Railway, Fly or any Node host.

## API

| Method | Route | Returns |
|---|---|---|
| `GET` | `/api/health` | service heartbeat |
| `GET` | `/api/stats` | reconciliation health: totals, value at risk, suspense, time-to-locate |
| `GET` | `/api/transactions?state=&q=&limit=` | queue, ranked by priority; `state` accepts `exceptions`, `all` or any state |
| `GET` | `/api/transactions/:reference` | full reconciliation: chain, break point, anomalies, diagnosis, evidence |
| `GET` | `/api/suspense` | suspense ledger, oldest first |
| `GET` | `/api/checkpoints` | the six-checkpoint model |
| `GET` | `/api/stream` | server-sent events; pushes on every state change |
| `POST` | `/api/tick` | advance the simulated event feed by one step |

```bash
curl https://re-con-inky.vercel.app/api/transactions/WEM-20260818-004417 | jq '.diagnosis'
```

## Architecture

```
Event sources          Normalisation        Reconciliation        Surfaces
─────────────          ─────────────        ──────────────        ────────
Core banking    ─┐
NIBSS NIP gw    ─┼──▶  src/store.js   ──▶   src/engine.js   ──▶   Staff dashboard
Beneficiary resp─┤     (one event shape,     (chain, break,        Customer tracker
Suspense ledger ─┘      one reference)        diagnosis)           Suspense monitor
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
src/engine.js          reconciliation, break detection, diagnosis
src/store.js           event sources and the in-memory ledger
public/                dashboard (index.html, app.js, styles.css)
test/engine.test.js    reconciliation rules under test
```

## Demo data

The hackathon build simulates the event feeds so the full range of outcomes is visible at once:
clean settlements, transfers still in flight, stalls at each hop, downstream rejections, auto-reversals
and funds sitting in suspense. The generator is deterministically seeded, so every run tells the same
story. The headline case is **`WEM-20260818-004417`**: ₦250,000 debited, routed, acknowledged by the
beneficiary bank, then parked in a suspense account for 26 hours without the beneficiary ever being
credited. Today that customer is told to wait. ReCON locates it in under a millisecond.

## What ReCON does not claim

ReCON cannot make another bank move faster, and it does not pretend to. It needs no control over
NIBSS or the receiving bank, only visibility into events Wema already generates and already
receives. So the goal is transparency and faster resolution of the part of the chain Wema owns, plus
correctly attributed, evidence-backed escalation for the part it doesn't. That is also the honest
answer to "why is this feasible": the hardest part of the problem is seeing the full trail, and the
data needed to see it already exists inside the bank today.

## Roadmap

**Phase 2: production integration.** Real core banking and NIP log formats in place of simulated
events; automatic escalation into the support queue; retained audit history for compliance and
complaint resolution.

**Phase 3: transparency at scale.** The customer tracker inside the Wema app and the USSD flow;
predictive flagging of transfers that look likely to stick before the customer complains; auto-resolution
of well-understood cases such as known suspense-account sweeps.

**Success metrics.** Time to identify where a transaction is stuck (minutes, not hours); share of
failed transfers reconciled without manual log review; reduction in repeat complaints for the same
transaction.

---

Built for **Wema Bank Hackaholics 7.0**. Questions: <opeyemikayode16@gmail.com>
