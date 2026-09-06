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
