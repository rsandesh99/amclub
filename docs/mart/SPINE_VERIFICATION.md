# AMC Mart — spine verification report (MART_DESIGN.md §1, session step 1)

**Date:** 2026-09-05 · **Branch:** `claude/new-github-repo-setup-ax25ub` · **Posture:** parallel dark build, `MART_ENABLED=false` in prod.

MART_DESIGN.md §1 lists facts about the live services spine and instructs: *verify, report, then build. Where the repo and this document disagree, trust the repo and report the difference.* This is that report. Every row was checked against the code on `master` (commit `23346fe`) before the first Mart file was written.

## 1. Facts verified

| # | Claim (MART_DESIGN.md §1) | Where in the repo | Verdict |
|---|---|---|---|
| 1 | Turborepo: `apps/web`, `apps/mobile`, `packages/db`, `packages/shared` | `pnpm-workspace.yaml`, `turbo.json` | ✅ |
| 2 | Live flow: voice RFQ → quotes (gst_included, transport_included, valid_until, advance_percent) → order → milestone/delivery evidence → 72h auto-accept → founder-released payout | `lib/voice/*`, migration `0018_quote_terms.sql`, `lib/orders/transitions.ts`, cron `auto-accept`, `admin/payouts/[id]` | ✅ |
| 3 | `payout.ts` is the only money-out path; refunds insert-first keyed `rfnd_<order_id>`; fee-headroom guard; `PAYOUT_AUTO_RELEASE` off | `lib/payments/payout.ts`, `processRefund` in `transitions.ts`, `lib/payments/fees.ts`, `lib/flags.ts`, ADR-002/004 | ✅ |
| 4 | `order_events`, `quote_events` append-only at DB level (trigger + REVOKE + read-only RLS) | migrations 0016, 0017, 0019 | ✅ |
| 5 | `audit_logs` append-only at DB level | `policies.sql` (admin-read policy only) | ⚠️ **Not enforced at DB level** — no `BEFORE UPDATE` trigger, no REVOKE. Append-only by convention (service role writes). See §3.1. |
| 6 | Trust: `provider_score_inputs_v1`; nightly `median_response_minutes` with ≥3-sample gate; no fabricated stats | migration 0016/0020, cron `provider-stats` (`MIN_RESPONSE_SAMPLE`) | ✅ |
| 7 | `provider_profiles` is the single seller entity; `readiness.ts` is the single payout-readiness definition; GSTIN verification exists in onboarding | `lib/payments/readiness.ts`, `/kyc/verify-gstin`, `gstin_verifications` (0021) | ✅ |
| 8 | `LEGAL_VERSIONS` + `terms_acceptances` append-only; grievance page; disclosure doctrine | `packages/shared/src/legal.ts`, migration 0017, `(public)/grievance` | ✅ |
| 9 | RULES.md constitution (additive migrations, phase gates, zero residue, visible-markup assertions) | `RULES.md` | ✅ |
| 10 | S2 pre-land: `orders.kind` / `checkout_sessions.kind` exist with default `'service'` and **no writer** | migration 0020 | ✅ — 0022 adds the writer (goods checkout) and the copy inside `materialize_order`. |

## 2. What M0 built on top (all behind `MART_ENABLED`)

