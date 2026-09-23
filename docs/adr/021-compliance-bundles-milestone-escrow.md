# ADR 021 — Compliance bundles: one payment, one ordinary order per milestone

**Status:** Accepted 2026-09-23 for the **dark build**. It follows the approved PRD Experience v3, E12c (N18, "ADR-XC"). It changes money, so it goes through §8.4 and adds money-loop criteria. It ships behind `agent_settings.bundles_enabled` (default off). **Enabling it waits on counsel and Razorpay**, who must confirm that holding buyer money for the plan length is permitted (RBI PA guidelines, Route hold limits). It depends on ADR 018 (sessions and orders are server-written only).

## Context

Vakilsearch Elite (VS-01) and IndiaFilings sell a registration plus months of filings. That is the strongest 90-day repeat lever in the survey. Today every order is one piece of work paid once, so a plan means N separate checkouts.

The rules this must keep:
- **The payout rule is untouched.** A provider is paid only from `completed` (or a dispute release).
- **One money path.** `computeOrderAmounts` via `packageCharge`, frozen on the session. **The webhook is the only truth**, and a replay never creates twice.
- **No new order states.** Refunds stay the existing engine, with ADR-014's one refund row per order.
- **v1: at most ~3 months prepaid.** Renewal is a new purchase.

## Decision

1. **A bundle is a package with milestones.**
   - `bundle_milestones` (migration 0067): `seq`, `label_i18n`, `due_offset_days` ≤ 92, `share_bps`.
   - 2–6 milestones, shares summing to exactly 10,000, offsets strictly increasing. Shared `bundleMilestonesSchema` enforces this in the only writer, the partner route.
   - No `packages.kind` column is needed: a package with milestones is a bundle, which keeps every reader tolerant.
2. **The split is computed once, at checkout** (shared `bundlePlan`).
   - Price, discount, GST and commission are split by share with a floor split, and the **last milestone takes the paise remainder**.
   - Taxable, total and earning are derived per child, so every child is internally consistent **and every column sums exactly to the whole**. Σ child totals = the captured payment.
   - The plan is frozen on `checkout_sessions.bundle_plan`.
   - Add-ons are not offered on plans (409 `addon_changed`). A coupon applies to the whole, as ever.
3. **One payment → N ordinary child orders, atomically.**
   - The trigger `checkout_sessions_materialize_bundle` fires in the same transaction in which `materialize_order` links the session to its order:
     - it records `bundle_purchases` (buyer, provider, package, the ONE payment);
     - it turns the materialised order into child 1 (its share; the payment row stays on it);
     - it inserts children 2..N from the frozen plan, copying and never recomputing.
   - `orders.bundle_purchase_id`, `bundle_seq` and `available_at` link each child to the purchase.
   - Neither `materialize_order` version (0003 / staged 0022) is redefined.
   - The trigger fires only when `order_id` is first set, so a replayed webhook creates nothing.
4. **Each child is an ordinary order.**
   - It has its own state machine, due date (`available_at` + its days), invoices, dispute and payout at T+2 after its own completion.
   - A later child becomes actionable at `available_at` (the previous milestone's due day). The 24-hour no-accept auto-cancel counts from then: `staleOrdersForAutoCancel` filters on it, and `autoCancelOrder` guards it too.
5. **Refunds per child on the one payment.**
   - Shared helpers `paymentForOrder` / `refundForOrder` resolve a child's payment through its purchase and its **own** refund row by key (`rfnd_<order id>`, the key `processRefund` always wrote).
   - They run exactly the previous queries for every ordinary order.
   - Used by `processRefund`, dispute resolve, and the admin order / dispute views.
   - Several partial refunds on one Razorpay payment, one row per child. ADR-014's one-refund-row-per-order holds per child.
6. **"Cancel remaining"** (`POST /api/v1/bundles/[id]/cancel-remaining`):
   - Buyer's own session only.
   - Every **unstarted** child (`placed` / `accepted`) goes through the ordinary buyer `cancel` transition, so the existing policy refunds 100 %. Started or finished children are untouched.
   - If the provider is suspended, ops cancel the remaining children the same way with the existing admin tools. Moving them to another provider would be a new purchase the buyer consents to; money is never moved automatically.
7. **Surfaces.**
   - Provider: a "Sell as a plan" milestones editor on the listing edit page.
   - Buy box: "Pay once · N milestones", with the exact per-milestone split.
   - Checkout: the plan lines.
   - `/app/plans`: timeline, next milestone due, money still held, "Cancel remaining".
   - Each child's order page: "Milestone k of your plan".

## Consequences

- A plan is N ordinary orders sharing one payment. Payouts, disputes, invoices and the state machine need no plan-specific rule. The only money-path change is how a child finds its payment and refund row, which is byte-identical for every other order.
- **GST timing on advance receipts** (tax on the whole at payment vs per milestone invoice) is part of the §9.1 CA sign-off. The per-child invoices follow today's provisional structure.
- **Support lookups** show no refund status for a later child (it has no payment row of its own). Ops read it on the admin order page.
- **Rollback:**
  - Turn `bundles_enabled` off. Packages sell as single orders again, and the editor, plan display and `/app/plans` hide.
  - Paid plans keep running as ordinary orders.
  - Migration 0067 stays (additive).
