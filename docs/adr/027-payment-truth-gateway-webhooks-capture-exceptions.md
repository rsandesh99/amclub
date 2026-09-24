# ADR 027 — Payment truth after checkout: no simulation on production, gateway webhooks settle refunds / transfers / chargebacks, captures with no order, manual refunds under the ADR-014 rules

**Status:** Accepted 2026-09-24. Touches money, the checkout → order path and the payout state machine (§8.4). One payout edge is **added** (`paid → failed`, gateway-reported only); no order transition is added, removed or repurposed. Decides audit findings **M2, M20, M21, M39 (part 2)** and **L1** (`docs/audit/2026-09-24-architecture-security-audit.md`). Builds on ADR 014 (dispute settlement), ADR 023 (no simulated payments on production) and ADR 026 (one release rule, confirmed transfers); keeps their rules. Migration **0078** (not staged).

## Context

The audit found five gaps between what the gateway knows and what our rows say:

- **M2.** ADR 023 closed checkout on production without real Razorpay keys, but everything *after* checkout still ran through the simulation gateway there: `runPayouts`, `processRefund`, the admin release / retry / finish-refund / manual refund, and the reconcile cron (whose mock `findTransfer` answers "no transfer" and so marked real `processing` payouts `failed`). The result was false `paid` payouts and false "refunded" orders, and at cutover a real transfer for an order paid only in simulation. The only safeguard was operator memory.
- **M20.** The webhook consumed only `payment.captured`. Refund outcomes, transfer outcomes and chargebacks never reached our rows, against rule 2 (webhooks are the only payment truth). A failed refund still read "Sent to your original payment method"; a failed or reversed transfer still read `paid`; a chargeback left the payout releasable.
- **M21.** `materialize_order` never looked at `checkout_sessions.expires_at`. A capture hours later still created an order at the frozen price, on a withdrawn quote, with an expired coupon, or in a lapsed pool window. The checkout route resumed an expired session under the same idempotency key, and finalize accepted a cancelled or expired RFQ (`.neq('status','accepted')`), an edge the RFQ machine does not have.
- **M39 (part 2).** A second captured payment on one Razorpay order (the session already materialised) was silently dropped: `materialize_order` returned the existing order, no row recorded the money, reconcile counted it as "recovered", and nobody refunded it.
- **L1.** Admin `manual_refund` never looked at the payout. A refund and a full payout could both go out, the platform funding the difference, outside the ADR-014 planner.

## Decision

1. **No money moves through the simulation gateway on production, and none against a simulated payment (M2).** One pure rule, `moneyMovementBlock(gatewayIsReal, payment)` in `lib/payments/simulation.ts`:
   - `payments_unavailable` when `!paymentsAvailable(isReal, VERCEL_ENV)` (the ADR 023 test);
   - `payment_simulated` when the gateway is real but the payment was simulated (`razorpay_payment_id LIKE 'pay_sim_%'` or `webhook_payload.simulated = true`, which is exactly how the simulate route records it; `isSimulatedPayment`).
   
   It is applied **before anything is written**:
   - `runPayouts` claims nothing (`unavailable`, rows stay `scheduled`); `settleUnconfirmedPayouts` and `reconcileCapturedPayments` do nothing;
   - `processRefund` throws `MoneyPathBlockedError` before the pending row (callers record `refund_failed`; `redriveCancellationRefunds` skips while blocked);
   - the admin release (`/admin/payouts/[id]`), the order-page retry / finish refund / manual refund, and every money-moving dispute resolution answer **503 `payments_unavailable`** or **409 `payment_simulated`** and change nothing;
   - the release rule (`payoutRunBlockers`) holds any payout whose order was paid in simulation (`payment_simulated`) on a real gateway.
   
   `/admin/payouts` marks rows paid for by a simulated payment ("simulated"). Previews, CI and the rigs (mock gateway, no production `VERCEL_ENV`) keep simulating end to end.

