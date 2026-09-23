# ADR 014 — Dispute settlement safety: never pay twice, never refund silently

**Status:** Accepted 2026-09-23. Touches money and the order state machine (§8.4).
Decides hardening items **H3** and **H4** (merged in PR #21), **H2** (§6) and **H6**
(§7); the founder delegated H2 and H6. With all four decided, this ADR no longer
blocks ADR-011 (first-order guarantee). Numbering: 011–013 are reserved by
`BUILD_PROMPTS.md` for S3.3, S4.1 and S4.3.

## Context

A code read on 2026-09-23 found two defects in the dispute → settlement → refund path.
Both are live code paths today; both would move or misreport real money after the
Razorpay cutover; and S3.3 builds directly on this path.

**H3 — a dispute after the payout is paid paid the provider twice.**
`DISPUTABLE_STATUSES` includes `completed`, and `completed → disputed` has no time
limit. `raise_dispute` holds only `scheduled` payouts, so a payout the founder already
released stays `paid`. `resolveDispute` then upserted the payout
(`onConflict: 'order_id'`) with `status: 'scheduled'`, overwriting `paid`
(`PAYOUT_TRANSITIONS.paid` is `[]`). `runPayouts` picks up `scheduled` rows and
`createTransfer` carries no idempotency key, so the provider received a second
transfer. `refund_full` rewrote a `paid` payout to `failed` with amount 0, erasing
the record of a transfer that happened. Separately, step 1 of `resolveDispute`
(`orders.update … .eq('status','disputed')`) never checked how many rows it changed,
and a crash after it left the order `resolved_*` with the dispute `open` forever
(every retry returned 409).

**H4 — an earlier refund made a later one a silent no-op.** `processRefund` keeps one
refund row per payment. When a processed row already exists (a cancellation or an
admin `manual_refund`), it returns **that row's** amount and moves nothing. A dispute
resolved afterwards was recorded as refunded, and a second manual refund logged a
`manual_refund` event, with no money moving in either case.

## Decision

### 1. One planner decides before anything is written

`packages/shared/src/dispute-settlement.ts`:

- `disputeSettlementPaise` — the Phase 7 settlement formula, extracted **unchanged**
  (a test pins it against the old inline expression over a table of totals, earnings,
  resolutions and amounts).
- `planDisputeSettlement({ …, payout, refund, resuming })` — given what already
  happened to the order's payout row and refund row, returns either a plan
  (`payoutStep: none | schedule | void | keep`, `refund: boolean`) or a conflict. Pure
  and unit-tested; `resolveDispute` reads the rows, asks the plan, and only then writes.

### 2. Money that has left is never re-sent or rewritten (H3)

- A resolution may rewrite only a payout no money has left for:
  `DISPUTE_SETTLEABLE_PAYOUT_STATUSES = scheduled | held | failed`. The write is a
  conditional `update … in(status, settleable)` (or an insert when there is no row),
  checked for affected rows. The upsert is gone.
- A `paid` payout whose amount equals the settlement is **kept**: nothing moves (for
  example `release` after the founder already released the payout).
- A `paid` payout at any other amount → **409 `provider_already_paid`**. There is no
  clawback path in this ADR. Interim path for the founder: resolve as **release** (no
  money moves), or refund the buyer from the order page first (`manual_refund`, which
  the platform absorbs) and then resolve as release. A clawback (Razorpay Route
  transfer reversal) is its own decision: a new ADR plus a recorded test-mode run
  (the S3.3 prompt's H7).
- A `processing` payout (transfer in flight) → **409 `payout_in_flight`**.

### 3. One refund row per order stays, and every caller reads back (H4)

- Any existing refund row refuses a refunding resolution (**409 `refund_exists`**,
  with the existing amount). `release` is still allowed; it refunds nothing.
- `manual_refund` refuses when a refund row exists (409 `refund_exists`), when the
  amount exceeds the order total (422 `refund_over_total`), and when there is no
  captured payment (409 `no_payment`).
- Both callers compare the amount `processRefund` reports with the amount they asked
  for. A mismatch → **409 `refund_mismatch`**, and nothing is recorded as refunded.
  In a dispute, the dispute stays open.
- A refunding resolution with no payment row → 409 `no_payment`, before anything is
  written.
- Why not several refund rows per order: that changes the refund engine, reconcile,
  invoices and the buyer refund display. Revisit only if ops needs it.

### 4. The claim is atomic; an interrupted attempt can be finished

- The claim is the conditional `disputed → resolved_*` update, checked for affected
  rows. Exactly one caller wins; a loser gets **409 `resolution_in_progress`**.
- Right after claiming, the intended resolution and refund amount are recorded on the
  still-open dispute.
- A later call that finds the order already in **this** resolution's status with the
  dispute open finishes the attempt, but only:
  - with the same resolution and the same recorded amount (otherwise
    **409 `resolution_conflict`**);
  - once the claim is older than 10 minutes, well past any function timeout;
  - after winning a compare-and-set on `orders.updated_at`, so two resumers cannot
    both move money.
- The plan then treats the attempt's own rows as expected: a payout paid at the
  settlement is kept, and a refund row at the recorded amount is completed.

### 5. The console says what happened

The 409s carry a stable code plus the paise amounts. The dispute console and the admin
order page translate them (`admin_ops.money_err_*`, en and hi), and each message tells
the founder the next step.

### 6. Which orders can be disputed, and for how long (H2)

- **Before completion: every status after the provider accepts.** §3.7 has always
  said "any-pre-completed → disputed", but `ORDER_TRANSITIONS` lacked the edges
  from `accepted` and `requirements_submitted` (both listed in
  `DISPUTABLE_STATUSES`, so the server refused them and the UI hid the button) and
  from `revision_requested` (in neither list). A buyer whose provider accepted and
  then never started, or never came back after a revision request, had no exit. The
  three edges are **added**; no transition is repurposed. `placed` stays
  non-disputable: the buyer cancels it with a full refund instead. A shared test
  pins that every `DISPUTABLE_STATUSES` entry has a `→ disputed` edge, and that no
  other status does.
- **After completion: inside a window.** `completed → disputed` existed with no
  limit. It is now accepted only until `completed_at + dispute_window_days`
  (registered `agent_settings` key, default **7**, 1–90, edited at `/admin/agents`).
  A completed order with no `completed_at` is treated as closed. The rule is one
  shared function (`canRaiseDispute`, `dispute-window.ts`); `applyTransition`
  enforces it (409 `dispute_window_closed` with `endsAt`). The window follows the
  current setting: it is computed on read, not frozen at completion.
- **The buyer sees the clock.** The order page (web and mobile) shows "You can
  report a problem with this order until …" on a completed order, and hides the
  button once the window closes. The deadline comes from the server
  (`ServicesOrderExtras.disputeWindowEndsAt`, `GET /api/v1/orders/[id]`
  `.disputeWindowEndsAt`); clients never compute it.
- **Reviews do not end dispute rights.** Nothing in the code moves an order to
  `reviewed`: posting a review leaves the order `completed`, so the window alone
  decides.
- Goods orders are unaffected: they never use `raise_dispute`; their returns follow
  the Mart category return window.

### 7. A duplicate paid order on one RFQ is cancelled and refunded at once (H6)

Two checkouts can still race past the checkout-route guard (P0-5), so a second
paid order can materialise on an RFQ that is already accepted. Until now it was
flagged for ops and stayed `placed`. The provider could still accept it, the buyer
waited for a manual refund, and if nobody acted, the 24-hour cron cancelled it as
`auto_cancelled` ("the provider never accepted"), which is not what happened.

- **A new state, `cancelled_duplicate`.** It is an extension; nothing is
  repurposed. Edges: `placed → cancelled_duplicate` and
  `cancelled_duplicate → refunded`, and nothing else. It is never disputable and
  never releases a payout. `auto_cancelled` and `cancelled_by_buyer` keep their
  meanings.
- **Settled in the same pass that detects it.** `finalizeQuoteAcceptance`:
  1. Records the duplicate once (event plus audit).
  2. Moves the order `placed → cancelled_duplicate`, guarded on `placed`.
  3. Refunds through `processRefund`, computed from `placed` (100 %), and reads the
     amount back (H4).
  4. Moves the order `→ refunded`.

  Every step is guarded on the state it expects, so a replay finishes an
  interrupted pass. The buyer is told the order was cancelled and refunded in
  full. The provider is never notified about the duplicate.
- **What still goes to ops:** the provider acted first (the order is no longer
  `placed`), the refund engine reports a different amount, or the gateway fails.
  These leave an audit row (`duplicate_rfq_refund_mismatch` /
  `duplicate_rfq_refund_failed`) and the old "our team will refund" notice.
- **No migration:** `orders.status` has no check constraint. The support agent's
  replies and labels cover the new status (en / hi / te / ta), and the web and
  mobile order pages label it (en, hi).

## Consequences

- No second transfer and no silent refund no-op. An interrupted resolve can be
  finished instead of being stuck.
- A dispute on an already-paid order can no longer refund the buyer through the
  resolution itself. The founder uses a manual refund plus release, and the platform
  bears that cost until a clawback ADR exists.
- An interrupted resolve shows as an open dispute whose order is `resolved_*` for up
  to 10 minutes before it can be finished.
- Unchanged, logged in FOLLOWUPS:
  - A voided payout is still represented as `failed` with amount 0; `held → failed`
    is not in `PAYOUT_TRANSITIONS`, so a real `cancelled` payout state is a follow-up.
  - `processRefund` can still race two callers completing the same pending row.
  - `createTransfer` still has no gateway-side idempotency key.

## Verification

- `pnpm --filter @amclub/shared test`: 721 tests, 154 of them new
  (`dispute-settlement.test.ts`), including a grid showing no plan ever writes to a
  `paid` or `processing` payout.
- Web typecheck, `next lint` and `mart:static` pass.
- `verify-phase7.ts` gains criteria **3b** (dispute on an already-paid order: partial
  refused, release moves nothing, same transfer id, no reschedule) and **3c** (earlier
  refund: second manual refund and refunding resolution refused, release closes it).
  **Not yet run.** It needs the disposable-DB CI harness (S3.3 prompt, H1) or a test
  project, never production.

**H2 (§6):** shared tests (`dispute-window.test.ts`: edges, window boundaries,
fail-safe, setting bounds) plus `verify-phase7.ts` criteria **3d** (dispute from
`requirements_submitted` accepted) and **3e** (deadline exposed; a dispute past the
window is refused). The rig criteria need a test database.

**H6 (§7):** shared `order-duplicate.test.ts` (edges, not disputable, no payout,
full refund from `placed`) plus `verify-rfq.ts` criterion **4b** (a duplicate paid
session on the accepted RFQ ends `refunded` with one full refund row; the winner
stands). The rig needs a test database.

## Rollback

Revert the commit. There is no migration and no data change; the previous behaviour
returns, including both defects.
