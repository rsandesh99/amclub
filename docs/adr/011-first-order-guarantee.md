# ADR 011 — First-order guarantee: a capped, evidence-backed, platform-funded make-good

**Status: DRAFT — blocked on H7** (2026-09-23, BUILD_PROMPTS S3.3). Touches money (§8.4): the make-good is an amount on
the order's one refund. H2, H3, H4 and H6 are **decided in ADR-014** (merged: H3 + H4 in PR #21, H2 in PR #23, H6 in
PR #24). H5 is decided in ADR-015 (PR #22), and H1, the money rigs in CI, is PR #25. **Not for approval yet**: G1 waits
only on the H7 Razorpay test-mode result, recorded in §6. G2 is met, but no code is written until this ADR is approved.
Everything it enables ships dark behind `guarantee_enabled` (default false). The flag can't be turned on until counsel
signs off, which the settings validator enforces in code, and until G3 is met.

## 1. Context

A buyer trying AMClub for the first time is afraid of paying a stranger. The first paid order is where AMClub loses
buyers it would otherwise keep, and it is the order with the least evidence on either side. The platform already has
four things:

- the evidence, meaning milestone photos, delivery documents and dispute statements (S1.7)
- a reliability score for the provider (ADR-010)
- a founder-run dispute console with an agent triage card (S1.7)
- exactly one refund path (`processRefund`)

This ADR adds a promise on top of those: **on the buyer's first paid order with a verified provider in good standing,
if the job goes wrong and the evidence supports the buyer, AMClub makes good up to ₹5,000, even when the provider is
not ordered to refund.** The platform pays; the provider's settlement never changes.

**Why the preconditions matter.** The guarantee rides on the dispute → settlement → refund path. A code read on
2026-09-23 found defects in exactly that path. They are now fixed and merged:

| Item | Decided in | What this ADR relies on |
|---|---|---|
| **H2** Which orders can be disputed, and for how long | ADR-014 §6, PR #23 | Every status after acceptance can be disputed (`accepted`, `requirements_submitted` and `revision_requested` gained a `→ disputed` edge). After completion, disputes are allowed only inside `agent_settings.dispute_window_days` (default 7, range 1–90) via the one shared `canRaiseDispute`. **Reviews do not end dispute rights.** The claim window reuses this clock (§8). |
| **H3** Settlement after a payout is already paid, and an atomic resolve | ADR-014 §1, §2 and §4, PR #21 | `planDisputeSettlement` decides before anything is written. A `paid` payout is kept only at exactly the settlement amount, otherwise the resolve refuses with 409 `provider_already_paid`; a `processing` payout gets 409 `payout_in_flight`. The claim is atomic (409 `resolution_in_progress`). An interrupted attempt is finished only with the same resolution and recorded amount (409 `resolution_conflict`). **The make-good runs inside that plan and claim** (§6, §7.4). |
| **H4** Refunds that collide on the one refund row | ADR-014 §3, PR #21 | **One refund row per order.** Any existing refund row refuses a refunding resolution (409 `refund_exists`). Every caller reads back the amount `processRefund` reports (409 `refund_mismatch`). No payment row gives 409 `no_payment`. |
| **H5** GST added twice | ADR-015, PR #22 | A quote marked `gst_included` is charged exactly its price (`computeGstInclusiveOrderAmounts`), so `total_paise` is what the buyer actually paid under both GST bases. The bound and the order limit use it (§3, §4, §6). |
| **H6** Duplicate paid orders on one RFQ | ADR-014 §7, PR #24 | A losing duplicate goes `placed → cancelled_duplicate → refunded` in the same pass that detects it. **A `cancelled_duplicate` order is never eligible** (§3). |
| **H1** Money logic tested in CI | PR #25 | The money rigs (`verify-money-loop`, both webhook kill-tests, `verify-phase7`, `verify-rfq`, `verify-authz`) run on every PR against a disposable Supabase (`.github/workflows/money-rigs.yml`). **S3.3's database criteria go into that harness** (§16) and never run against production. |

