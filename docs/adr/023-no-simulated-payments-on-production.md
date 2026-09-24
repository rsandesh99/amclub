# ADR 023 — No simulated payments on the production deployment

**Status:** Accepted 2026-09-24. **Money-safety hotfix** (CLAUDE.md §2.5 rule 2: webhooks are the only payment truth). Found in the go-live check, when the payouts cron on production logged "Razorpay secret not set — using SIMULATION gateway".

## Context

`getPaymentGateway()` returns the simulation mock whenever `RAZORPAY_KEY_ID` or `RAZORPAY_KEY_SECRET` is missing or a placeholder. In simulation:

- checkout returns `simulated: true`;
- the client then calls `POST /api/v1/checkout/simulate`;
- that route materialises a **paid** order through the same idempotent path the webhook uses. No money is captured.

That is intended on previews, in CI and in local drills. The simulate route only refused once real keys were present. So on production, a missing or mistyped secret meant any signed-in buyer could place a paid order for free. The order would be a client-triggered "capture", which is exactly what rule 2 forbids.

Payouts were created `held`, and simulated transfers move no money, so no funds could leave. But a provider could have done real work for an order nobody paid for.

## Decision

1. **`paymentsAvailable(gatewayIsReal, VERCEL_ENV)`** lives in `apps/web/lib/payments/simulation.ts`. It is false only when the gateway is the mock **and** `VERCEL_ENV === 'production'`.
   - Previews (`preview`), CI, the money rigs and local runs have no production `VERCEL_ENV`, so they keep simulating.
2. **Every checkout entry point refuses with 503 `payments_unavailable` when payments are unavailable:**
   - `POST /api/v1/checkout` (services, packages and quotes), before any session is created;
   - `POST /api/v1/mart/checkout`;
   - `POST /api/v1/mart/pools/[id]/checkout`;
   - `POST /api/v1/checkout/simulate` itself.
3. **The buyer sees `checkout.err_payments_unavailable`** in en, hi, te and ta: "Payments are not available right now … you have not been charged."
4. **`verify-money-loop`** asserts the truth table on every PR.

## Relationship to ADR 003

[ADR 003](003-simulate-mode-in-production.md) (accepted 2026-08-23) deliberately allowed simulated checkout on production before the Razorpay cutover. Its guards protected **money**:
- no live key can reach the mock;
- sessions are owner-only;
- the endpoint retires once real keys exist;
- every payout waits for the founder's release (ADR 002).

This ADR amends it. The first draft of this ADR was written without citing ADR 003; this section records the reversal and the reason.

**Why:** since 2026-09-24 every Experience v3 surface is on in production and real providers are being approved. A simulated "paid" order no longer moves money, but it does send a **real provider to do real work** for an order nobody paid for. ADR 003's guards never covered that.

**What stays from ADR 003:**
- the cutover procedure and checklist (Route activation, KYC vendor, every provider "Ready to pay");
- the `rzp_live_` guard, which the cutover PR removes;
- simulation everywhere except the production deployment.

**Razorpay test keys on production** make checkout work again, through Razorpay's test mode. Test card and UPI details are public, though, so an order paid that way carries the same unpaid-work risk as a simulated one. Test mode on production is for demos before any real provider accepts orders. The recorded test-mode run (H7) belongs on a preview deployment. Real providers take orders once the live cutover is done.

## Consequences

- A production deploy with a missing or placeholder Razorpay secret cannot take orders. It fails closed, with a clear message, instead of giving goods and services away.
- Fixing the secret in Vercel and redeploying restores checkout with no code change.
- Live keys (`rzp_live_…`) are still refused by `getPaymentGateway()` (the Phase 4 guard). Lifting that guard is the Phase 9 launch step and gets its own change.
- **Rollback:** revert the commit. That reopens free simulated orders on production and is not recommended.
