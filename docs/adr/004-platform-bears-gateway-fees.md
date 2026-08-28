# ADR 004 — The platform bears Razorpay's fees out of its commission

**Status:** Accepted (founder decision), 2026-08-28. Touches money (§8.4).

## Context

Every order is split at checkout into frozen paise amounts
(`computeOrderAmounts`): taxable value, 18 % GST on top, the category
commission (5 % flat at launch) on the taxable value, and the provider's
earning = taxable − commission. Razorpay charges the platform a gateway fee on
the captured amount (≈ 2 % + 18 % GST on the fee ≈ 2.36 %; account-specific)
and, on some accounts, a Route transfer charge. Nothing in the code accounted
for that fee, so who bore it was implicit.

Worked example — a ₹100 listing at 5 %:

| | paise | ₹ |
|---|---|---|
| Taxable value | 10 000 | 100.00 |
| GST (18 %, pass-through) | 1 800 | 18.00 |
| **Captured from buyer** | **11 800** | **118.00** |
| Commission (5 % of taxable) | 500 | 5.00 |
| **Transfer to provider** | **9 500** | **95.00** |
| Est. gateway fee (2.36 % of captured) | 279 | 2.79 |
| Commission left after fee | 221 | 2.21 |

Two Razorpay Route facts constrain payment-linked transfers: (F1) no transfer
can be created on a payment after a refund has been initiated on it; (F2)
transfer amount + Razorpay's fee must fit inside the captured amount.

## Decision

1. **Providers always receive their full quoted amount minus only the 5 %
   commission.** The transfer is `provider_earning_paise`, unchanged. No
   gateway deduction ever reaches a provider.
2. **The platform absorbs Razorpay's fees out of its commission.** In the
   example the platform nets ₹2.21 of its ₹5.00 before GST-on-commission.
3. **A guard, not a redesign.** `lib/payments/fees.ts` estimates the fee
   (`RAZORPAY_FEE_BPS`, default 236) and `runPayouts` refuses — loudly, payout
   → `failed` with the numbers in the `payout_failed` event — if the transfer
   + fee would exceed the captured amount (F2) or the fee would exceed our
   commission (this ADR). It never silently shrinks a transfer.
4. **Split resolutions transfer first, then refund** (`resolveDispute`), so a
   partial refund can never block the provider's transfer under F1.

## Consequences

- Effective take rate ≈ 5 % − 2.36 % ≈ 2.6 % of taxable value at launch
  pricing; a commission below ~2.4 % would make every payout fail the guard —
  by design, so the decision is revisited here rather than discovered by a
  provider.
- Provider-facing copy on `/partner/earnings` and `/help`: "You receive your
  full amount minus only AMC's 5 % commission. All payment gateway charges are
  borne by AMC." The Provider Addendum gains the same sentence at its next
  version bump (queued in FOLLOWUPS; provider-favourable, no forced
  re-acceptance now).
- Exact fees come from settlement webhooks (FOLLOWUPS, Phase 5 remainder);
  until then the guard runs on the estimate, erring toward refusal.