Still open:

| Item | State | What this ADR needs |
|---|---|---|
| **H7** Razorpay test mode with Route | **Not yet run.** Prod runs in simulate mode (ADR-003). The laptop's `.env.local` holds placeholder test keys (not a real key id or secret), which Razorpay rejects as "Authentication failed", and no Route linked account (2026-09-23). | A recorded test-mode run (§6). Every worked example pays out more than the payment captured. |
| **H8** Agent runtime deployed | Not done (no `FLY_API_TOKEN`) | Required before G3 (the flag), not before approval or code |

## 2. Decision summary (proposed defaults; the founder may change any of them at review)

- **Who:** the buyer's first paid order (per MSME, deduplicated by GSTIN and phone). Services only, with a verified
  provider in good standing whose score is at least 60, and an order of at most ₹50,000.
- **What:** a make-good of **0 up to min(₹5,000, what the buyer paid − the dispute refund)**, decided by the founder
  in the existing dispute console. There is no automation; an agent can never set, suggest or mention an amount.
- **How it's paid:** the make-good **is part of the order's single refund**. The dispute refund and the make-good are
  one combined amount, planned by `planDisputeSettlement` and paid by one `processRefund` call on the one refund row
  (`rfnd_<order_id>`), with the amount read back (§6). There is no second refund, no second money path and no new
  order state.
- **Who pays:** the platform. The provider's settlement is computed from the dispute refund alone, exactly as today,
  and the platform books the make-good as a cost line.
- **Exposure:** a monthly budget stops new grants once paid-this-month plus open exposure reaches it. **A promise
  already made is always honoured,** including after a rollback.

## 3. Eligibility

Every condition below must hold, evaluated server-side when the order is created from the captured payment (§7.1):

| # | Condition | Source | Reason code if it fails |
|---|---|---|---|
| 1 | `guarantee_enabled` is on | the setting | `disabled` |
| 2 | This is the MSME's **first order that reached payment**. No other non-void guarantee exists for the `msme_id` (one per MSME, ever), and no live identity match on the MSME's GSTIN or the buyer's phone (keyed HMAC, §10). | `order_guarantees`, `guarantee_identities` | `not_first_order` / `duplicate_identity` |
| 3 | Not a duplicate RFQ order: an order that became `cancelled_duplicate` (ADR-014 §7) is **never** eligible, and the grant runs after RFQ finalisation, which is the pass that detects and cancels a duplicate | `orders.status`, the `duplicate_rfq_order` event | `duplicate_order` |
| 4 | A services order (`orders.kind = 'service'`); goods have their own return flow | `orders.kind` | `goods` |
| 5 | The provider is `active` (`provider_profiles.status`) | `provider_profiles` | `provider_not_active` |
| 6 | The provider's bank account is verified: a `bank_account_verifications` row with `verified = true` and `stub = false`, from the vendor **or** an audited `admin_override` (the row's `provider` column records which; the override carries `result.admin_id` + `reason`) | `bank_account_verifications` | `bank_unverified` |
| 7 | A `provider_scores` row for the current `SCORE_VERSION` with `score IS NOT NULL`, `gated = false` and `score ≥ guarantee_min_provider_score` (60) | `provider_scores` (ADR-010) | `provider_score_missing` / `provider_score_gated` / `provider_score_below` |
| 8 | `total_paise ≤ guarantee_max_order_paise` (₹50,000) | `orders.total_paise` | `order_over_limit` |
| 9 | The monthly budget is not exhausted (§5) | `order_guarantees` + `guarantee_payments` | `budget_exhausted` |

**On #6, the `admin_override`.** Proposed: it counts. The KYC vendor isn't live yet. Without the override no provider
could qualify, and the override is audited and always distinguishable from a vendor check.

