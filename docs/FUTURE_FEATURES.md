# Future features — built but dormant

Features that are fully implemented and tested in the codebase but **switched
off behind a flag** pending a business signal. Re-enabling is a config change
(set the flag), not a rebuild of the feature.

---

## Coupons (Phase 6, A6) — DISABLED behind `COUPONS_ENABLED`

**Status:** built + verified (Phase 6 done-criteria #5 passed), then disabled by
business decision to keep the payment path minimal.

**Flag:** `COUPONS_ENABLED` (env, server-evaluated — see
`apps/web/lib/flags.ts`). Default **OFF** (`false`/unset).

**When OFF (current state):**
- Checkout coupon input is hidden; the checkout total is
  `price − listing_discount + GST` with **no coupon branch** in the money math
  (`apps/web/app/api/v1/checkout/route.ts` skips coupon lookup/evaluation
  entirely and stores `coupon_code = null`).
- `/admin/coupons` page returns 404 and the Coupons tab is removed from the
  admin nav.
- `POST /api/v1/coupons/validate` and `GET|POST /api/v1/admin/coupons` return
  404.

**What stays in the repo, dormant (do NOT delete):**
- Tables `coupons`, `coupon_redemptions` (migration 0000) + RLS.
- Evaluator `apps/web/lib/coupons/apply.ts`, redemption recorder
  `apps/web/lib/coupons/redeem.ts` (wired into the materialise path; a no-op
  when no coupon code is on the session).
- Admin UI `…/admin/coupons/CouponsClient.tsx`, checkout coupon UI in
  `CheckoutClient.tsx` (rendered only when `couponsEnabled`).
- i18n strings (`coupons`, `admin_coupons` namespaces), the `couponValidate`
  rate limiter, and `increment_coupon_usage` RPC (migration 0010).

**To re-enable:** set `COUPONS_ENABLED=true` in the environment (Vercel →
Project → Settings → Environment Variables) and redeploy. No code change. The
full Phase-6 behaviour (cap + usage limit + validity + category + paise-exact
discount + redemption recording) returns as verified.
