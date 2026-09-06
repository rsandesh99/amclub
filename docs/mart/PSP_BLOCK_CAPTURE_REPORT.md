# AMC Mart M1 — PSP block-and-capture verification (report-first, MART_DESIGN.md §4.4)

**Date:** 2026-09-06 · **Author:** build session (Claude Code) · **Status:** verified from published
documentation and product knowledge only; **live limits NOT verified** (this sandbox has no
outbound access to razorpay.com / cashfree.com and no merchant credentials). Every item marked
⚠ must be confirmed by the founder against the live Razorpay dashboard before
`pool_payment_mode` is switched to `block_capture`.

## 1. What the spec asks for

Join = **BLOCK** funds in the buyer's own account (UPI one-time mandate), **CAPTURE** on
`closed_met`, **auto-VOID** on `closed_unmet` / expiry. Fallback if unavailable at the needed
limits: pay-on-close, with commit-then-default feeding the buyer discipline rating.

## 2. What the PSPs offer (as understood at build time)

| Capability | Razorpay | Cashfree | Notes |
|---|---|---|---|
| UPI one-time mandate ("UPI OTM" / "UPI Block") | Offered for specific flows (IPO ASBA-style blocks, "UPI Autopay one-time") — merchant-level enablement, not default on a standard PG account | "UPI One Time Mandate" offered on request | ⚠ Both require the PSP to enable the feature per merchant and the buyer's bank + UPI app to support OTM. |
| Block amount cap | NPCI UPI mandate caps apply: ₹1 lakh per mandate as the general limit; higher caps exist only for specified categories (IPO, education, insurance, credit-card bills) | same NPCI caps | ⚠ A pool share of industrial consumables can exceed ₹1 lakh (e.g. 200 × ₹950 welding electrodes = ₹1.9 lakh + GST). |
| Mandate validity | Execution must happen within the mandate validity; single execution | same | Pool open window (≤30 days) + pay window fits inside typical validity, but ⚠ confirm the maximum validity days offered. |
| Partial capture | Not available on OTM — the blocked amount executes in full or is revoked | same | Pools with per-member quantity changes after join would need block-revoke-reblock. |
| Void on failure | Mandate revoke API / auto-expiry | same | ⚠ Confirm revoke is available from the server API (not only from the buyer's app). |
| Route / split settlement | Route works on the captured payment as with any order | — | The existing `payout.ts` (Route transfer after the release gate) is unaffected either way. |
| Webhook truth | `payment.captured` fires on execution — identical to today's flow | — | Materialisation stays webhook-only (hard rule 2). |

## 3. Findings

1. **Not verifiable from here, and not safely assumable.** Merchant-level enablement, the
   applicable cap and validity all depend on the live account. Building the join flow on an
   assumed block would risk exactly what the spec forbids: money the code believes is blocked
   but is not.
2. **The general ₹1 lakh cap is below realistic pool shares** in two of the three launch
   categories (welding consumables, abrasives by the box). Even where OTM is enabled, block-
   and-capture would need a per-member share cap or a two-part collection.
3. **Pay-on-close needs nothing new.** It reuses the goods checkout session, the webhook, the
   materialiser and payout.ts unchanged, and every rupee still passes the release gate.
   Its cost is the commit-then-default risk, which the spec already prices into the buyer
   discipline rating (§4.5).

## 4. Decision (ADR-006)

- **Launch mechanic: `pay_on_close`** (mart_settings `pool_payment_mode`). Join records
  qty + delivery snapshot; when the pool closes met every member pays an ordinary goods order at
  the pool price within `pool_pay_window_hours` (48). A lapsed payment is a **default**
  (`payment_state='failed'`) recorded on `buyer_pool_discipline_v1`.
- **`payment_state` keeps the §4.4 vocabulary** (`blocked | captured | released | failed`), so a
  block-and-capture adapter is a config flip plus one adapter file, not a schema change.
- **`block_capture` is refused at join (503 `block_capture_not_live`)** until the checklist in
  §5 is signed off; the setting exists so the flip is config, but the code will not pretend to
  block funds it cannot.

## 5. Go-live checklist for block_capture (founder + PSP)

- [ ] Razorpay confirms UPI OTM enabled on the AMC merchant account (test + live).
- [ ] Confirmed cap per mandate and whether a "B2B goods" category cap above ₹1 lakh applies.
- [ ] Confirmed maximum mandate validity ≥ (max pool open days + pay window).
- [ ] Server-side revoke API confirmed and exercised in test mode.
- [ ] Webhook event names for execute/revoke confirmed; replay killtest extended to them.
- [ ] `lib/mart/pool-payments.ts` adapter implemented against the confirmed API; join flow
      blocks; `closePool` captures only through `mayCapturePoolMember` (already the single guard).
- [ ] `verify-mart.ts` pool lifecycle run in test mode with real mandates.