**On #7, the score.** A missing score or a `gated` score makes the order ineligible. The guarantee rests on a track
record, and a provider below the ADR-010 sample gate has none yet. So a brand-new provider can't offer the guarantee.
That is deliberate: the platform's money backs demonstrated reliability, not a neutral prior.

**On #8, total rather than taxable.** The limit is on `total_paise`, what the buyer actually paid. The bound in §4 is
"up to what they paid", so both limits are measured on the same amount. Since ADR-015, `total_paise` means exactly
that under both GST bases: a GST-exclusive quote pays the price plus 18 % GST, and a quote marked `gst_included` pays
exactly the quoted figure (`computeGstInclusiveOrderAmounts`). Example C in §6 shows the included case.

**When the first order doesn't count.** An order cancelled (by the buyer, or auto-cancelled) **before acceptance**
voids its guarantee and releases its identities in the same transaction. The buyer's next first order can then
qualify.

**The alternative: "first order with each provider".** The design could promise the guarantee on a buyer's first
order with *each* provider. It is friendlier to returning buyers trying someone new, but eligible volume goes up by the
number of distinct providers a buyer uses. At an illustrative 2.5 providers per buyer in the first year, exposure is
×2.5 for the same cap. It also makes the guarantee a standing feature of every new relationship rather than an
on-ramp. **The default is first order on the platform**, because the fear this addresses is paying a stranger *on
AMClub*, and the budget stays predictable. FOLLOWUPS keeps the alternative.

## 4. The cap and the top-up bound

- `guarantee_cap_paise` = ₹5,000 (500,000 paise).
- `makeGoodBound = min(cap, total_paise − dispute_refund)`, where `dispute_refund` is the `refundPaise` of
  `disputeSettlementPaise` for the chosen resolution. A make-good can top the buyer up to at most what they paid, never
  above it. So the combined refund (dispute refund + make-good) is always ≤ `total_paise`, which is the payment's
  captured amount; that is the limit `processRefund` and `manual_refund` already enforce (ADR-014 §3,
  `refund_over_total`).