2. **The webhook settles refunds, transfers and chargebacks (M20).** HMAC verification over the raw body is unchanged. Each handler (`lib/payments/webhook-events.ts`) is compare-and-set on the status it expects, records its event once (keyed on the gateway id), never creates money movement itself, and answers 200 for ids that are not ours:
   - `refund.processed` completes a `pending` refund row (found by refund id, else by our receipt `rfnd_<order id>`) → `processed` + `refund_confirmed`. `refund.failed` moves `pending | processed` → **`failed`** (new refund status, shared `REFUND_STATUSES`) with `refund_failed` (`source: 'gateway'`) and an audit row. `processRefund` never reads a failed row as done, and never re-sends one blind (`refund_failed_at_gateway`): ops re-sends. The gateway's own `failed` refund status is never recorded as processed.
   - `transfer.processed` settles a `processing` payout (an unconfirmed transfer, ADR 026) as `paid` with that transfer; a paid payout is left alone. `transfer.failed` / a full `transfer.reversed` moves `processing | paid` → `failed` (the money is back with the platform) with a `payout_failed` event carrying `razorpay_transfer_id` and `source: 'gateway'`. That transfer is **dead** from then on (`deadTransferIds`): `findTransfer` skips it (and any gateway transfer in status failed / reversed), so a retry sends a new transfer rather than "recovering" the dead one. A partial reversal is recorded for ops (`payout_partially_reversed`) and never reopens the payout. **`paid → failed` is added to `PAYOUT_TRANSITIONS`** for this, and only this, path.
   - `payment.dispute.created / .lost / .won / .closed` record `chargeback_opened / _lost / _won / _closed` once per dispute id on the order (every child of a bundle), hold a `scheduled` payout (`chargeback`), and write an audit row with the payout's status. While a chargeback is open (opened, not yet lost / won / closed) the release rule refuses every payout for the order (`chargeback_open`). After the gateway decides, the held payout waits for an explicit ops release.
   - Ops enables these events on the Razorpay webhook (dashboard) at the cutover.

3. **A capture on an expired or already-paid session creates no order and is refunded in full (M21, M39).** Migration 0078:
   - `capture_exceptions`: one row per captured payment that created no order (`reason` `session_expired | duplicate_capture`, status `refund_pending → refunding → refunded | refund_failed`, shared `CAPTURE_EXCEPTION_*`), with the refund receipt `refund_key` (`rfcap_<32 hex>`, within Razorpay's 40 characters). Service-role only (no client grant, RLS on, no policy).
   - `capture_payment(...)`: the ONE capture entry point (webhook, reconcile cron, simulate route). SECURITY DEFINER, `search_path = public, pg_temp`, EXECUTE for `service_role` only. It returns the recorded answer for a replay; locks the session row (`FOR UPDATE`), then re-checks under the lock so a racing replay of the same payment is never mistaken for a duplicate; classifies; and calls `materialize_order` unchanged for a live session. It does **not** redefine `materialize_order`, so the staged Mart 0022 version keeps working.
   - A session is expired when `now() > expires_at + 15 minutes` (`CAPTURE_GRACE_SECONDS`), or it is closed without an order. The session goes `expired`.
   - A second capture on a paid session writes `duplicate_capture` on that order's timeline (hidden from the parties).
   
   **Refund, not an ops queue.** The platform holds money it has no order for, so returning it is always right, and a queue would leave a buyer charged for nothing until someone looks. The refund is made at once in the capture path and re-driven by the hourly auto-cancel cron (`sweepCaptureExceptions`, idle ≥ 10 minutes, at most 5 attempts, then the audit log carries it for ops). It is the gateway's ordinary refund call, made safe the way `processRefund` is: the row is claimed by compare-and-set, the gateway is asked for our receipt before a new refund is created, and a failed refund is never taken as done. The buyer is told once (`notify.capture_refund.*`). Simulated captures are refunded only by the simulation gateway.
   - Only newly created orders count as "recovered" in reconcile; a known exception is skipped.

4. **Expired sessions are never resumed (M21).** The checkout route answers **409 `checkout_expired`** for an unpaid session that has expired or has under a minute left (the same idempotency key, or a live session on the same quote); the web clients drop the key so the next tap starts a fresh session at today's price (`checkout.err_checkout_expired`). Every checkout response carries `checkoutTimeoutSeconds`, which the client passes as the Razorpay Checkout `timeout`, so the sheet closes when the session does. The pool checkout refuses a lapsed member session the same way.

5. **Finalize claims only a live RFQ (M21).** The quote order's RFQ claim is guarded with `RFQ_LIVE_STATUSES` (`open | quoted`). A paid order on an RFQ that closed while the checkout was open is recorded once (`rfq_not_live_at_payment`, event + audit) and stands as an ordinary `placed` order: the provider may accept it, or the 24-hour auto-cancel refunds it in full. A duplicate on an accepted RFQ is still ADR-014 §7.

6. **A manual refund follows the ADR-014 rules (L1).** Shared `planManualRefund` plans it as a `refund_partial` (or `refund_full`) resolution of that amount:
   - a `processing` payout → **409 `payout_in_flight`**;
   - a `paid` payout → **409 `provider_already_paid`**, unless the body carries `platformAbsorbs: true`. That is ADR-014 §2's interim path (refund from the platform's own balance, payout kept). It is now an explicit, audited confirmation on the admin order page, never a default;
   - an existing refund → 409 `refund_exists` (unchanged);
   - otherwise the payout is rewritten, **before** the refund, in the same audited action: cut to the provider's share (`disputeSettlementPaise`) and **held**, or voided (`failed`, amount 0, as a `refund_full` resolution does). A `failed` payout keeps its status, since `failed → held` is not an edge.
   
   `schedulePayout` applies the same share when a refund already exists at completion (held, reason `refund_exists`; no payout row after a full refund).

