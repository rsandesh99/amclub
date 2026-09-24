# ADR 003 — Simulate-mode checkout in production (pre-cutover)

**Status:** Accepted (temporary), 2026-08-23. Touches money (§8.4).
**Kill condition:** retires automatically at Razorpay live cutover.
**Amended 2026-09-24 by [ADR 023](023-no-simulated-payments-on-production.md).**
- **Replaced:** simulated checkout on production. Production no longer simulates a payment: without a real gateway, every checkout entry point returns 503 `payments_unavailable`.
- **Unchanged:** previews, CI and local runs still simulate. The **cutover procedure and checklist below still apply** unchanged, and are the only way production starts taking payments.

## Context

§2.5 rule 2 makes Razorpay webhooks the only payment truth. Production
launched (2026-08-23) before Razorpay live keys were provisioned, so the
deployed app runs the mock gateway: `POST /api/v1/checkout/simulate` stands
in for the captured-payment webhook and materialises orders through the SAME
atomic `materialize_order` path. This is a deliberate, documented deviation
from the hard rule, not drift.

## Decision

Simulate mode is acceptable in production ONLY under all of these guards,
each of which exists in code:

1. `getPaymentGateway()` **throws on any `rzp_live_` key** — real money can
   not flow through the mock gateway by misconfiguration.
2. `/checkout/simulate` enforces **session ownership** (F1 fix) — only the
   buyer who created a checkout session can materialise it.
3. `/checkout/simulate` **refuses (400) the moment a real gateway is
   configured** — setting any real Razorpay keys retires the endpoint with no
   deploy.
4. Rate-limited per user (F9) and auth-required.
5. The payout approval gate (ADR 002) means no simulate-mode order can move
   real money regardless.

## Consequences

- Until cutover, "paid" orders carry no real funds; the founder must not
  release payouts for simulate-era orders (none exist — the DB was purged of
  all test orders at launch).
- Cutover procedure (one PR): remove the `rzp_live_` guard in
  `apps/web/lib/payments/index.ts`, set the four Razorpay env vars, register
  the live webhook, deploy, then confirm `/checkout/simulate` returns 400.
- **Cutover blocker — real penny-drop vendor (added 2026-08-27, Phase 1g).**
  `penny_drop_verified` is now server-set from a real `/kyc/verify-bank`
  result; the dev stub never counts. Until `KYC_API_KEY` is a real Surepass/
  Signzy key, every genuine provider sits at `bank_unverified` and the only way
  to clear them is the admin `set_bank_verified` override (audit-logged,
  `bank_account_verifications.provider = 'admin_override'`). That is acceptable
  during manual onboarding; at real-money volume the override must be the
  exception, so provisioning the vendor is a hard prerequisite of live cutover.
- **Cutover checklist (Phase 3d, 2026-08-28; procedure in
  `docs/ROUTE_ONBOARDING.md`):**
  - [ ] Route activation approved on the live Razorpay account.
  - [ ] KYC vendor provisioned (`KYC_API_KEY`) — manual bank overrides stop
        being the norm.
  - [ ] Every active provider shows **Ready to pay** in `/admin/providers`
        (Route id + verified bank), or is knowingly excluded.
- The F5 amount cross-check (captured amount must equal the frozen session
  total) applies to both simulate and webhook paths.
