# ADR 011 — First-order guarantee: a capped, evidence-backed, platform-funded make-good

**Status: DRAFT — blocked on H2, H3, H4, H6, H7** (2026-09-23, BUILD_PROMPTS S3.3, gate G0). Touches money (§8.4): it
adds an amount to the order's refund. **Not for approval yet**: G1 needs ADR-014 (H2, H3, H4, H6) merged and the H7
Razorpay test-mode result recorded in §6 below. No code is written against this draft. Everything it enables ships dark
behind `guarantee_enabled` (default false). The flag can't be turned on until counsel signs off, which the settings
validator enforces in code, and until G3 is met.

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
2026-09-23 (re-verified the same day at the lines below) found defects in exactly that path. The table lists the ones
this design needs fixed first, with the decision each needs.

| Item | Defect on master (current line) | What this ADR needs from the fix |
|---|---|---|
| **H2** Which orders can be disputed, and for how long | `DISPUTABLE_STATUSES` (`state-machines.ts:54-60`) lists `accepted` and `requirements_submitted`, but `ORDER_TRANSITIONS` (L37-38) has no edge from either to `disputed`. `applyTransition` checks both lists (`transitions.ts:274`, `:277`), so the server returns 409 and the UI hides the button (`order-actions.ts:61`; mobile `orders/[id].tsx:43`). **There is no dispute window anywhere.** `completed → disputed` is legal forever. **Nothing ever writes `reviewed`:** the review route only inserts into `reviews` (`review/route.ts:72-86`), so a reviewed order stays disputable. | One post-completion dispute window setting, and a statement of what a review does to dispute rights. The guarantee reuses **that** clock (§8); it never adds its own. |
| **H3** Settlement after a payout is already paid, and an atomic resolve | `raise_dispute` holds only `scheduled` payouts (`transitions.ts:325-331`). `resolveDispute` upserts the payout `onConflict: 'order_id'` with `status: 'scheduled'` (`resolve.ts:108-117`), which overwrites a `paid` row; `runPayouts` (`payout.ts:20`) then transfers again. `createTransfer` has no idempotency key (`types.ts:64-68`). `refund_full` rewrites a `paid` row to `failed` / 0 (`resolve.ts:132-136`). Step 1 (`resolve.ts:94-98`) doesn't read the row count. A crash between steps leaves the order `resolved_*` with the dispute still `open`, and every retry returns 409 (L67-68). | Settlement obeys `PAYOUT_TRANSITIONS` (`paid → []`). ADR-014 decides clawback (a Route transfer reversal) versus refusing in the console when the provider was already paid more than the settlement. An atomic claim (0 rows → `already`) and a resume path. **The make-good runs inside that claim** (§7.4). |
| **H4** Refunds that collide on the one refund row | `processRefund` looks up the refund row by `payment_id` (`transitions.ts:186-190`). If that row is **processed**, it returns the old amount and moves nothing (L192, L215). A `pending` row resumes at its stored amount (L193-194). The admin `manual_refund` (`admin/orders/[id]/route.ts:73`) goes through the same path. | Keep one refund row per order. `resolveDispute` refuses with 409 when a processed refund exists whose amount differs from the intended total. **Every caller compares the returned amount with the intended one.** The make-good depends on that read-back (§7.4). |
| **H5** GST added twice | The checkout quote branch doesn't read `gst_included` (`checkout/route.ts:217`) and always adds 18 % on top (`money.ts:42-49`). The compare screen accounts for it (`compare.ts:110-115`); checkout doesn't. Logged in `USER_EXPECTATIONS_AUDIT.md:310`. | Its own money ADR. It changes `total_paise`, which drives both the make-good bound and the order limit. Required before code (G2), not before approval. |
| **H6** Duplicate paid orders on one RFQ | `finalizeQuoteAcceptance` claims the RFQ atomically. A losing paid order is only **flagged** (`finalize.ts:189-229`, event `duplicate_rfq_order`, "ops must refund"). It stays `placed` and the provider can still accept it. The comment at `checkout/route.ts:235-236` wrongly says it refunds. | A dedicated state and a refund through `processRefund`. **The grant runs after RFQ finalisation, and an order flagged as a duplicate is never eligible** (§3). |
| **H7** Razorpay test mode with Route | Not yet run. This laptop and prod run in simulate mode (ADR-003) and have no Razorpay test keys. | See §6. Both worked examples pay out more than the payment captured. |

H1 (money logic in CI with a disposable database) and H8 (the agent runtime actually deployed) gate code (G2) and the
flag (G3) respectively. They don't gate this ADR's approval.

## 2. Decision summary (proposed defaults; the founder may change any of them at review)

- **Who:** the buyer's first paid order (per MSME, deduplicated by GSTIN and phone). Services only, with a verified
  provider in good standing whose score is at least 60, and an order of at most ₹50,000.
- **What:** a make-good of **0 up to min(₹5,000, what the buyer paid − the dispute refund)**, decided by the founder
  in the existing dispute console. There is no automation; an agent can never set, suggest or mention an amount.
