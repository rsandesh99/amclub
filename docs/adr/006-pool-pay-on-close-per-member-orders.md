# ADR 006 — Group-buy pools: pay-on-close, one goods order per member

**Status:** Accepted for M1 (pending founder confirmation of §9.1/§9.4 defaults), 2026-09-06.
Touches money and a state machine (§8.4).

## Context

MART_DESIGN.md §4.4 specifies pools with a UPI block-and-capture mechanic, report-first, with
pay-on-close as the fallback. The report (docs/mart/PSP_BLOCK_CAPTURE_REPORT.md) could not
verify merchant enablement, caps or validity from the build environment, and the general NPCI
mandate cap sits below realistic pool shares in two launch categories. §9.1 leaves the pool
invoicing model open (consolidated seller order vs one order per member).

## Decision

1. **Pay-on-close at launch.** `pool_members.payment_state` uses the §4.4 vocabulary with the
   pay-on-close meaning: `blocked` = commitment recorded (no money moved), `captured` = member
   order paid, `released` = commitment void (unmet / cancelled / left while open), `failed` =
   did not pay inside `pool_pay_window_hours` — a default. The mode is config
   (`mart_settings.pool_payment_mode`); `block_capture` is refused at join until the report's
   checklist is signed off.
2. **One goods order per member (§9.1 default).** On `closed_met` each member pays an ordinary
   `checkout_sessions` row (kind='goods', line item at the pool unit price, the member's
   delivery snapshot) → the unchanged webhook → `materialize_order` → an ordinary goods order →
   the same release gate and `payout.ts`. No consolidated-order money path exists; if the CA
   later prefers consolidated invoicing, it is an invoice-presentation change, not a payment
   change.
3. **The money rule has one guard.** `mayCapturePoolMember(pool, member)` (shared) is the only
   condition under which a member checkout session is created; it is true solely for
   `closed_met/blocked`. Sessions are keyed on a deterministic idempotency key
   `(pool_id, member_id)`, so replays return the same session and can never create two
   orders for one member.
4. **Close and settle are idempotent and race-safe.** Every status write is guarded on the
   state it expects (`status='open'` for close, `'blocked'` for capture/fail, `'closed_met'`
   for ordered). The hourly cron and an admin "close now" may overlap without double effects.
5. **Draft precedes the machine.** Pools carry a `draft` status before §4.4's `open`: the
   Group-Buy Agent drafts, the founder approves terms (recorded to `ai_decisions`), only then
   does the pool open. The §4.4 transition table itself is unchanged.
6. **Discipline is an input, not a score.** `buyer_pool_discipline_v1` exposes due / honoured /
   defaulted per MSME; `poolDisciplineFactor` applies the same sample gates as the provider
   score (≥3 compute, ≥5 public). The blended formula stays private.
7. **Launch pool categories and schedule are config** (`pool_categories`,
   `pool_schedule_day_of_month`, `pool_open_limits`), defaulted to the three consumables
   categories per §9.4 pending the founder's list.

## Consequences

- No services file changes; `materialize_order`, payout, refunds and invoices are reused
  verbatim. Inertness while `MART_ENABLED=false` holds: the cron returns `skipped`, every
  route 404s, migration 0023 is staged with 0022.
- A member who defaults keeps the seller whole only to the extent other members pay; the
  seller sees allocations with payment states and the buyer's discipline factor is visible to
  admins. If defaults prove common in the pilot, the block-and-capture flip is the remedy.
- Reversal: `pool_payment_mode` and `pool_categories` are config; cancelling every open pool
  releases all commitments with no money moved.

## Addendum (2026-09-24) — frozen listing terms, re-review, server totals (audit M16, L4)

- **A pool freezes the listing's tax identity when it opens.** `approveAndOpenPool` writes
  the listing's `gst_rate_bps`, `hsn_code` and `unit` onto the pool (migration 0077;
  backfilled for pools already open or closed met), and `prepareMemberCheckout` charges
  those, never the listing's current values. A member pays the GST they committed to.
- **Material listing edits wait while a pool is live.** The seller route refuses a change
  to name, images, unit, HSN, GST slab or category (shared `PRODUCT_MATERIAL_FIELDS`)
  with 409 `pool_live` while a pool on the listing is `open` or `closed_met`
  (`POOL_LIVE_STATUSES`). Otherwise the edit would send the listing back to review and
  leave members unable to pay inside their window (a default through no fault of theirs).
- **What the admin approved is what stays live** (ADR-005 one-spine catalogue): a material
  edit of an `active` listing moves it `active → pending_approval` and clears its approval
  (always for a category change; a seller already past `auto_approve_after_listings` keeps
  other material edits live, the same trust the submit path gives — shared
  `productEditReview`). A `suspended` listing edited that way is reactivated into
  `pending_approval`, not `active`. Both are **extensions** of `PRODUCT_TRANSITIONS`
  (`active → pending_approval`, `suspended → pending_approval`); no edge into `active`
  starts anywhere but a reviewed state. The admin approval is pinned to the version
  reviewed (`reviewed_updated_at` = the listing's `updated_at`; a later edit → 409
  `listing_changed`).
- **The member's figure is the server's (L4).** The pool API returns `member.amounts`
  (taxable, GST, total for the member's quantity) and `pool.unitDisplay` (one unit with
  GST) from `poolMemberAmounts` — the same `computeGoodsOrderAmounts` on the same inputs as
  `prepareMemberCheckout`, which refuses (`amount_mismatch`) if they ever differ. "Pay ₹X
  to confirm" (web and mobile) is the amount charged; clients never multiply.
- **Verification:** `verify-mart.ts` §H (re-review, pinned approval, snapshot at open,
  `pool_live`, checkout at the frozen slab after the listing changed underneath, the pool
  API totals); shared `mart.test.ts` (transitions, `productEditReview`, the pinned review
  schema); `killtest-mart-pools` / `killtest-mart-schema` green on a bootstrapped 0077.