- **Shared** (`packages/shared/src/mart/*`): product/pool state machines, goods money math (`computeGoodsOrderAmounts`, per-line GST + per-line commission), release gate (`evaluateGoodsReleaseGate`), Zod schemas, `ai_decisions` helpers. 27 unit tests, incl. an inertness test that pins the services order machine byte-for-byte.
- **DB** (`0022_mart_catalog.sql`, STAGED): `mart_categories`, `mart_settings`, `products`, `price_tiers`, `product_events` (append-only), `ai_decisions` (append-only), `provider_profiles.sells_goods`, `orders/checkout_sessions.line_items + delivery_snapshot`, `payouts.tds_*`, `order_safe_view` rebuilt verbatim, `materialize_order` restated with three copied columns. RLS from birth; mirrored in `policies.sql` under a guard that skips when 0022 is absent (so `apply-rls` stays runnable against prod during the dark build).
- **Web API** (`/api/v1/mart/*`, hard-404 when the flag is off): public catalog, goods checkout (server totals), goods order actions, seller catalog CRUD + activation gate + Catalog Agent draft + image upload, admin listing queue + payout-evidence dossier. Inert branches in `transitions.ts` (goods guard, goods hold reasons + TDS), `resolve.ts` (`return_resolved`), `invoices/generate.ts` (goods invoice in AMC's name with HSN lines), `admin/payouts/[id]` (release refused while the goods gate holds).
- **Web UI**: Emerald & Brass tokens + Goldsmith-motion CSS layer (additive), `/mart`, `/mart/p/[id]`, `/app/mart/cart`, `/app/mart/checkout`, `/partner/goods` (+ new/edit wizard with per-field confirm → `ai_decisions`), `/admin/mart` (+ dossier), goods branch of the order workspace (gold-thread timeline). `mart` + `admin_mart` i18n namespaces in en/hi/te.
- **Mobile**: Mart tab shown only when `/profile/me.martEnabled` is true; browse, product, cart/checkout.

## 3. Discrepancies and decisions (repo wins; recorded here)

1. **`audit_logs` is not DB-level append-only** (claim §1 row 5). Not touched in M0 — it is a services table and the fix is a one-line trigger migration (`raise_append_only()` already exists). Logged in `docs/FOLLOWUPS.md`.
2. **`gst_rate` is stored as basis points (`gst_rate_bps`)**, not a percentage column named `gst_rate`, matching the repo's `DEFAULT_GST_BPS` / `commission_bps` convention. Line items carry `gst_rate_bps`.
3. **Product status gains `pending_approval`** (doc: `draft|active|suspended`). "Sent for approval" is a queryable state the admin queue needs; transitions are `draft → pending_approval → active | draft`, `active ↔ suspended`. Additive.
4. **Goods `dispatch` passes through `requirements_submitted`.** The services machine has no `accepted → in_progress` edge and it may not be repurposed (RULES.md 11). The delivery snapshot captured at checkout *is* the requirement, so `dispatch` performs the two legal steps `accepted → requirements_submitted → in_progress`, emitting both events. Buyer cancellation therefore stays `placed | accepted` (pre-dispatch), exactly as services.
5. **Returns ride the dispute machinery.** `open_return` = `delivered | completed → disputed` (both legal), `disputes.reason = 'return:<reason>'`, event `return_opened`; the existing admin dispute console resolves it through the proven refund path and `resolve.ts` emits `return_resolved`. No second money path.
6. **Fresh-bootstrap helper ordering (FOLLOWUPS open item) is fixed** in `bootstrap.ts`: the helper-function section of `policies.sql` runs as a prelude (with `check_function_bodies = off`) so 0016/0017/0021/0022's inline policies resolve `auth_user_id()`/`has_role()`. The bare-Postgres shim now also emulates Supabase's default table grants — without it, every REVOKE-based killtest passed vacuously.
7. **`policies.sql` re-applies 0004's provider column grant list on every run**, which silently strips any later column grant. `sells_goods` (needed by the public catalog policies) is re-granted inside the guarded Mart block. Any future public-read column on `provider_profiles` must do the same.
8. **`0004`'s column list omits `years_experience`/`website`** that `policies.sql`'s copy of the list includes — pre-existing drift, not touched.
9. **E-way-bill fields are enforced, not just captured**: above `mart_settings.eway_bill_threshold_paise` a dispatch without `eway_bill_number` + `vehicle_number` is refused (422 `eway_bill_required`). Generator integration remains M3.
10. **Founder decisions §9.2/§9.3 are config placeholders**: every launch category is seeded with `return_window_hours = 48` and `commission_bps = 500`; the code reads `mart_categories`, never constants. TDS is seeded at `rate_bps = 0` (section 194C, threshold ₹30,000) until the CA confirms.
11. **Catalog Agent v1 takes photos + a typed description** (any language); the Sarvam voice leg of the wizard is a follow-up (the recorder component is RFQ-specific today).
12. **Pool tables are M1.** Only the pool state machine + capture predicate ship in M0 (pure code, tested), per §7.
13. **Mobile `tsconfig` does not extend the repo base** (no `exactOptionalPropertyTypes`, etc.) — pre-existing; noted by the mobile build.

## 4. Evidence produced this session

| Check | Result |
|---|---|
| `pnpm --filter @amclub/shared test` | 67 passed (27 new in `mart.test.ts`) |
| `turbo typecheck` (web, shared, db, mobile) | clean |
| `turbo lint` | clean (one pre-existing mobile warning in `rfq/[id].tsx`) |
| Fresh bootstrap of the full chain 0000→0022 + `policies.sql` on a scratch Postgres 16 | 42 tables, 82 RLS policies |
| `packages/db/src/scripts/killtest-mart-schema.ts` against that database | 21/21 — append-only triggers raise; UPDATE/DELETE revoked; services `materialize_order` output byte-identical (`kind='service'`, goods columns NULL, replay returns the same order); goods columns copied; cross-tenant catalog reads = 0 rows; `sells_goods=false` hides listings; non-admin cannot read `mart_settings` |
| `next build` with CI placeholder env and `MART_ENABLED=true` | exit 0 |
| `verify-mart.ts` (M0 acceptance over HTTP) and `verify-mart-inert.ts` (flag-off) | **written, not run** — need a server + Supabase (see §5) |


### 4a. Review-fix and optimisation sprint (2026-09-06)

- Lighthouse reports (mobile, local production build, seeded rig):
  simulated 4G before (`lh/baseline`) and after (`lh/final1..3`, medians
  reported in FOLLOWUPS.md), and DevTools-throttled after (`lh/final-dt`:
  LCP 1.8 s /mart, 1.8 s product, 1.6 s /services, CLS 0.000). Reports live in
  the session rig (`/tmp/amclub-local/lh/`), numbers copied to FOLLOWUPS.md.
- Font bytes on English pages 209–313 KB → 39 KB (rupee-glyph face, system
  chips, `display: optional`, no web-font names as fallbacks).
- Head hints verified with curl on /mart: `<link rel="preconnect">` for the
  Supabase origin and `<link rel="preload" as="font">` for both fonts.
- Chunk audit via the client-reference manifests: gateway wizard no longer
  in the /mart, /services or product script lists; `shell` chunk shared.
- Inertness unchanged: `pnpm --filter @amclub/shared test` 67/67;
  `turbo typecheck lint` green (one pre-existing mobile lint warning,
  FOLLOWUPS "Mobile lint warning"); `next build` green.
- After-screenshots of the twelve review screens re-taken (browse, category
  sorted, search, product, prefilled checkout, buyer/seller order pages,
  wizard confirm, storefront, desktop browse, cart) and embedded in the
  review artifact's "Sprint outcome" section.


### 4b. M1 — pools (2026-09-06)

- Schema killtest `packages/db/src/scripts/killtest-mart-pools.ts`: 16/16.
- API lifecycle + expiry/capture-fail scripts (session rig): 37/37 and 12/12;
  every replay idempotent; blocked commitments never captured on unmet or
  lapsed pools (`mayCapturePoolMember` is the single guard).
- Inertness: no services file changed; the cron returns `skipped` when
  `MART_ENABLED=false`; 0023 is staged with 0022; `policies.sql` block guarded.
- Money path unchanged: member payment = ordinary goods checkout session →
  webhook → `materialize_order` → `payout.ts`. No consolidated-order path.

### 4c. M2 — goods RFQ (2026-09-06)

- Schema killtest `packages/db/src/scripts/killtest-mart-goods-rfq.ts`: 14/14
  on the local killtest database — `kind` default + enum, the mutually
  exclusive `rfqs_kind_shape_check` (a services row cannot carry Mart columns;
  a goods row cannot carry `category_id`), the Mart-category FK, and
  `quotes_goods_terms_check` (all-or-nothing terms, GST slab, HSN shape,
  `price_paise = unit × qty`, listing delete → `product_id` SET NULL).
  Two constraint gaps found by the killtest and fixed in the STAGED 0024
  before anything shipped: a CHECK that evaluates to NULL passes, so
  "unit price only" and "goods RFQ with a services category" both slipped
  through until every term got an explicit `IS NOT NULL`.
- API lifecycle (session rig, local production build, `MART_ENABLED=true`):
  30/30 — services RFQ fans out to the services provider only and its quote
  keeps the client price; goods terms on a services RFQ → 422; goods RFQ
  without a spec → 422; BIS-blocked category → 422; fan-out reaches the
  in-state goods seller with a listing in the category only (never the
  services provider, never the out-of-state seller), and every in-state
  goods seller when nothing is listed; goods quote without terms → 422; a
  linked listing outside the category → 422 `listing_mismatch`; the quote
  row stores `price_paise = 500 × 850` with the client's total ignored; the
  buyer view carries server money (taxable 4,25,000 / GST 76,500 / incl.
  5,01,500 / after ITC 4,25,000 paise); accept → `checkout_sessions.kind='goods'`
  with one line + delivery snapshot → simulate → `orders.kind='goods'` linked
  to the quote; RFQ and quote `accepted`; re-accept 409; simulate replay
  creates no second order; the seller reads the order through the ordinary
  orders API; a spec-only quote with a seller-adjusted qty prices 5 × 3,20,000.
  `apps/web/scripts/verify-goods-rfq.ts` is the founder-environment form of
  the same suite (creates its own users; zero residue).
- Inertness: `pnpm --filter @amclub/shared test` 80/80; web + mobile
  typecheck and lint clean (the pre-existing mobile lint warning is gone);
  `next build` green; the goods branch of `POST /api/v1/rfq` returns 404 when
  the flag is off and the services branch is byte-identical; 0024 is staged
  with 0022/0023 (`verify-migrations.ts`).
- Screenshots (session rig `shots-goods-rfq/`): goods RFQ form prefilled from
  a listing (en + te), buyer detail with spec card and unit-price / GST /
  after-ITC compare row, seller detail with the goods composer and with a
  submitted goods quote, both inboxes with goods badges, product-page
  "Ask for a bulk quote", empty-search entry point, the resulting goods order.

### 4d. Launch Gate readiness (2026-09-06)

- **Founder decisions as config.** `/admin/mart/settings` edits every
  `mart_settings` key against the closed registry in
  `packages/shared/src/mart/settings.ts` (per-key Zod) and every
  `mart_categories` row (§9.2 return window + return-freight payer, §9.3
  commission); every write is audited (`mart_setting_update`,
  `mart_category_update`, stable uuid entity ids for text-keyed rows).
  Migration 0025 (STAGED) adds `return_freight_payer`. Rig killtest 24/24:
  anon 401, buyer 403, unknown key 422, bad enum / range 422, strict category
  patch, audit rows with before/after, the running money path reading the new
  value (cart preview `deliveryDays`, `returnWindowHours`), the product page
  showing the freight note, and the addendum surfaces below.
- **Addendum goods schedule tied to the flag.** `effectiveLegalVersions({martEnabled})`
  bumps only `provider_addendum` to `2026-09-06` when `MART_ENABLED=true`; every
  server consumer (acceptance rows, `/legal/status`, rendered date, the gate
  modal) reads the effective version; `/provider-addendum` renders sections
  6–8 only with the flag; `/api/v1/legal/versions` is public for the preflight.
  Flag off = services version, nobody re-prompted (shared test).
- **Acceptance bundle on the rig, flag ON** (`pnpm --filter @amclub/web mart:acceptance`,
  rig gateway extended with a fake auth admin API so the committed suites run
  unchanged): verify-mart 57/57 (first run of the M0 suite outside the
  founder's environment), verify-goods-rfq 24/24 (made robust to shared
  databases: membership, not exact match sets), DB killtests 21/21 · 16/16 · 14/14.
- **Preflight + smoke + runbook.** `mart:preflight` (read-only, `EXPECT_FLAG`)
  checks flag delivery, 0022–0025, every registry key, categories,
  `pool_categories` ⊆ active, addendum version/sections, seed sellers with
  approved listings, pilot buyers, aged/failed payouts, open disputes;
  `mart:smoke` drives one real internal goods order with a pause for the live
  payment; `docs/mart/LAUNCH_RUNBOOK.md` is the flip procedure with rollback.
- **Inertness, flag OFF** (rig rebuilt with `MART_ENABLED=false`):
  `mart:acceptance -- --inert` 45/45; `mart:preflight EXPECT_FLAG=off`
  19 pass / 3 warn / 0 fail. **Finding fixed on the way:** the public Mart
  pages answered **200 with the 404 UI** while the flag was off. Every route
  group (`(public)`, `(msme)`, `(provider)`, `(admin)`) streams through a
  group-level `loading.tsx`, so a `notFound()` thrown by a Mart page or a
  Mart segment layout arrives after the 200 headers. The four Mart subtrees
  now live in their own route groups — `(mart-public)/mart`,
  `(mart-msme)/app/mart`, `(mart-provider)/partner/goods`,
  `(mart-admin)/admin/mart` — whose layout calls `martPageGate()` before
  rendering the parent group's shell, so the whole subtree is a real 404
  before anything streams. URLs unchanged; `lib/mart/revalidate.ts` paths
  updated. This had been masked in 4a/4b because the earlier inert runs
  pre-dated the streaming skeletons.
- **Preflight, flag ON** (rig): 21 pass / 2 warn (TDS rate unconfirmed,
  counsel sign-off) / 0 fail.

## 5. Not done here (needs the founder's environment)

- Run `mart:acceptance` against a Vercel preview with `MART_ENABLED=true` on a STAGING Supabase project with 0022–0025 applied (the rig run above proves the suites; the preview run proves the deploy), and `mart:acceptance -- --inert` + the four standard suites against prod (flag off).
- `mart:preflight` with `EXPECT_FLAG=off` against prod today, then `EXPECT_FLAG=on` after the enabling deploy; `mart:smoke` on flip day (real payment).
- Apply 0022–0025 **only** at the Launch Gate (§8.2). `verify-migrations.ts` treats them as `staged`: set `MART_MIGRATIONS_EXPECTED=false` when verifying prod during the build.
- Counsel review of addendum sections 6–8 (§9.5 liability caps / indemnities) — the version bump itself is automatic with the flag.
- Founder decisions §9.1–9.5, encoded in `mart_categories` / `mart_settings` / ADR.