7. **The release rule refuses a payout beside a refund unless the planner allows it (L1).** Inside `payoutRunBlockers` (so the cron, the admin release, dispute settlement and the retry all inherit it): a plainly `completed` order with a refund row pays out at most the provider's share of what the buyer kept (shared `payoutAllowedWithRefund`), else `refund_exists`. A `resolved_release` / `resolved_partial` order's payout was planned by `planDisputeSettlement`, which saw the refund row, so it passes. The rule also holds `nothing_to_pay` (amount ≤ 0), `payment_simulated` and `chargeback_open`.

## Consequences

- A production deployment without real keys can neither take money (ADR 023) nor record money it did not move. Refunds stay owed and payouts stay scheduled or held, visibly, until the keys are fixed.
- **Cutover step (ADR 003 checklist, added):** before live keys, void the simulate era. List payouts whose order payment is simulated (the "simulated" tag in `/admin/payouts`). Set them `failed` with amount 0 and a `payout_voided` event, and mark those orders for no further action. With real keys the release rule holds any that remain (`payment_simulated`).
- Refund, transfer and chargeback state now follows Razorpay. New ops markers (hidden from the parties on web and mobile): `refund_confirmed`, `duplicate_capture`, `rfq_not_live_at_payment`, `payout_partially_reversed`, `chargeback_opened / _lost / _won / _closed`. Provider-visible: `payout_failed` with `reason: transfer_failed | transfer_reversed`.
- New error codes:
  - 503 `payments_unavailable` and 409 `payment_simulated` on the admin money actions, the payout release and dispute resolve;
  - 409 `checkout_expired` on checkout, simulate and the pool checkout;
  - `manual_refund` can now answer 409 `provider_already_paid` / `payout_in_flight`.
  
  All are translated: `admin_ops.money_err_*` in en / hi, `checkout.err_checkout_expired` in en / hi plus te / ta drafts.
- New hold reasons: `refund_exists`, `manual_refund`, `nothing_to_pay`, `payment_simulated`, `chargeback`, `chargeback_open`.
- **Money-rig criteria** (DC12 in `verify-money-loop`, plus the two webhook kill-tests and `verify-authz`):
  - refund.processed heals a pending row once, and refund.failed marks it failed once (replays change nothing);
  - transfer.failed takes a paid payout to failed once; the dead transfer never settles it again, and the retry sends a new transfer; transfer.processed settles a processing payout once;
  - a chargeback holds a scheduled payout, is recorded once, and blocks the release while open; `lost` is recorded once;
  - a capture past expiry plus grace creates no order and no payment, is one refunded `session_expired` exception, sends one buyer notice, and its replay changes nothing;
  - a second capture on a paid session creates no second order or payment, is one refunded `duplicate_capture` exception, and is not counted as recovered in reconcile;
  - a manual refund cuts and holds an unpaid payout, refuses a paid one (`provider_already_paid`) and an in-flight one (`payout_in_flight`);
  - a payout run refuses a full payout beside a refund (`refund_exists`) and releases the planner's share;
  - the same idempotency key on an expired session is 409 `checkout_expired`, and a simulated capture on it creates no order;
  - `capture_exceptions` and `capture_payment` are not reachable with a client key.
- **Follow-ups (not decided here):**
  - an admin action to re-send a gateway-failed refund (today: the Razorpay dashboard);
  - a real `cancelled` payout status instead of `failed` / 0;
  - the order-refund receipt `rfnd_<uuid>` is 41 characters, one over Razorpay's documented receipt limit: check it in the recorded test-mode run (H7).
- **Rollback:**
  - Revert the code. The capture path then calls `materialize_order` directly again: expired and duplicate captures are again silently honoured or dropped.
  - Then run `DROP FUNCTION capture_payment(text, text, bigint, text, jsonb, integer); DROP TABLE capture_exceptions;`, after exporting any rows still owed a refund.
  - Refund rows in `failed` stay readable as "not processed".
  - `paid → failed` payouts stay failed.