- `total_paise` is what the buyer paid under either GST basis (ADR-015), so the bound is the same rule for both.
- `refund_full` leaves nothing to top up. A make-good there returns 422 and the guarantee becomes `void`.
- A make-good of 0 is allowed (the founder decides the evidence doesn't support one), and the guarantee becomes `void`.

## 5. Exposure

- `guarantee_monthly_budget_paise` defaults to **0, which means no grants** until the founder sets it.
- New grants stop (`budget_exhausted`) once **paid this month + open exposure** reaches the budget. Open exposure is
  (`active` + `claimed` guarantees) × cap.
- **Existing promises are always honoured.** The budget limits new grants only, never a decision on an existing claim.
- An `/admin` tile shows active, claimed, paid this month and the remaining budget.

**Worst-case make-good cost per 100 first orders, every claim paid at the ₹5,000 cap:**

| Claim rate | Claims | Cost (first order on the platform) | Cost (first order with each provider, ×2.5 illustrative) |
|---|---|---|---|
| 2 % | 2 | ₹10,000 | ₹25,000 |
| 5 % | 5 | ₹25,000 | ₹62,500 |
| 10 % | 10 | ₹50,000 | ₹1,25,000 |

**What the budget has to cover.** Open exposure counts every live promise at the full cap, not the expected claims.
So the budget has to cover about (first orders granted per month) × ₹5,000 while those promises are open, or grants
stop early. Example: 100 grants a month with an average open life of 30 days holds about 100 × ₹5,000 = ₹5,00,000 of
exposure against the budget. The founder sets the budget knowing that; it is a money control, not a forecast.

## 6. One money path, and the Razorpay question (H7)

### The rule this must obey (ADR-014 §3)

There is **one refund row per order**. A second refund is refused with 409 `refund_exists`, and every caller reads back
the amount `processRefund` reports (409 `refund_mismatch` on a difference). A separate make-good refund, a second
`processRefund` call, or any other transfer to the buyer would be a second money path, which is a design violation
("one spine", CLAUDE.md).

### How the make-good moves money: it IS the order's single refund

**The make-good is not a second payment. It is part of the one refund the dispute resolution makes.** The resolution's
refund amount becomes one combined figure, **`dispute_refund + make_good`**, paid by **one** `processRefund` call on the
order's one refund row (`rfnd_<order_id>`).

- **Planning.** `planDisputeSettlement` gains an optional `makeGoodPaise` (default 0). Without it every plan is
  byte-identical to today; a shared test pins that over ADR-014's grid.
  - `providerPaidPaise` is still `disputeSettlementPaise(…)` from the **dispute refund only**. The make-good never
    reduces it, and it is the same shared formula `resolveDispute` uses today.
  - The refund leg's amount is `refundPaise + makeGoodPaise`. So a `release` with a make-good becomes a *refunding*
    plan (`refund: true`) whose amount is the make-good alone.
  - Every ADR-014 conflict applies unchanged, to the combined amount:
    - `refund_exists` when any refund row exists (a resumed attempt must match the recorded combined amount)
    - `provider_already_paid` and `payout_in_flight` for the payout leg
    - `no_payment`
- **Paying.** `processRefund` receives the combined amount. `computeRefundPaise` gains an optional `makeGoodPaise`
  (added after its clamp, and the combined figure never exceeds `total_paise`, §4). Every existing call site passes
  nothing and gets the same value. Then the amount is read back. **A mismatch is ADR-014's `refund_mismatch`:** the
  dispute stays open, the guarantee stays `claimed` and nothing is marked paid.
- **Labelling.** `refunds` gains `guarantee_paise` (≥ 0, ≤ `amount_paise`, CHECK), so every reader can label the
  make-good part "First-order guarantee — paid by AMClub". One `guarantee_payments` row (append-only, unique
  `order_id`) is the platform's cost line.
- **Resuming.** ADR-014 §4 records the intended resolution and refund amount on the open dispute right after the claim.
  With a make-good, the recorded amount is the **combined** figure, plus the make-good part separately. A resume must
  match both, or it is refused with 409 `resolution_conflict`.

**What this rule rules out, stated plainly:**
- **A refund before the dispute.** If a refund row already exists (a cancellation refund, or ADR-014 §2's interim
  `manual_refund`), the make-good **cannot** be paid. There is only one row and it has already been used, so resolve
  returns 409 `refund_exists`. The guarantee stays `claimed`, and the founder records a 0 make-good (the guarantee
  becomes `void`).
  - In particular, ADR-014 §2's interim path for an already-paid provider ("refund the buyer with `manual_refund`, then
    resolve as `release`") is **incompatible** with a make-good.
  - For a guaranteed order in that position, the founder instead resolves as **`release` + make-good**. The payout is
    `paid` at the full earning, so it is `keep`, and the make-good is the order's one refund. That is example A below.
- **A partial refund after a payout was paid** stays refused (`provider_already_paid`), as it is today. A make-good
  doesn't change that.

**Why not two rows or a second path.** ADR-014 §3 already weighed several refund rows per order and rejected them: it
changes the refund engine, reconcile, invoices and the buyer refund display. The make-good needs none of that, because
one combined amount on the existing row carries it.

**Everything else is unchanged:**
- **Order status** follows the resolution (`resolved_release`, `resolved_partial` or `resolved_refund`). There is no new
  order state.
- **Route ordering** stays as `resolveDispute` has it: the provider transfer goes before the refund.
- **Invoices** stay the only invoicing path. The make-good never produces a credit note against the provider's invoice,
  and never changes the provider's TDS 194-O base.

### Worked examples (500 bps; every figure from the shared money functions — the tests derive, never hard-code)

**Examples A and B are GST-exclusive:** a quote of ₹20,000 **plus** 18 % GST (`computeOrderAmounts`). A quote of
**₹23,600 marked `gst_included`** produces exactly the same order under ADR-015 (`computeGstInclusiveOrderAmounts`:
taxable ₹20,000, GST ₹3,600, total ₹23,600, commission ₹1,000, earning ₹19,000), so A and B hold for it too.

Order: price ₹20,000, no discount → taxable ₹20,000 → GST (1800 bps) ₹3,600 → **total ₹23,600** → commission
₹1,000 → provider earning **₹19,000**.

- **A — `release` + make-good ₹5,000.**
  - The provider is paid ₹19,000 (`release` pays the full earning), and the buyer is refunded ₹5,000.
  - **Money out is ₹24,000 against ₹23,600 captured.**
  - The platform bears the whole ₹5,000: its ₹1,000 commission plus ₹4,000 from its balance, plus gateway fees
    (ADR-004). The ₹3,600 GST is a tax liability, not a cushion.
- **B — `refund_partial` ₹8,000 + make-good ₹5,000.**
  - The provider is paid round(1,900,000 × (2,360,000 − 800,000) / 2,360,000) = round(1,255,932.20…) = **1,255,932 paise
    (₹12,559.32)**, exactly what `resolveDispute` pays today for an ₹8,000 refund.
  - The buyer is refunded ₹13,000 on one refund row, with `guarantee_paise` = ₹5,000.
  - **Money out is ₹25,559.32 against ₹23,600 captured.**

**Example C is GST-included:** a quote of **₹20,000 marked `gst_included`** (ADR-015). The guarantee bound and the order
limit use `total_paise`, which here is the quoted figure itself.
`computeGstInclusiveOrderAmounts({ grossPaise: 2,000,000, commissionBps: 500 })` gives:
- taxable round(2,000,000 × 10000 / 11800) = **1,694,915 paise**
- GST 305,085 paise
- **total ₹20,000**
- commission round(1,694,915 × 0.05) = 84,746 paise
- provider earning **1,610,169 paise (₹16,101.69)**

- **C — `release` + make-good ₹5,000.**
  - The bound is min(₹5,000, ₹20,000 − 0) = ₹5,000.
  - The provider is paid ₹16,101.69 (`disputeSettlementPaise` for `release`), and the buyer is refunded ₹5,000.
  - **Money out is ₹21,101.69 against ₹20,000 captured.**
  - The platform bears the ₹5,000: its ₹847.46 commission plus ₹4,152.54 from its balance, plus fees. The ₹3,050.85
    GST is a liability, not a cushion.

### H7: what Razorpay has to allow (NOT YET RUN; blocks approval)

Every example transfers the provider's share **and** refunds, and together they exceed the payment captured. Each
refund on its own is below its capture (A ₹5,000 and B ₹13,000 of ₹23,600; C ₹5,000 of ₹20,000); the combined
refund is ≤ `total_paise` by §4. The open question is only whether Razorpay lets transfer + refund exceed the capture,
and from which balance.

The recorded test-mode run must answer, for a payment of ₹23,600 with a ₹19,000 Route transfer made **first**:

1. Does Razorpay accept a ₹5,000 refund on that payment after the transfer, and which balance does it debit (the
   un-transferred part of the payment, the merchant balance, or does it refuse)?
2. The same for a ₹13,000 refund after a ₹12,559.32 transfer.
3. If it refuses: does a transfer reversal work (and at what cost to the provider relationship), or does the design need
   to refund first and settle the provider from the platform balance?

**If Razorpay refuses, the one-row design can't pay a make-good, and this ADR must change before approval.** The
result, and the merchant-balance funding it implies (G3: the balance must be funded to at least the exposure cap),
will be recorded here. The same run answers ADR-014 §2's open clawback question (a Route transfer reversal).

**Attempt log.**
- **2026-09-23 — not run.** `apps/web/.env.local` holds `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` with the `rzp_test_`
  prefix, but they are placeholders: a 13-character key id and an 8-character secret, where a real test key id is 23
  characters and a secret 24. Razorpay answered every read-only probe (`GET /v1/payments`, `/v1/transfers`,
  `/v1/balance`) with 401 "Authentication failed". No payment, transfer, refund or reversal was attempted, and no
  Route linked account is configured.
- **To run it, the founder provides:**
  - real Razorpay **test-mode** keys, never live, and never placed in Vercel
  - Route enabled on the test account, with one test linked account
- **The run:** one ₹23,600 test payment, captured; transfer ₹19,000 to the linked account; refund ₹5,000; then try a
  transfer reversal. Record (a) whether the refund is allowed, (b) which balance it debits, and (c) whether a reversal
  is needed or possible, with the API responses (ids redacted).

## 7. How it works (the design the code will follow at G2)

1. **Grant at materialisation.** This runs at the end of `materializeFromCapture` (`materialize.ts:22`). Its three
   callers are the webhook, `checkout/simulate` and `reconcileCapturedPayments`.
   - It runs after a successful `materialize_order` and **after** `finalizeQuoteAcceptance`, and only when the flag is
     on.
   - It reads the facts server-side, computes eligibility (shared, pure), then calls
     `grant_order_guarantee(...)`: a `SECURITY DEFINER` SQL function, service role only, that inserts the guarantee
     and its identity HMACs atomically. A unique violation returns `duplicate`, never an error.
   - A failure never affects the payment or the order: it is logged to Sentry, and the order proceeds with no
     guarantee.
   - Replays are idempotent.
   - `terms_version` comes from `effectiveLegalVersions`.
2. **Claim.** When the order has an `active` guarantee and the dispute window is open, the raise-dispute UI (web and
   mobile) shows "Claim the first-order guarantee".
   - The transition carries `guaranteeClaim: true`.
   - The guarantee moves `active → claimed` (with `dispute_id` and `claimed_at`) as a guarded update that checks the
     affected row count.
3. **Console.**
   - A guarantee panel sits beside the S1.7 triage card. It shows the facts, the cap, and `makeGoodBound` live as the
     founder picks the resolution and amount.
   - The "Make-good amount" input accepts 0 up to the bound, defaults to **0**, and is **never** pre-filled from the
     triage.
   - The panel shows any existing refund row (H4).
4. **Resolve.** `POST /admin/disputes/[id]/resolve` gains an optional `makeGoodPaise`. It refuses with **422** when:
   - the make-good is above the bound
   - the guarantee isn't `claimed`
   - the resolution is `refund_full` (the guarantee becomes `void`)

   Everything else is ADR-014's path, with the combined amount (§6):
   - `planDisputeSettlement` (with `makeGoodPaise`) decides before anything is written. Its conflicts (409
     `refund_exists` / `provider_already_paid` / `payout_in_flight` / `no_payment`) leave the guarantee `claimed` and
     are shown in the console with ADR-014 §5's messages.
   - Then the atomic claim (409 `resolution_in_progress`), and the intended resolution + combined amount + make-good
     are recorded on the dispute (§4 resume).
   - The payout leg is unchanged (the shared formula, from the dispute refund only).
   - One `processRefund` call with the combined amount, then the **read-back**:
     - On a mismatch it is `refund_mismatch`: the dispute stays open, the guarantee stays `claimed`, and nothing is
       marked paid.
     - On a match, it sets `refunds.guarantee_paise`, inserts one `guarantee_payments` row (append-only, unique
       `order_id`), and moves the guarantee to `paid`. A make-good of 0 moves it to `void`.
   - A replayed or concurrent resolve moves no money and writes nothing: ADR-014's claim and resume rules, plus the
     guarded guarantee transitions.
   - The audit `after` includes `make_good_paise`.
5. **Expiry.** A step in `cron/auto-accept` (hourly, where completion happens) moves `active → expired` as a guarded
   update, once `canRaiseDispute` reports `window_closed` for the order (§8). There is no stored clock.
6. **Statuses.** `GUARANTEE_STATUSES = active | claimed | paid | expired | void`. Transitions: `active → claimed |
   expired | void`; `claimed → paid | void`; the rest are terminal. They live only in `state-machines.ts`.

## 8. Claim window

- **One clock: ADR-014 §6.** A claim is possible exactly when a dispute is: `canRaiseDispute` (`dispute-window.ts`) is
  true for the order.
  - Before completion, that means every status after the provider accepts.
  - After completion, it means until `completed_at + dispute_window_days` (the registered `agent_settings` key, default
    7).
- **Computed on read.** ADR-014 §6 computes the window on read from the current setting, not frozen at completion, so
  the guarantee stores **no `expires_at` of its own**. The buyer-facing deadline is the order's
  `disputeWindowEndsAt`, which the server already exposes. The expiry step uses the same function (§7.5).
- **Reviews do not end dispute rights** (ADR-014 §6): posting a review leaves the order `completed`, so a review
  doesn't end the claim either. This ADR adds no clock and no review rule of its own.

## 9. Adjudication

- The founder decides in the existing console, informed by the S1.7 triage and the evidence.
- The make-good is **discretionary and bounded by code.** 0 is a valid decision, and the note says why.
- No automation, no agent decision, no tool. No agent prompt, template or tool mentions the guarantee in v1.
- The ops playbook (`docs/agents/GUARANTEE.md`, written at G2) covers:
  - reading the evidence
  - what to write in the note
  - what a 409 refund collision means
  - reading the cost line and the exposure tile

## 10. Abuse controls and identity privacy

- **One per MSME, ever:** a partial unique index on `order_guarantees.msme_id` where `status <> 'void'`.
- **Identity deduplication across accounts.** The MSME's GSTIN and the buyer's phone are stored **only** as
  HMAC-SHA256 values keyed by a server-only secret `GUARANTEE_IDENTITY_PEPPER` (validated in `lib/env.ts`). A plain
  hash of a 10-digit phone number can be reversed by enumeration. A partial unique index on `(kind, value_hmac)` where
  `released_at is null` enforces it, and voiding releases the identities in the same transaction.
- **Other limits:** the order limit (§3 #8), the monthly budget (§5), and the H6 duplicate exclusion.
- **Visibility.** A buyer reads only their own guarantee's status, cap, expiry and terms version (column privileges).
  `eligible_reason` and the identity tables are hidden. A provider reads nothing.

## 11. Exclusions

- **Goods orders.**
- **Orders cancelled or auto-cancelled before acceptance:** the guarantee is void and eligibility is restored.
- **`refund_full`:** there is nothing to top up.
- **Fraud and duplicate accounts:** caught by the identity HMACs and the one-per-MSME index.
- **Duplicate RFQ orders:** a `cancelled_duplicate` order (ADR-014 §7) is never eligible. It is refunded in full in the pass that detects it.
- **An order whose one refund row is already used** (a cancellation refund, or a `manual_refund` before the dispute) can't receive a make-good: 409 `refund_exists` (§6).
- **Honoured, not excluded:** a provider suspended *after* the order was paid. The promise was made at payment.

## 12. Settings (closed registry `AGENT_SETTING_DEFS`)

| Key | Default | Rule |
|---|---|---|
| `guarantee_enabled` | false | Refused while `guarantee_terms_counsel_approved` is false (cross-setting rule in the settings PATCH; both changes audited) |
| `guarantee_terms_counsel_approved` | false | Set only after counsel signs off the terms copy |
| `guarantee_cap_paise` | 500000 | |
| `guarantee_max_order_paise` | 5000000 | |
| `guarantee_min_provider_score` | 60 | |
| `guarantee_monthly_budget_paise` | 0 | 0 = no grants |

## 13. Funding and accounting

- **Cost line.** Each paid make-good writes one `guarantee_payments` row, the platform cost line for the ledger and
  the export.
- **Provider side unchanged.** It never produces a provider credit note, and it never changes the provider's TDS 194-O
  base.
- **CA treatment pending.** Whether it's a discount, a promotional expense or something else is **not guessed in
  code**: FOLLOWUPS + a `docs/COMPLIANCE.md` row until the CA answers.
- **Balance funding (G3).** The platform's merchant balance must be funded to at least the exposure cap before the
  flag flips.

## 14. Questions for counsel and the CA (to send now)

**Counsel:**
1. Is a free, capped, discretionary make-good, attached to a buyer's first purchase and paid by the platform (not the
   provider), outside the definition of an insurance product under the Insurance Act 1938 and IRDAI regulations? Does
   the answer change if the terms say "discretionary" versus "we will make good"?
2. Could it be read as a warranty or guarantee given *on the provider's behalf*? What wording keeps it clearly the
   platform's own promise? Does the provider addendum need a clause saying the provider's settlement is unaffected?
3. Under the Consumer Protection (E-Commerce) Rules 2020 and the Consumer Protection Act 2019, what must the terms
   disclose, and does "evidence-backed, decided by AMClub" meet the fairness requirements for B2B buyers who are MSMEs?
4. Is storing HMACs of GSTIN and phone, only for deduplication, covered by the existing privacy notice under the DPDP
   Act 2023, or does it need a line added?
5. Please review the DRAFT terms page (`(public)/guarantee`, written at G2) before `guarantee_terms_counsel_approved`
   is set.

**CA:**
1. How should a make-good paid by the platform to a buyer be treated: a post-sale discount, a promotional or marketing
   expense, or something else? Does it affect the platform's GST on its commission?
2. Can it be paid without a credit note, leaving the provider's invoice and TDS 194-O base untouched, as this design
   intends?
3. Does paying a refund that exceeds the platform's commission (examples A and B) create any GST or TCS (Sec 52)
   reporting issue for the e-commerce operator?

## 14a. Rollback

- **Flag off:** no new grants, no badge, no checkbox, and resolve returns 422 on a make-good for new claims. Money is
  byte-identical to today.
- **Promises already made on paid orders are still honoured.** A guarantee created at payment is not withdrawn by a
  rollback. An `active` or `claimed` guarantee can still be decided in the console, and the console keeps the make-good
  input for those.
- **Removing the code** requires first letting every `active` / `claimed` guarantee reach a terminal state.

## 15. Consequences

- Buyers get a concrete reason to try a verified provider on AMClub first. Providers are unaffected.
- The platform takes on a bounded, budgeted cost, visible per order (`guarantee_payments`) and in aggregate (the
  exposure tile).
- It relies on the dispute path hardened in ADR-014 and ADR-015 (H1–H6, merged in PRs #21–#25).
- It depends on the Razorpay behaviour recorded in §6. If that fails, the design changes before any code.

## 16. Verification (where S3.3's database tests run)

- **Pure logic** runs in shared vitest, in CI with the other shared tests:
  - eligibility
  - `makeGoodBound`
  - `planDisputeSettlement` with `makeGoodPaise` (byte-identical without it, over ADR-014's grid)
  - `computeRefundPaise` byte-identity
  - examples A, B and C derived from the shared money functions
- **Database criteria** are added to the **money-rigs harness** (H1, PR #25, `.github/workflows/money-rigs.yml`): a
  `verify-guarantee.ts` step, plus new criteria in `verify-phase7.ts` where they concern resolve. They run on every PR
  against the disposable Supabase stack with the simulate gateway, and **never against production**. They cover:
  - grant, no second grant, the duplicate identity, `cancelled_duplicate`, the budget
  - claim, resolve A / B / C, the 422s
  - the 409s from ADR-014 with the guarantee still `claimed`
  - replay and concurrency
  - expiry via `canRaiseDispute`
  - RLS
- **Real money behaviour** comes only from the recorded Razorpay **test-mode** run of example A (§6, H7), attached to the
  S3.3 PR.
