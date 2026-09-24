# ADR 026 — One payout release rule, confirmed transfers, compare-and-set order writes, durable refunds and invoices

**Status:** Accepted 2026-09-24. Touches money and the order state machine's write path (§8.4); no transition is added, removed or repurposed. Decides audit findings **H5, H6, H7, H8, H9, M19** and **M39** (`docs/audit/2026-09-24-architecture-security-audit.md`). Builds on ADR 014 (dispute settlement) and keeps its rules.

## Context

The audit confirmed five ways the money path could pay twice, pay against a dispute, or strand money, once real volume arrives:

- **H5.** Admin "Retry payout" on the order page moved `failed` **and `held`** payouts to `scheduled` and ran the transfer. It skipped every gate: the order status, the goods and services evidence gates, and the refusal of delegated tokens. A payout held for an open dispute or return could be released from there.
- **M19.** The sanctioned release route (`/admin/payouts/[id]`) checked the goods and services gates, but never the order status. A `completed → disputed` order's held payout could be released while the dispute was open.
- **H9.** `runPayouts` marked a payout `failed` whenever `createTransfer` threw. A timeout after Razorpay had created the transfer therefore looked like a failure, and the next retry paid again. A hung call left the payout in `processing` for ever.
- **H6.** Order status writes were not compare-and-set. The auto-accept and auto-cancel crons, and two parties acting at once, could overwrite each other. For example, the auto-accept cron completes an order after the buyer raised a dispute, then schedules the payout. The goods actions updated with a status guard but ignored a 0-row result and still ran their refunds and payouts.
- **H7.** A refund that failed after the status write (cancel, auto-cancel) threw out of the transition. The order stayed cancelled with no refund, and nothing ever retried it.
- **H8.** The invoice PDF drew header values with a WinAnsi font, so an Indic buyer or provider name threw. Accept-delivery returned 500 after completing the order, no invoice was ever created, and the auto-accept batch aborted.

## Decision

1. **One run-time release rule, inside `runPayouts`.** After a payout is claimed (`scheduled → processing`), `payoutRunBlockers` re-reads the order. A payout moves only when:
   - the order status is in `PAYOUT_RELEASE_STATUSES` (`completed`, `resolved_release`, `resolved_partial`), which excludes `disputed`;
   - and, when the order is plainly `completed`, the goods release gate (goods) or the services evidence gate (services, when enforced) is clear.
   
   A blocked payout goes to `held` with a `payout_held` event naming the reasons. `resolved_*` orders skip the evidence gates: the dispute decision is the release authority (ADR 014). Every caller inherits the rule: the daily cron, the admin release, dispute settlement and the order-page retry.
2. **"Retry payout" retries failures only.** The order-page action reschedules `failed` payouts and refuses `held` ones (409 `payout_held_use_release`); a held payout is released from `/admin/payouts`, where the dossier and gates are shown. All the admin order actions (retry, manual refund, finish refund) refuse delegated agent tokens.
3. **The release route checks the order status first** (409 `order_not_releasable`), before its existing goods and services gates.
4. **A transfer is confirmed, never assumed.**
   - Every transfer carries `notes.payout_id`.
   - A definite rejection marks the payout `failed`: a 4xx gateway error, a missing Route account, or no fee headroom (ADR-004).
   - Anything else leaves it `processing`, with a `payout_unconfirmed` event: a network error, a timeout, a 5xx. It is never retried blind.
   - Before a payout that was attempted before is sent again, the gateway is asked for a transfer carrying its `payout_id` (`findTransfer`). If one exists, the payout is marked `paid` with that transfer.
   - The reconcile cron settles payouts stuck in `processing` for more than 30 minutes the same way: `paid` if the gateway holds the transfer, otherwise `failed` so ops can retry.
5. **Every order status write is compare-and-set** (`.eq('status', from)` and a row count).
   - A party action that loses the race gets 409 `order_changed` and runs no side effect.
   - A cron that loses skips the order.
   - The `→ refunded` follow-up write is guarded the same way.
   - Goods actions stop at a 0-row update instead of running their side effects.
6. **Refunds are durable.** A refund failure after a cancel no longer throws. The order stays in its cancelled status with a `refund_failed` event, and the auto-cancel cron re-drives it: an order in `cancelled_by_buyer`, `auto_cancelled` or `cancelled_duplicate` (shared `ORDER_REFUND_OWED_STATUSES`) with a captured payment and no processed refund, older than 10 minutes, goes through `processRefund`, which is already key-guarded and finds a refund the gateway made. The cancel event records the status it was cancelled from, so the policy percentage is exact on a re-drive. Admin gets "Finish refund" on the order page.
7. **Invoices never fail an order action.** Every drawn string goes through the same WinAnsi-safe filter. `generateInvoices` failures are caught in accept-delivery (services and goods) and auto-accept, and recorded as `invoice_failed`. The reconcile cron (every 6 hours) generates any missing invoice for orders completed in the last 30 days. Rendering Indic scripts properly needs a shaping-capable renderer and stays a follow-up.

8. **Gateway lookups never read "unknown" as "none".**
   - `listRefunds` now throws when Razorpay cannot answer. It used to return an empty list, and `processRefund` would then create a second refund.
   - `findTransfer` throws once it has scanned 1,000 transfers without a match, rather than reporting "no transfer".
   - The reconcile cron's captured-payment scan pages through the whole window. It used to read only the first 100 payments (M39).

## Consequences

- There is one place that decides whether money leaves for a provider (`payoutRunBlockers` inside `runPayouts`). A new release path cannot skip it.
- `payout_unconfirmed` is a new event for ops to watch. The payout stays `processing` (visible on the order timeline and in the payouts list) until the reconcile cron settles it, within 6 hours.
- Money-rig criteria added to `verify-money-loop` (DC11):
  - an Indic business name completes the order and gets both invoices;
  - "Retry payout" refuses a held payout, and the admin release pays it;
  - after a recorded failure whose transfer actually went through, the retry settles on the same transfer, recorded as `recovered` (no second transfer);
  - the admin release refuses a disputed order's payout, and the payout run holds a scheduled one with reason `order_status:disputed`;
  - two concurrent accept-deliveries give one 200 and one 409, one completion and one payout;
  - "Finish refund" refunds a cancelled order at the policy percentage for the status it left, with one keyed row; a second attempt is refused;
  - the sweeper leaves a just-cancelled order alone (the idle guard).
- **Rollback:** revert the PR; no migration is involved.
