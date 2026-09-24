# AMC Mart — Launch Runbook (Launch Gate §8)

**Owner:** founder (flips the flag). **Engineering support:** whoever ran the last acceptance.
**Posture:** Mart is a dark build. Nothing in this runbook changes services behaviour; the
only prod-visible change is `MART_ENABLED=true` plus the staged migrations that ship with it.

---

## 0. What "ready" means (MART_DESIGN.md §8, all six)

| # | Gate item | How it is proven | Who |
|---|---|---|---|
| 1 | M0–M2 acceptance green on a preview with the flag ON; inertness proven with it OFF | `pnpm --filter @amclub/web mart:acceptance` against the preview; `… mart:acceptance -- --inert` against prod | eng |
| 2 | Staged migrations 0022–0025 and 0069 applied **with** the enabling deploy | Step 3 below; `verify-migrations.ts` with `MART_MIGRATIONS_EXPECTED=true` afterwards | eng |
| 3 | Founder decisions §9 encoded in config | `/admin/mart/settings` (every write audited); preflight item 3 | founder |
| 4 | Provider addendum goods schedule shipped via the version bump | Automatic with the flag (`effectiveLegalVersions`); counsel sign-off on sections 6–8 first (`docs/COMPLIANCE.md`) | founder + counsel |
| 5 | Seed supply: founder's plant + 2–3 distributor sellers with approved listings; Kurnool pilot buyer list | preflight item 5 (`SEED_SELLERS_MIN`, `PILOT_STATE`) | founder |
| 6 | Services baseline healthy at flip time | preflight item 6 + the four services suites; never flip during an incident | eng |

The preflight (`pnpm --filter @amclub/web mart:preflight`) checks everything above that a
machine can check and prints the rest. It is read-only and safe to run any number of times.

---

## 1. T-7 days — decisions and copy

1. Founder answers §9 in `/admin/mart/settings` on the **preview** deployment (flag ON there):
   - §9.2 return window (hours) and return-freight payer per category.
   - §9.3 commission bps per category (500 = 5 %). Flat 5 % = leave every row at 500.
   - §9.4 `pool_categories` (three consumables) and the seed distributor sellers.
   - §9.1 is decided (ADR-006): `pool_order_model = per_member`, `pool_payment_mode = pay_on_close`.
   - CA fills `tds` (section, rate_bps, threshold) — leave `rate_bps = 0` only if the CA says so.
   The same values are re-entered on prod after the migrations apply (step 3.4) — export them
   from the preview's audit log or keep the founder's sheet.
2. Counsel reviews addendum sections 6–8 (`messages/en.json` + `hi.json`, `provider_addendum_s6..s8`)
   and adds liability caps / indemnities (§9.5). Ship the copy change as an ordinary PR; the
   version constant `PROVIDER_ADDENDUM_GOODS_VERSION` moves to the review date.
3. Seller onboarding: founder's plant + distributors activate goods (verified GSTIN), submit
   listings, admin approves them on the preview. Their prod accounts are created the same way
   after step 3.

## 2. T-1 day — acceptance

```bash
# Preview deployment with MART_ENABLED=true and 0022–0025 + 0069 applied to a STAGING database
BASE_URL=https://<preview>.vercel.app pnpm --filter @amclub/web mart:acceptance
# Prod (flag OFF) — proves nothing leaks and services are byte-identical
BASE_URL=https://amclub.in pnpm --filter @amclub/web mart:acceptance -- --inert
# The four services suites against prod (S1 convention)
pnpm --filter @amclub/web exec tsx scripts/verify-authz.ts
pnpm --filter @amclub/web exec tsx scripts/verify-money-loop.ts
pnpm --filter @amclub/web exec tsx scripts/verify-rfq.ts
pnpm --filter @amclub/web exec tsx scripts/verify-te-render.ts
# Preflight, expecting the flag OFF today
BASE_URL=https://amclub.in EXPECT_FLAG=off pnpm --filter @amclub/web mart:preflight
```

Stop if any suite is red or the preflight has a FAIL. WARN rows are the founder's call.

## 3. Flip day — procedure (≈ 30 minutes, low-traffic window)

1. **Freeze.** No other deploys. Confirm `/admin/payouts` has no aged held payouts and no
   open incident (preflight item 6).
2. **Apply migrations** to prod in order, each idempotent: `0022_mart_catalog.sql`,
   `0023_mart_pools.sql`, `0024_mart_goods_rfq.sql`, `0025_mart_launch_config.sql`,
   `0069_mart_storefront_v2.sql` (E16: typed attributes, promises, samples, returnable / ITC flags,
   reorder reminders — Mart tables only), then `rls/policies.sql`. Use `packages/db/src/scripts/apply-sql.ts` with `DATABASE_URL`, or
   the Supabase SQL editor. Then:
   ```bash
   MART_MIGRATIONS_EXPECTED=true pnpm --filter @amclub/web exec tsx scripts/verify-migrations.ts
   ```
   Migrations are additive; services keep running unchanged with the flag still OFF.
3. **Set `MART_ENABLED=true`** in the Vercel production environment and **deploy**. Also set the
   Mart cron (`pool-close`) if it is scheduled per environment.
4. **Encode §9 on prod** at `/admin/mart/settings` (values from step 1.1). Approve the seed
   sellers' listings in `/admin/mart`.
5. **Preflight, expecting ON:**
   ```bash
   BASE_URL=https://amclub.in EXPECT_FLAG=on pnpm --filter @amclub/web mart:preflight
   ```
   Every provider is now asked to re-accept the addendum on their next load (item 4).
6. **Smoke one real internal order** (founder's buying entity → founder's plant):
   ```bash
   BASE_URL=https://amclub.in \
   SMOKE_BUYER_EMAIL=… SMOKE_BUYER_PASSWORD=… \
   SMOKE_SELLER_EMAIL=… SMOKE_SELLER_PASSWORD=… \
   SMOKE_PRODUCT_ID=<listing uuid> SMOKE_PHOTO=./evidence.jpg \
   pnpm --filter @amclub/web mart:smoke
   ```
   The script pauses for the real payment in the browser, waits for the webhook, then drives
   accept → dispatch (photo + invoice) → deliver (photo) → buyer receipt, and reports the
   payout as **held** behind the release gate with its reasons. After the category window
   closes, release it from the order's dossier and confirm the seller's bank credit.
7. **Announce** to the pilot buyer list only after step 6 releases cleanly.

## 4. Rollback

- **Kill switch:** set `MART_ENABLED=false` and redeploy. Every Mart page 404s, every
  `/api/v1/mart/*` route 404s, the nav entries disappear, mobile hides the tab on its next
  `/profile/me`, the cron returns `skipped`, the addendum reverts to the services version
  (no provider is re-prompted), and goods orders already placed stay visible on the ordinary
  orders surfaces so money keeps moving under the same rules.
- **Migrations stay.** They are additive and inert with the flag off (proven by the inert
  suite). Do not drop them.
- **Money:** nothing in the flip touches services money paths; a goods order in flight
  completes through the same webhook → payout path with the gate. If a goods payout must
  be stopped, hold it in `/admin/payouts` like any other.

## 5. After launch (first week)

- Daily: `/admin/mart` listing queue, goods orders dossier, aged held payouts.
- `pnpm --filter @amclub/web mart:preflight` once more after the first real payout releases.
- Log every founder decision change as an audit row (automatic) and, where it changes a
  rule, an ADR.
- M3 (courier API, ONDC, benchmark pricing, vision QC) is traction-gated — start it from the
  numbers, not the calendar.
