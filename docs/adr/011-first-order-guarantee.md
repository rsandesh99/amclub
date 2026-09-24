# ADR 011 — First-order guarantee (evidence-backed, capped) and delay compensation

**Status: Proposed 2026-09-24. Not accepted.** Touches money (§8.4). Blocks agent programme step **S3.3**. It becomes Accepted only when all three of these land:
1. **The founder fills §5** (the numbers).
2. **A CA opinion** on the accounting and GST line in §4.
3. **A recorded Razorpay test-mode run (H7)** of a refund followed by a credit.

No code ships before then.

## 1. Context

- The market survey (`docs/market/SURVEY_2026-09.md`, section G) found buyers hesitate on the **first** order with an unknown provider.
- Competitors offer "delay compensation" (AB-17). Decision D6 folds it into this ADR: one money path, one set of rules.
- What AMClub already has:
  - escrow (payouts wait for completion and the founder's release, ADR 002);
  - the dispute path, whose settlement rule is shared `planDisputeSettlement` (ADR 014);
  - policy refunds on cancellation.

  What it does not have is a promise that makes a first order feel safe *beyond* getting the money back.
- `BUILD_PROMPTS.md` S3.3 requires the guarantee to be:
  - **evidence-backed:** triggered by recorded facts, never by an agent's opinion;
  - **capped;**
  - **platform-funded;**
  - approved in this ADR before any code.

## 2. Decision (proposed)

### 2.1 What the buyer gets
**A make-good credit, never cash.** A single-use, buyer-bound credit is issued through the existing coupons engine (`coupons`, `coupon_redemptions`; written by the server only, ADR 018). It is redeemable on the buyer's next order within 90 days. Cash stays exactly what the order refund rules already give (`planDisputeSettlement` / `processRefund`), so the guarantee never adds a second money path and never pays out more than was captured.

### 2.2 When it triggers (facts only)

| Trigger | Fact that proves it | Applies to |
|---|---|---|
| **G1 First-order dispute won** | The order is the buyer's first paid services order, and its dispute resolved `resolved_refund` or `resolved_partial` (the ADR 014 row) | First order only |
| **G2 Delay (D6)** | The first `delivered` `order_events` row is later than `orders.due_at` + `delay_grace_days`, with no buyer-caused external wait recorded (`orders.external_wait_since` excluded) | First order only in v1; any order is a later decision (§6) |

- **One credit per buyer, ever.** If both triggers fire, the larger one applies.
- Goods orders (Mart) are out of scope in v1: their release gate and returns already cover them.

### 2.3 Who decides
- The S3.3 agent only **drafts**: it assembles the evidence (the order, the dispute row or the delivery timestamps) into a claim card.
- **The founder / ops confirms** each credit in the admin console. That click is the one `ai_decisions` row (feature `first_order_guarantee`, tool `issue_make_good`), and it is an admin action, never an agent tool.
- A kill switch (`first_order_guarantee_enabled`) and a monthly budget stop issuance instantly.

### 2.4 What does not change
- The order state machine: no new transitions. A credit is a coupon row.
- Payouts: the provider's payout follows the dispute outcome exactly as today.
- Provider-funded compensation (deducting from payouts) is **not** in v1. It changes payouts and needs its own amendment.

## 3. Options considered

| Option | Why not |
|---|---|
| Cash make-good on top of the refund | Razorpay can't refund more than was captured; a separate cash payout to buyers needs RazorpayX, a new money path and new KYC. Rejected for v1. |
| Provider-funded delay penalty | Rewrites payouts (a money path), is a contract change for every provider, and needs counsel. Later, as its own ADR. |
| "Money-back guarantee" wording without a credit | Already true through escrow + disputes. The survey warns against a "narrow protection" claim (PRD §A.4). The credit is the new part. |

## 4. Accounting and GST — **questions for the CA** (blocking)

1. **Booking:** is the credit a marketing / promotional expense of the platform when issued, or a discount on the next supply when redeemed? Which entity bears it (AMClub as marketplace operator)?
2. **GST (who bears the credit):** when the credit is redeemed on a provider's supply, does it reduce the provider's taxable value (Section 15(3) discount, which the provider must agree to) or stay a platform-funded payment on the buyer's behalf? The design assumes the second: the provider is paid the full order value, and AMClub funds the difference as a platform expense.
3. **GST (commission and TCS):** AMClub's commission invoice to the provider, and TCS under Section 52 if applicable — computed on the gross value or the net-of-credit value?
4. **Unused credit:** does expired unused credit need any reversal entry?

The answers become §4 of the accepted ADR. Until then, §2.1's "credit, never cash" is the design constraint.

## 5. Numbers — **founder to fill** (blocking)

| Setting | Proposed default | Founder value |
|---|---|---|
| Credit, G1 (dispute won) | 10 % of the order total, capped at ₹2,000 | |
| Credit, G2 (delay) | 5 % of the order total, capped at ₹1,000 | |
| `delay_grace_days` | 2 | |
| Credit validity | 90 days, one redemption, buyer-bound | |
| Monthly budget (issuance stops when reached) | ₹50,000 | |
| Eligible categories | all services except government-dependent (`categories.govt_dependent`) for G2 | |

Each becomes an `agent_settings` key registered in `packages/shared/src/agent-settings.ts` when S3.3 is built. No constant lives in code.

## 6. Consequences

- **Buyers:** a first order carries a concrete make-good, stated plainly once on the package page and at checkout. It shows only while the switch is on and the budget is not exhausted.
- **Money:** the platform's exposure is bounded by the monthly budget. Each credit is traceable: dispute or order → claim card → founder click → coupon → redemption.
- **Later decisions** (each needs an amendment): extending G2 to all orders; provider-funded penalties; cash make-goods.
- **Build (S3.3, after acceptance):**
  - migration: coupon `source` = `guarantee` + claim table;
  - shared `guaranteeEligibility()` + `makeGoodAmount()`, both pure and tested;
  - the claim-card drafter (bounded agent);
  - an admin confirm route;
  - money-rig criteria for issuance, budget stop, one-per-buyer and replay.
