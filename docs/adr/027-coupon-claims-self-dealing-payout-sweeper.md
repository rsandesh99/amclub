# ADR 027 — Coupon claims at checkout, the self-dealing guard, and the payout sweeper

**Status:** Accepted 2026-09-24. Touches money (coupons, payouts) and who may act on an order (§8.4); no order transition is added, removed or repurposed. Migration **0081**. Decides audit findings **M10** (parts 2 and 3), **M22** and **M38** (`docs/audit/2026-09-24-architecture-security-audit.md`). Builds on ADR 018 (server-written money rows) and ADR 026 (compare-and-set order writes, durable refunds and invoices).

## Context

### M10 — coupon limits were not atomic, and nothing limited one buyer

The checkout read `used_count < usage_limit` and froze the discount on the checkout session. `used_count` went up only when the payment materialised the order. Two buyers checking out at the last use both got the discount, and a leaked code could be used again and again by one buyer. Wave 3 (0075) had already closed the public read of `coupons`.

The checkout also froze whatever code the client sent, even one that gave no discount (an unknown code, or any code on a quote). `materialize_order` then recorded a redemption and bumped `used_count` for it.

## Decision

### 1. A checkout claims a coupon use before any payment opens (M10)

- `claim_coupon_for_session(session_id)` (0081, `SECURITY DEFINER`, service role only) decides under the coupon's row lock. Every claim on one coupon queues on that lock, and each count reads the claims committed before it.
  - The uses already redeemed (`used_count`) plus the live claims of other sessions must stay under `usage_limit`. Otherwise it answers `usage_exceeded`.
  - A live claim is a session with `coupon_claimed_at` set that can still be paid: status `created` or `materializing`, no order, not expired. A session that lapses unpaid gives its use back without any sweeper.
  - The same rule applies per buyer business under the new `coupons.per_buyer_limit` (NULL = unlimited). Redemptions alone answer `per_buyer_exceeded`. Redemptions plus this buyer's other unpaid claims answer `per_buyer_pending`.
  - A claim is idempotent (`already_claimed`). A lapsed session answers `session_closed`, even if it was claimed.
- The services checkout calls it after the session is written and before the gateway order is created. The claim covers the new session and a session re-read after a racing double-submit.
  - Only a held claim opens a payment. Anything else is 409 `coupon_unavailable` with `couponError` (a `coupons` message key), and no Razorpay order exists for that session.
  - A database error refuses the coupon too (fail closed).
- The session records the code **only when its discount applied**. An unusable code is still ignored (the buyer never saw its discount), but it no longer leaves a phantom redemption. A code that has run out, in total or for this buyer, is refused (409), never silently dropped.
- The validate route and the checkout pre-check the per-buyer limit from the buyer's redemptions (shared `perBuyerLimitReached`). The claim is the authority.
- `record_coupon_redemption(order_id)` replaces the application's read-modify-write fallback. It inserts the redemption and bumps `used_count` together, and a replay does neither. `materialize_order` still records the redemption in its own transaction, as before.
- The lock order is session, then coupon, which is the same as `materialize_order`, so the two cannot deadlock.
- The admin coupon form takes "Uses per buyer" (shared `adminCouponCreateSchema`).

## Consequences

- One buyer with a per-buyer limit of 1 who opens a second checkout while the first is unpaid is refused for up to 30 minutes (the session's life). The message says so (`coupon_in_checkout`).
- A session paid after it expired still materialises (the gateway took the money), so its use can land after another buyer took the "last" one. Refusing late payments is ADR 026's and M21's business, not this ADR's.
- **Deploy order:** apply 0081 before the code. Without it, the claim fails closed, and coupon checkouts answer 409 until the migration lands.
- **Proof:**
  - `verify-coupons` runs on the production-flags server (coupons on). Two checkouts at the last use give one 200 and one 409, and the winner's order carries the discount with one redemption. A per-buyer limit of 1 refuses a parallel second checkout and a second order, but not another buyer. An unknown code leaves no coupon on the session. The functions are not callable by a buyer.
  - `verify-authz` §10 checks the function grants on every PR.
  - The claim race was also run by hand on Postgres 16 with two sessions: the second waited on the lock, then got `usage_exceeded`.
- **Rollback:** revert the code, then drop the two functions, the two columns and the two indexes. The rollback note is in 0081.