- **How it's paid:** as an extra amount on the order's **one existing refund row** (`rfnd_<order_id>`, `processRefund`).
  There is no second refund mechanism and no new order state.
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
| 3 | Not flagged as a duplicate RFQ order (H6) | the H6 state or event | `duplicate_order` |
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
"up to what they paid", so both limits are measured on the same amount. H5 changes `total_paise` for GST-inclusive
quotes, which is why H5 must land before code.

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
- `makeGoodBound = min(cap, total_paid − dispute_refund)`. A make-good can top the buyer up to at most what they paid,
  never above it.
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

- **No new refund mechanism.** The make-good **adds to the amount of the order's single refund row**
  (`rfnd_<order_id>` through `processRefund`). `refunds` gains `guarantee_paise` (≥ 0, ≤ `amount_paise`) so every reader
  can label that part.
- **The provider's settlement is computed from the dispute refund only.** It uses today's formula,
  `round(earning × (total − dispute_refund) / total)` (`resolve.ts:85-90`), extracted into shared as one function that
  `resolveDispute` calls. The result is byte-identical, and a test asserts it.
- **Order status follows the resolution unchanged** (`resolved_release`, `resolved_partial` or `resolved_refund`).
  There is no new order state.
- **Route ordering stays as `resolveDispute` has it:** the provider transfer goes before the refund.
- **Invoices stay the only invoicing path.** The make-good never produces a credit note against the provider's
  invoice, and never changes the provider's TDS 194-O base.

### Worked examples (500 bps, derived from `computeOrderAmounts`; the tests derive, never hard-code)

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

### H7: what Razorpay has to allow (NOT YET RUN; blocks approval)

Both examples transfer the provider's share **and** refund more than the payment captured. Route transfers draw on the
captured payment. A refund larger than what's left needs the merchant balance to cover the gap, and a refund can never
exceed the captured amount of its payment.

Example A's refund (₹5,000) is below the capture, but the transfer (₹19,000) plus the refund (₹5,000) is above it.
Example B's refund (₹13,000) is also below the capture, and the transfer plus refund is above it.

The recorded test-mode run must answer, for a payment of ₹23,600 with a ₹19,000 Route transfer made **first**:

1. Does Razorpay accept a ₹5,000 refund on that payment after the transfer, and which balance does it debit (the
   un-transferred part of the payment, the merchant balance, or does it refuse)?
2. The same for a ₹13,000 refund after a ₹12,559.32 transfer.
3. If it refuses: does a transfer reversal work (and at what cost to the provider relationship), or does the design need
   to refund first and settle the provider from the platform balance?

**If Razorpay refuses, the one-row design can't pay a make-good, and this ADR must change before approval.** The
result, and the merchant-balance funding it implies (G3: the balance must be funded to at least the exposure cap),
will be recorded here.

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
4. **Resolve.** `POST /admin/disputes/[id]/resolve` gains an optional `makeGoodPaise`. It returns:
   - **422** above the bound, or when the guarantee isn't `claimed`
   - **422** on `refund_full` (and the guarantee becomes `void`)
   - **409** when a processed refund already exists (H4)

   Then, inside H3's atomic claim:
   - The provider settlement is unchanged (the shared formula).
   - `processRefund` receives the dispute refund + the make-good. `computeRefundPaise` gains an optional
     `makeGoodPaise`; every existing caller passes nothing and gets the same value.
   - **Read back:** the amount `processRefund` returns must equal the intended amount.
     - On a mismatch, the guarantee stays `claimed`, nothing is marked paid, and the console shows the error.
     - On a match, it sets `refunds.guarantee_paise`, inserts one `guarantee_payments` row (append-only, unique
       `order_id`), and moves the guarantee to `paid`.
   - A replayed or concurrent resolve moves no money and writes nothing.
   - The audit `after` includes `make_good_paise`.
5. **Expiry.** A step in `cron/auto-accept` (hourly, where completion happens) moves `active → expired` after
   `expires_at`, as a guarded update.
6. **Statuses.** `GUARANTEE_STATUSES = active | claimed | paid | expired | void`. Transitions: `active → claimed |
   expired | void`; `claimed → paid | void`; the rest are terminal. They live only in `state-machines.ts`.

## 8. Claim window

- Claims follow the H2 rules and ADR-014's **single post-completion dispute window**.
- `expires_at` stays null until the order completes, then is set to completion + that window, in the same place
  completion is written.
- **Reviews.** Today nothing ever sets an order to `reviewed`, so a review changes nothing. If ADR-014 makes a review
  end dispute rights (by writing `reviewed`), a review ends the claim as well. This ADR follows ADR-014 either way and
  adds no clock of its own. **Proposed for ADR-014:** a review does *not* end dispute rights inside the window, because
  a buyer shouldn't lose a remedy by being polite.

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
- **Duplicate RFQ orders (H6).**
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
- The dispute path gets hardened first (H1–H6). That is worth doing whatever happens to this ADR.
- It depends on the Razorpay behaviour recorded in §6. If that fails, the design changes before any code.
