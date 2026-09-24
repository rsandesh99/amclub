# Architecture and security audit — 2026-09-24

**Scope:** the whole monorepo at master `aae7f50` (apps/web, apps/mobile, apps/agent-runtime, packages/shared, packages/agent-core, packages/db, CI and infra config), plus a read-only look at the production Supabase project (grants, view options, advisors).
**Method:** a team of 148 AI agents, run as one orchestrated workflow; details under "How the audit ran".
**Result:** 166 raw findings. After adversarial verification, **98 were confirmed**, and they collapse into **66 unique issues**: 2 critical, 10 high, 45 medium and 9 low. One medium was refuted and is recorded as a data-classification note. 67 low / info observations were not put through verification and are listed in Appendix B.

## Summary

The money core is well built. Payments trust only the HMAC-verified webhook, `materialize_order` is atomic and replay-safe, prices are computed only on the server, and ADR 018 / 022 closed the money tables. The agent confirm gates are enforced in code, not in prompts. The serious problems sat **around** that core:

1. **Critical, now fixed on production: provider and catalog tables were client-writable** (C1, C2, H1, H2, M18). Supabase's default privileges grant `ALL` to `anon` and `authenticated` on every new table and view. ADR 018 revoked that for the money tables, but the provider and catalog tables kept it. With only the public anon key, anyone could rename, re-rate or delete any live provider through the `public_providers` view. Any signed-in user could create an **active** provider profile (skipping verification), lift a suspension, or join credential-gated categories and receive those buyers' requests. Migration **0072** closed all of this on production on 2026-09-24, and a catalog query confirmed the result. The `packages` part (0073) followed once PR #58 was live, the same day.
2. **High: unauthenticated inbound endpoints.**
   - The Supabase SMS hook (H3) sends a real OTP SMS to any number for anyone who calls it.
   - The WhatsApp webhook (H4) skips its signature check when the driver falls back to `stub`.
3. **High: money-path robustness.**
   - A second, weaker payout release path exists (H5).
   - Order status writes are not compare-and-set (H6).
   - Refunds that fail are never retried (H7).
   - Payout transfers are not idempotent (H9).
   - Invoices crash on Indic names (H8).
   
   None of these moves money without a person or a cron acting. Each can pay twice, pay against a dispute, or strand a refund once real volume arrives.
4. **High: dependency advisories.**
   - sharp (H10) decodes untrusted uploads.
   - next (M27) and next-intl (M25) are below their patched releases.
5. **Medium themes:**
   - Delegated agent tokens are accepted by default on admin and write routes (M7, M8).
   - Suspended providers keep their powers (M13).
   - Verification proves a number exists, not that the caller owns it (M12).
   - Coupons are enumerable and not atomic (M10).
   - Contact masking has gaps (M30, M40).
   - Ops blind spots: heartbeats, timeouts, the 100-payment reconcile, Upstash failing closed (M32–M39).

## What was already done

| Action | Where |
|---|---|
| Reproduced C1 / C2 / H1 / H2 / M18 on a scratch Postgres 16 with the same grants and policies. Proved 0072 + 0073 close every hole, keep owner and public reads, and re-run cleanly | local |
| Wrote migration **0072**: `public_providers` SELECT-only; no client writes on `provider_profiles`, `provider_categories`, `products`, `price_tiers`; `buyer_pool_discipline_v1` becomes `security_invoker` with no client grant | PR #58 |
| **Applied 0072 to production** (approved by the founder) and verified the grants and view options with a read-only query. The security advisor's definer-view count dropped from 2 to 1; the one left is the deliberate public projection `public_providers` | production |
| Wrote migration **0073** (`packages`). The partner package routes now check ownership on the session client and write with the service role. **Applied to production** once #58 was live; clients hold SELECT only | PR #58, production |
| Added `verify-authz` §7a6 (every denial asserted as an error, plus owner-read controls) and route checks in `verify-experience` E2b | PR #58 |
| ADR 025 and a CLAUDE.md rule: every new table or view gets an explicit grant decision | PR #58 |

## Remediation plan

Each wave is one or more PRs, and each PR runs the money rigs. Nothing here changes the order state machine's transitions.

| Wave | Items | Notes |
|---|---|---|
| **0 — done** | C1, C2, H1, H2, M18 | 0072 and 0073 live |
| **1 — inbound and dependencies (in review)** | H3 SMS hook signature (Standard Webhooks, +91 only; closed once the secret is set); H4 WhatsApp webhook fails closed without a verified signature; M6 `safeNext` control characters; H10 sharp, M27 next, M25 next-intl upgrades; M1 revoke `generate_order_number` from clients; the advisor items (revoke EXECUTE on internal definer functions from anon, pin `search_path`) | H3 needs a `SEND_SMS_HOOK_SECRET` in Vercel and the Supabase hook config |
| **2 — money path (in review: H5–H9, M19, M39)** | H5 `retry_payout` goes through the one release gate; H6 compare-and-set on every order status write, with side effects only for the winner; H7 durable refund retry plus an admin "finish refund"; H9 transfer idempotency key plus a gateway lookup before retry; M19 release re-checks status and open disputes; H8 an Indic-capable invoice font; M20 / M39 reconciliation of refunds, transfers and all pages; M21 session expiry at capture; M2 no simulation gateway on production for refunds and payouts; L1 | Each item adds a money-rig criterion (CLAUDE.md H1 rule) |
| **3 — authorisation and abuse (in review: M3, M7–M9, M10 part 1, M13, M17)** | M7 / M8 delegated tokens refused unless a route opts in; M13 suspension enforced in `resolveActor`; M9 review flags go to a queue; M10 coupons: no public read, atomic redemption, per-buyer limit; M12 ownership checks on Udyam and penny-drop; M22 self-dealing guard; M17 clarification provider id hidden; M5 / L2 attachment and certificate paths pinned; M3 no token renewal from a delegated token | M12 touches KYC, so an ADR is needed |
| **4 — Mart, pools and agents** | M14 return window; M15 rationale off the public API; M16 re-review on material edits; M44 / M45 / L9 pool quote and offer sealing; M41–M43 WhatsApp binding, Munshi "yes" routing, trusted-part hygiene; M23 / M24 residency and budget; L3 runtime service-role scope | Several are dark features; fix before their cohort widens |
| **5 — operations and architecture** | M32–M38 (queue creation, stuck-inbound alert, media caps, failing heartbeats, Upstash fail-open for reads, timeouts, re-drive); M28 / M29 / M30 (state-machine enforcement, one money-formula home, one masking rule set); M31 (a CI job with production flags, web unit tests); M26 (pin actions, OIDC for Fly); L4–L8; the performance advisor (119 unindexed foreign keys, the `notifications` index) | |

## How the audit ran

- **10 specialist teams**, each told to read code rather than grep it and to cite file:line evidence:
  - three authorisation teams (admin / cron / misc; buyer flows; provider and Mart);
  - database (RLS, grants, functions, views, storage);
  - payments and money integrity;
  - AI agents and LLM security;
  - web application security;
  - supply chain, CI/CD and mobile;
  - architecture and code health;
  - reliability, scalability and operability.
- **Adversarial verification.** Every critical finding went to 3 independent skeptics told to refute it; high findings got 2 and medium findings got 1. A finding survived only with a majority upheld, and a verifier could adjust its severity.
- **A completeness critic** named what no team had covered. That produced four more audits: server-rendered pages that pass service-role data to client components; agent-runtime job handlers and WhatsApp identity binding; S3.4 demand pools; and web-side agent libraries with the deferred-release RFQ lifecycle.
- **Production** was only read: grants, view options and the Supabase security and performance advisors. The one change made to production was applying 0072 after the founder approved it.

**Limits:**
- There was no dynamic penetration test against the live site and no load test in this pass (see `docs/LOAD_TEST.md`).
- The mobile app was reviewed as code only.
- Low and info observations were not verified (Appendix B).

## Index

| ID | Issue | Status |
|---|---|---|
| C1 | `public_providers` was writable with the public anon key | Fixed |
| C2 | Any signed-in user could create or rewrite a provider profile (self-activation, lifting a suspension, fake trust badges) | Fixed |
| H1 | Sellers could write Mart `products` / `price_tiers` directly (self-approval, reversing a suspension, BIS-blocked items) | Fixed |
| H2 | Providers could join any category directly, including credential-gated ones, and receive those RFQs | Fixed |
| H3 | The Supabase "Send SMS" hook is unauthenticated: SMS pumping, SMS bombing, branded smishing | Fixed in code (wave 1); needs `SEND_SMS_HOOK_SECRET` |
| H4 | The WhatsApp webhook accepts unsigned requests whenever the driver resolves to `stub` | Fixed in code (wave 1) |
| H5 | Admin "Retry payout" releases held payouts past the dispute hold and the release gates | Fixed in code (wave 2, ADR 026) |
| H6 | Order status writes are not compare-and-set, so crons can overwrite a dispute or revision and still run money side effects | Fixed in code (wave 2, ADR 026) |
| H7 | A refund that fails after the status write is never retried, and ops cannot finish it from admin | Fixed in code (wave 2, ADR 026) |
| H8 | Invoice PDF generation throws on Indic-script names, so no tax invoice is created and accept-delivery returns 500 | Mitigated (wave 2, ADR 026); Indic rendering open |
| H9 | Payout transfer is not idempotent: a timeout after Razorpay creates the transfer marks it failed, and a retry pays again | Fixed in code (wave 2, ADR 026) |
| H10 | sharp 0.34.5 (libheif / libvips advisories) decodes attacker-supplied bytes in upload routes | Fixed in code (wave 1) |
| M1 | `generate_order_number()` is callable by anon and burns the sequence; LPAD truncation later collides | Fixed in code (wave 1); migration 0074 |
| M2 | Refunds, payouts and reconcile still go through the simulation gateway on production | Open |
| M3 | The agent token endpoint accepts delegated tokens: renewal forever, wider scopes, any run id | Fixed in code (wave 3) |
| M4 | A goods RFQ sends the buyer's delivery contact (name, phone, address) to every matched seller before any order | Open |
| M5 | RFQ attachment URLs are client-supplied and re-signed with the service role (IDOR on the private bucket) | Open |
| M6 | `safeNext` open redirect via tab / CR / LF in `next` | Fixed in code (wave 1) |
| M7 | Admin mutation routes accept delegated agent tokens by default | Fixed in code (wave 3) |
| M8 | Delegated tokens are allowed by default on buyer, provider and pool write routes; the transition scope covers every action | Fixed in code (wave 3) |
| M9 | Any signed-in user can instantly hide any published review | Fixed in code (wave 3) |
| M10 | Coupons: every active code is publicly listable, usage limits are not atomic, no per-buyer limit | Partly fixed (wave 3, 0075): no client read; atomic + per-buyer limits open |
| M11 | Key admin decisions are not audit-logged (provider approve / reject, coupon creation, CMS banners) | Open |
| M12 | Verification flags prove existence, not ownership (Udyam number, penny-drop name match) | Open |
| M13 | Suspended providers keep their powers: quote, get paid, accept and deliver, read matched RFQs | Fixed in code (wave 3) |
| M14 | A goods return can be opened from `completed` with no time limit | Open |
| M15 | The public pool API leaks agent rationale (order ids, seller 30-day volume, buyer counts) | Open |
| M16 | Edits to approved Mart listings go live without re-review (category / commission, GST rate, images) | Open |
| M17 | `rfq_clarifications.provider_id` is readable by every matched competitor | Fixed in code (wave 3); migration 0075 |
| M18 | `buyer_pool_discipline_v1` let every buyer read every buyer's pool record | Fixed |
| M19 | Services payout release never re-checks the order status or an open dispute | Fixed in code (wave 2, ADR 026) |
| M20 | Only `payment.captured` is consumed; refund, transfer and chargeback outcomes are never reconciled | Open |
| M21 | Checkout sessions never expire at payment time (withdrawn quotes, lapsed pools, expired coupons honoured) | Open |
| M22 | No self-dealing guard: one person can buy from, quote to, review and settle with their own provider profile | Open |
| M23 | The model-provider residency and retention guard is off by default | Open |
| M24 | The platform AI budget can be drained from outside the cohort; the Mart catalog agent and speech-to-text bypass it | Open |
| M25 | next-intl 3.26.5 middleware open redirect (GHSA-8f24-v5vv-gm5j) | Mitigated (wave 1 guard); v4 upgrade open |
| M26 | The agent-runtime deploy workflow trusts a mutable action ref and `latest` flyctl next to FLY_API_TOKEN | Open |
| M27 | next 15.5.19 is below the patched releases (image optimizer, SSRF, cache and DoS advisories) | Fixed in code (wave 1) |
| M28 | The state-machine rule is not enforced by the DB, the types or lint; status literals are spread through the apps | Open |
| M29 | Tax and money formulas are duplicated outside shared, on different bases | Open |
| M30 | Three different contact-masking rule sets; the weakest one guards pre-payment human messages | Open |
| M31 | CI does not exercise the production configuration, and apps/web has no unit tests | Open |
| M32 | The pg-boss queue `agent.munshi.growth` is never created, so the weekly job is silently dropped | Open |
| M33 | Inbound WhatsApp messages can be stored but never processed, invisibly to the health check | Open |
| M34 | The public WhatsApp webhook downloads media synchronously, with no size cap or timeout, before its duplicate check | Open |
| M35 | Cron heartbeats only prove the job ran; failed runs stay green and handled errors never reach Sentry | Open |
| M36 | An Upstash error makes every rate-limited route return 500, and a slow Upstash adds 5 s per request | Open |
| M37 | Outbound calls (Resend, Surepass, MSG91, WhatsApp, Razorpay) have no timeouts and run inline in money paths | Open |
| M38 | Crons write the new status first and are never re-driven when the side effects fail; money crons set no maxDuration | Open |
| M39 | Reconciliation reads only the first 100 Razorpay payments and never flags a second capture | Partly fixed (wave 2): all pages read; second-capture flag open |
| M40 | Quote and group-offer scope / message text reaches buyers without contact masking | Open |
| M41 | A WhatsApp conversation stays bound to a user after a phone change | Open |
| M42 | A typed or spoken "yes" is captured by Munshi before procurement and approves the wrong proposal | Open |
| M43 | The payout dossier puts party-authored order titles in TRUSTED prompt parts | Open |
| M44 | A group (pool) quote can be re-priced, or its GST mode flipped, after close via the ordinary quote PATCH | Open |
| M45 | A provider can read competitors' sealed pool offers by joining the pool through their own buyer profile | Open |
| L1 | Admin `manual_refund` does not hold the payout, so a refund and a full payout can both go out | Open |
| L2 | `buyer_licences.certificate_path` is client-writable, and the certificate routes sign whatever path the row holds | Open |
| L3 | The agent runtime holds the full service-role key and DATABASE_URL in the process that parses public webhooks | Open |
| L4 | The pool "Pay ₹X to confirm" amount is computed on the client before GST (web and mobile) | Open |
| L5 | Money and policy switches live in the agent registry, whose only editor sits behind AGENT_ENABLED | Open |
| L6 | Docs drift: seven sampled CLAUDE.md claims are false or contradictory | Open |
| L7 | Hot, growing tables lack indexes (`notifications` has none and is polled every 30 s per tab) | Open |
| L8 | The goods order page sends the seller's payout (amount, status, schedule) to the buyer | Open |
| L9 | Two concurrent (or resumed) pool closes can release the quote slot the pool's own quote holds | Open |

## Supabase advisors (production, after 0072)

**Security:**

| Lint | Count | Assessment |
|---|---|---|
| Security definer view | 1 (`public_providers`) | Deliberate public projection of fixed columns of active providers. Since 0072 it is SELECT-only; it was 2 before 0072 |
| SECURITY DEFINER function executable by anon / authenticated | 8 each | `auth_user_id`, `has_role` and `is_provider_matched_to_rfq` are RLS helpers and must stay callable by `authenticated`, but anon needs none of them. `packages_group_same_provider` and `recompute_provider_rating` are trigger functions and should not be callable over RPC at all. The `search_*` functions are the public search path and are fine. Wave 1 (0074) revokes `generate_order_number`, the sequence and the two trigger functions from clients |
| Function search_path mutable | 15 | Wave 1: `auth_user_id` / `has_role` carry `SET search_path = public, pg_temp`, and 0074 pins the other 14 |
| Extension in public (`pg_trgm`) | 1 | Low. Moving it means re-creating the trigram indexes; leave until a maintenance window |
| Leaked password protection disabled | 1 | Turn it on in Supabase Auth settings. Login is OTP-first, but email / password exists for staff and tests |
| RLS enabled, no policy | 22 (info) | Intended: these are server-only tables (service role), for example `quote_options`, `service_pool_*`, `search_queries`, `cron_heartbeats` |

**Performance** (read earlier the same day):
- 119 unindexed foreign keys.
- 425 overlapping permissive policies (mostly the "admin all" + "owner" pairs).
- One auth init-plan on `checkout_sessions`.
- 31 unused indexes.
- `price_benchmarks` has no primary key. It deliberately has no id column; see S3.2, where a composite key would do.

None of these blocks the pilot. The `notifications` index (L7) and the foreign-key indexes on `orders`, `rfq_matches` and `quotes` are the ones worth doing first.

## Refuted, recorded as a data-classification question

**"Order pages send the whole orders row to the client"** (`apps/web/lib/orders/queries.ts:98`). It is true that `getOrderDetail` selects `*` and the page passes it to a client component. The verifier refuted it as a *new* exposure, because the database already lets each party SELECT every column of their own orders (`orders: msme all own` / `provider all own`, with no column grants) and every `order_events` payload. So `commission_paise` and `provider_earning_paise` are visible to the buyer either way.

Whether a buyer may see the platform's commission is a product decision. If not, the fix is column-level grants on `orders` and a payload-free events read, not a page change. Recorded for the founder (D-list).

## Appendix A — findings in detail

Each issue lists every confirmed finding that raised it. Impact and fix are the verified text from the strongest finding, lightly edited.

### C1. `public_providers` was writable with the public anon key

- **Status:** Fixed on production (0072, applied 2026-09-24; PR #58)
- **Where:** `packages/db/src/rls/policies.sql:123`
- **Raised by:** 1 finding from 1 audit team (Database: RLS, grants, functions, views, storage)
- **Impact:** Unauthenticated integrity and availability compromise of the whole provider catalogue. It enables marketplace-wide denial of service, phishing through provider pages, fake trust signals, and irreversible deletion of provider KYC, bank and quote data. It also breaks the soft-delete rule (§2.5 rule 4). No rig covers it: verify-authz, verify-score and verify-column-privs only SELECT from the view.
- **Fix:** Immediately run `REVOKE ALL ON public_providers FROM anon, authenticated; GRANT SELECT ON public_providers TO anon, authenticated;`. Add the same two lines after the CREATE in policies.sql and in a new migration so a re-run stays closed. Better still, recreate it `WITH (security_barrier = true)` plus `WITH CHECK OPTION`, or keep the definer view but make it non-updatable (for example add `LIMIT ALL` / `DISTINCT`, which disables auto-update). Add a verify-authz §7a case: anon PATCH and DELETE on public_providers must leave provider_profiles unchanged.

### C2. Any signed-in user could create or rewrite a provider profile (self-activation, lifting a suspension, fake trust badges)

- **Status:** Fixed on production (0072 and 0073, applied 2026-09-24; PR #58)
- **Where:** `packages/db/src/rls/policies.sql:111`, `packages/db/src/rls/policies.sql:110`
- **Raised by:** 4 findings from 4 audit teams (AuthZ: buyer flows (rfq, orders, checkout, me, profile, pools, webhooks); AuthZ: provider (partner) and Mart routes; Database: RLS, grants, functions, views, storage; Server-rendered pages: service-role data serialized into client components, and public ISR pages)
- **Impact:** KYC review, credential requirements for regulated categories, the legal-acceptance gate and admin suspension are all bypassed. An ordinary signed-in account receives every future buyer RFQ in the categories and states it picks, including private business details and attachments. It can take buyer payments as a 'provider' nobody vetted and can forge trust badges and ranking signals. Payout of money stays blocked (bank rows are write-revoked and the approval gate holds payouts), but the data exposure and marketplace fraud happen immediately.
- **Fix:** Add a migration that runs REVOKE INSERT, UPDATE, DELETE ON provider_profiles, provider_categories FROM anon, authenticated. Replace "owner all" on both tables with an owner-read policy; every legitimate writer already uses the service role (profile/provider, settings, availability, logo, admin). For packages, either route writes through /partner/packages on the service role or use column grants plus a BEFORE UPDATE trigger that refuses status changes from client roles. Add a users_roles_guard-style trigger that refuses client changes to status, udyam_verified, top_rated, avg_rating, review_count, completed_orders, sells_goods, logo_url and deleted_at. Add verify-authz §7 assertions that provider A cannot INSERT or UPDATE these tables with their own JWT. Check production immediately with: select has_table_privilege('authenticated','public.provider_profiles','UPDATE'), has_table_privilege('authenticated','public.provider_profiles','INSERT').

### H1. Sellers could write Mart `products` / `price_tiers` directly (self-approval, reversing a suspension, BIS-blocked items)

- **Status:** Fixed on production (0072, applied 2026-09-24; PR #58)
- **Where:** `packages/db/src/migrations/0022_mart_catalog.sql:360`, `packages/db/src/rls/policies.sql:1098`
- **Raised by:** 3 findings from 3 audit teams (AuthZ: provider (partner) and Mart routes; Database: RLS, grants, functions, views, storage; Payments and money integrity)
- **Impact:** The Mart listing-moderation and takedown controls (MART_DESIGN §5 'admin approves first N listings'; admin suspend) are not enforceable against the seller:
  - Prohibited or suspended goods can be re-listed and sold.
  - BIS-blocked categories appear publicly.
  - Search ranking can be manipulated.
  - Audit history and pools can be destroyed by hard delete, against hard rule 4 (never hard-delete provider data).
- **Fix:** 1. `REVOKE INSERT, UPDATE, DELETE ON products, price_tiers FROM anon, authenticated;`.
  2. Replace the two `seller crud own` policies with SELECT-only owner policies. Every writer already uses the service role: the seller/products routes and admin/products use createAdminClient.
  3. Mirror the change in policies.sql's guarded Mart block.
  4. Add killtest-mart-schema cases: seller self-activates, reactivates an admin-suspended listing, inserts a BIS-blocked product, deletes a product.
  5. Consider a BEFORE UPDATE trigger refusing status/approved_at changes from client roles.

### H2. Providers could join any category directly, including credential-gated ones, and receive those RFQs

- **Status:** Fixed on production (0072, applied 2026-09-24; PR #58)
- **Where:** `packages/db/src/rls/policies.sql:174`
- **Raised by:** 1 finding from 1 audit team (Database: RLS, grants, functions, views, storage)
- **Impact:** Bypasses the per-category credential gate for regulated professions. It also spreads buyers' confidential procurement requests (business needs, attachments metadata, voice transcripts) to providers who were never vetted for them. Combined with the provider_profiles finding, a brand-new account can harvest RFQs marketplace-wide.
- **Fix:** Run `REVOKE INSERT, UPDATE, DELETE ON provider_categories FROM anon, authenticated` and make the policy SELECT-only (keep the public read). Route category changes through an admin-approved API that re-checks credentials, and write with the service role. Add a verify-authz case: a provider INSERTing into provider_categories is denied.

### H3. The Supabase "Send SMS" hook is unauthenticated: SMS pumping, SMS bombing, branded smishing

- **Status:** Fixed in code (wave 1); fully closed once `SEND_SMS_HOOK_SECRET` is set. With the secret, the hook refuses any call without a valid Standard Webhooks signature. Without it on production (transition only, so the deploy cannot stop phone login), every call logs an error and is held to a global cap of 120 an hour. Either way: +91 mobiles only, 5 per number per 15 minutes, an 8 s MSG91 timeout, and only the 6-digit code reaches the fixed DLT template. Set the secret in the Supabase "Send SMS" hook and in Vercel
- **Where:** `apps/web/app/api/v1/auth/sms-hook/route.ts:32`
- **Raised by:** 3 findings from 3 audit teams (AuthZ: admin, cron and misc routes; Reliability, scalability and operability; Web application security)
- **Impact:** SMS bill-drain and international toll-fraud (SMS pumping) at AMClub's cost. The attack defeats the OTP limiter the team added specifically for bill-drain. It enables SMS-bombing of any phone number, and branded phishing, e.g. 'AMClub code 123456, share it with our agent'. MSG91/DLT sender reputation could be suspended, which would break login for everyone. If MSG91_AUTH_KEY is not yet set in production, the hook returns 500 and this is latent. It becomes live the moment SMS goes live.
- **Fix:** Verify the Supabase hook signature with the `standardwebhooks` library, using a SEND_SMS_HOOK_SECRET ('v1,whsec_...') held in env. Fail closed with 401 when the secret is unset or the signature or timestamp is invalid. Add a per-phone and global limiter as a backstop. Allow only +91 numbers (also tighten the /auth/otp regex to India). Never return the vendor response or exception text to the caller.

### H4. The WhatsApp webhook accepts unsigned requests whenever the driver resolves to `stub`

- **Status:** Fixed in code (wave 1). The stub driver answers 401 `webhook_not_configured` unless NODE_ENV is not production and `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=true`; the server caps bodies at 256 KB
- **Where:** `apps/agent-runtime/src/whatsapp/inbound.ts:71`
- **Raised by:** 3 findings from 3 audit teams (AI agents and LLM security; Reliability, scalability and operability; Supply chain, CI/CD, infra config, mobile app)
- **Impact:** Unauthenticated impersonation of users' WhatsApp channel: forged consent records (DPDP), mass opt-out, and confirmations that bypass the confirm gate for quotes and requests, all recorded as the user's own decision. The spoofed traffic can also drain the platform AI budget and cause DB and queue growth.
- **Fix:** Fail closed. When no live driver is configured, reject POST /webhooks/whatsapp (401), unless NODE_ENV !== 'production' and an explicit WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=true is set. Make whatsappConfigFromEnv throw, or disable the webhook, when WHATSAPP_DRIVER names a real driver but its credentials or secret are missing; never downgrade to stub. Check at runtime boot that WHATSAPP_APP_SECRET / INTERAKT_WEBHOOK_SECRET is present. Add a per-IP rate limit and body-size cap, and check metadata.phone_number_id against the configured number.

### H5. Admin "Retry payout" releases held payouts past the dispute hold and the release gates

- **Status:** Fixed in code (wave 2, ADR 026). "Retry payout" reschedules `failed` payouts only (409 `payout_held_use_release` for a held one), and every payout run passes `payoutRunBlockers` after the claim
- **Where:** `apps/web/app/api/v1/admin/orders/[id]/route.ts:65`, `apps/web/app/api/v1/admin/orders/[id]/route.ts:67`
- **Raised by:** 4 findings from 4 audit teams (Architecture and code health; AuthZ: admin, cron and misc routes; Payments and money integrity; Reliability, scalability and operability)
- **Impact:** Money leaves the platform in exactly the states the release gates exist to block: open dispute, open return, missing delivery evidence, return window running. This breaks the MART_DESIGN §4.3 'NEVER released' rule and the ADR-014 dispute protections. The buyer's refund is then blocked, or the platform pays twice. Any `ops` account (not only the founder) can do this with one click, and no dossier is required.
- **Fix:** Remove the second release path. Make retry_payout call the same function as admin/payouts/[id]: isValidPayoutTransition, the goods and services gates, and a check for no open dispute. Also refuse release when the provider is suspended, since neither route checks provider status today. Add requireNotDelegated. Alternatively, have the order page call POST /api/v1/admin/payouts/<payoutId> and delete the retry_payout action. Add a verify-phase7 or money-rig criterion: 'retry on an order with an open dispute → 409'.

### H6. Order status writes are not compare-and-set, so crons can overwrite a dispute or revision and still run money side effects

- **Status:** Fixed in code (wave 2, ADR 026). Every order status write is compare-and-set: a party that loses gets 409 `order_changed` and runs no side effect, a cron that loses skips the order, and goods actions stop at a 0-row update
- **Where:** `apps/web/lib/orders/transitions.ts:404`, `apps/web/lib/orders/transitions.ts:304`
- **Raised by:** 4 findings from 4 audit teams (Architecture and code health; AuthZ: buyer flows (rfq, orders, checkout, me, profile, pools, webhooks); Payments and money integrity; Reliability, scalability and operability)
- **Impact:** The order ends 'completed' while a dispute is open. The dispute console's resolve CAS (`.eq('status','disputed')`) can then never match, so the dispute cannot be settled through ADR-014's single rule. A requested revision is silently dropped. A payout is scheduled on a contested order, and only the founder approval gate stops the transfer. Double submits also write duplicate events and notifications. This breaks hard rule 8: the API is supposed to reject illegal transitions.
- **Fix:** Make every order status write a CAS: `.update(patch).eq('id', id).eq('status', from).select('id')`. Treat zero rows as a 409 in user routes and as a skip in crons, and run side effects only when the CAS returned a row. Better still, add one `transition_order(id, from, to)` RPC and a BEFORE UPDATE trigger on orders that rejects any transition not in the state-machine map.

### H7. A refund that fails after the status write is never retried, and ops cannot finish it from admin

- **Status:** Fixed in code (wave 2, ADR 026). A failed refund leaves a `refund_failed` event; the auto-cancel cron re-drives owed refunds through the key-guarded `processRefund` after 10 idle minutes, and admin has "Finish refund"
- **Where:** `apps/web/lib/orders/transitions.ts:390`
- **Raised by:** 2 findings from 2 audit teams (Architecture and code health; Reliability, scalability and operability)
- **Impact:** The buyer's captured money is never returned. Nothing alerts anyone, and ops have no supported way to finish the refund short of a manual database edit. Once live keys are on, any transient gateway error on a refund causes this.
- **Fix:** Add a refund re-driver: a cron, or a step in reconcile, that picks refunds with status 'pending' older than N minutes and re-runs processRefund for their order. That is safe because processRefund is already key-idempotent via the listRefunds receipt lookup. Wrap each order's work in try/catch inside the cron loops. Let the admin action complete a pending refund instead of returning 409, and list pending refunds on /admin.

### H8. Invoice PDF generation throws on Indic-script names, so no tax invoice is created and accept-delivery returns 500

- **Status:** Mitigated (wave 2, ADR 026). Every drawn string passes a WinAnsi-safe filter, so the invoice is always created; an invoice failure is recorded as `invoice_failed` and never fails the order action, and the reconcile cron generates missing invoices. Rendering Indic names properly needs a shaping-capable renderer (open)
- **Where:** `apps/web/lib/invoices/generate.ts:34`
- **Raised by:** 1 finding from 1 audit team (Reliability, scalability and operability)
- **Impact:** No buyer or commission GST invoice is ever created for these orders, and nothing retries it, so B2B buyers cannot claim input tax credit. The buyer sees an error on an action that actually succeeded, the completion notices are lost, and every auto-accept batch aborts when it reaches such an order. Hindi, Telugu and Tamil are launch languages, so this hits the target market.
- **Fix:** Embed a Unicode font (Noto Sans Devanagari/Tamil/Telugu via @pdf-lib/fontkit) or at least apply pdfSafe to every string drawn, header values included. Catch generateInvoices failures in the transitions and record an 'invoice_failed' order event. Add a sweeper that creates missing invoices for completed orders, and add a money-rig case with an Indic business name.

### H9. Payout transfer is not idempotent: a timeout after Razorpay creates the transfer marks it failed, and a retry pays again

- **Status:** Fixed in code (wave 2, ADR 026). Transfers carry `notes.payout_id`; only a definite rejection marks a payout `failed`, anything ambiguous stays `processing` with `payout_unconfirmed`; a retry first asks the gateway for that payout's transfer, and the reconcile cron settles stuck payouts after 30 minutes
- **Where:** `apps/web/lib/payments/payout.ts:69`, `apps/web/lib/payments/payout.ts:64`
- **Raised by:** 2 findings from 2 audit teams (Payments and money integrity; Reliability, scalability and operability)
- **Impact:** The provider's full earnings are transferred twice from the platform balance, which cannot be recovered without a Route reversal. Or a provider is silently never paid. FOLLOWUPS already lists the missing gateway key for a crash between the transfer and the 'paid' write. This is a different case: a transfer that throws but did execute, which the UI currently routes to a one-click retry.
- **Fix:** Before any retry, look up an existing transfer for the payout and adopt it if found: tag transfers with notes.payout_id and query them, or switch to payment-linked transfers keyed on the payment. Record errors with no HTTP response as an 'unknown' state, not 'failed'. Set a client timeout. Add a sweeper that reconciles 'processing' payouts older than N minutes against Razorpay, and check the error on the 'paid' update.

### H10. sharp 0.34.5 (libheif / libvips advisories) decodes attacker-supplied bytes in upload routes

- **Status:** Fixed in code (wave 1). sharp 0.35.4; every loader blocked except JPEG / PNG / WebP; uploads are magic-byte sniffed before decode and capped at 40 MP (`lib/images/untrusted.ts`)
- **Where:** `apps/web/app/api/v1/profile/provider/logo/route.ts:44`
- **Raised by:** 1 finding from 1 audit team (Supply chain, CI/CD, infra config, mobile app)
- **Impact:** The vulnerable libheif/libvips parsers are reachable by any signed-in user. At minimum this is a function crash or DoS. At worst it is code execution in a function that holds SUPABASE_SERVICE_ROLE_KEY, the Razorpay secrets, CRON_SECRET and COLUMN_ENCRYPTION_KEY, which would compromise the whole database. I could not verify a working exploit for these specific CVEs.
- **Fix:** Upgrade sharp to >=0.35.4 in apps/web, apps/agent-runtime and packages/agent-core, together with next >=15.5.24, which depends on it. Also sniff magic bytes before decoding (JPEG FFD8FF, PNG 89504E47, WEBP RIFF....WEBP) and reject any mismatch with the declared type. Call `sharp.block({ operation: ['VipsForeignLoadHeifBuffer','VipsForeignLoadHeifFile','VipsForeignLoadHeifSource','VipsForeignLoadTiff','VipsForeignLoadNsgif','VipsForeignLoadSvg','VipsForeignLoadVips'] })` once at module load, and pass `{ limitInputPixels: 40e6, failOn: 'warning' }`.

### M1. `generate_order_number()` is callable by anon and burns the sequence; LPAD truncation later collides

- **Status:** Fixed in code (wave 1): migration 0074 revokes EXECUTE from clients, revokes the sequence, and pads to at least 6 digits without truncation. Applies to production after approval
- **Where:** `packages/db/src/migrations/0000_robust_phalanx.sql:500`
- **Raised by:** 1 finding from 1 audit team (Database: RLS, grants, functions, views, storage)
- **Impact:** Unauthenticated denial of the order-materialisation money path once live Razorpay payments are enabled. It produces captured payments with no order and manual refunds. The gaps in invoice serials also cause GST record-keeping noise.
- **Fix:** Run `REVOKE EXECUTE ON FUNCTION generate_order_number() FROM PUBLIC, anon, authenticated` and `REVOKE ALL ON SEQUENCE order_number_seq FROM anon, authenticated`. Leave the column default working for service_role and definer functions. Stop truncating: use `lpad(n::text, greatest(6, length(n::text)), '0')` or plain to_char with FM. Add a verify-authz case: anon RPC generate_order_number is denied.

### M2. Refunds, payouts and reconcile still go through the simulation gateway on production

- **Status:** Open
- **Where:** `apps/web/lib/payments/payout.ts:64`, `apps/web/lib/payments/index.ts:16`
- **Raised by:** 2 findings from 2 audit teams (Architecture and code health; Payments and money integrity)
- **Impact:** Today: false 'paid' payout records and false provider notifications. At cutover: real money paid out for unpaid orders. The only safeguard is operator memory.
- **Fix:** Fail closed outside checkout too: make runPayouts, processRefund and the admin release refuse (leaving the row held or pending) when `!paymentsAvailable(gateway.isReal)`. Record `payments.simulated` (or test `razorpay_payment_id LIKE 'pay_sim_%'` / `webhook_payload->>'simulated'`) and have runPayouts refuse any transfer for a simulated payment. Show 'simulated' in /admin/payouts. Add a cutover step that voids payouts and orders from the simulate era.

### M3. The agent token endpoint accepts delegated tokens: renewal forever, wider scopes, any run id

- **Status:** Fixed in code (wave 3). The session path of `POST /api/v1/agent/token` refuses a delegated token (no self-renewal or scope widening), and `run_id` must be one of the caller's own runs (403 `run_not_yours`)
- **Where:** `apps/web/app/api/v1/agent/token/route.ts:74`
- **Raised by:** 1 finding from 1 audit team (AI agents and LLM security)
- **Impact:** One token theft becomes access the user cannot revoke. It lasts until the user is deleted or SUPABASE_JWT_SECRET is rotated, and for admin users that includes the admin API. The least-privilege amc_scopes model and the run binding can be bypassed at will. This path is live in production because AGENT_ENABLED=true.
- **Fix:** Remove the session path in production (it has no product caller), or guard it: (a) call requireNotDelegated first and refuse any Bearer carrying amc_persona/amc_scopes; (b) require the caller's JWT to carry session_id and copy it into the minted token, so sign-out revokes it; (c) accept run_id only if agent_runs.user_id = caller, otherwise drop it; (d) never mint scopes wider than the caller's current token. Also add an `iss: 'amc-agent'` claim so delegated tokens are easy to recognise and refuse at the edges.

### M4. A goods RFQ sends the buyer's delivery contact (name, phone, address) to every matched seller before any order

- **Status:** Open
- **Where:** `apps/web/lib/rfq/queries.ts:540`
- **Raised by:** 1 finding from 1 audit team (Server-rendered pages: service-role data serialized into client components, and public ISR pages)
- **Impact:** Buyer PII goes to every matched seller, not only the one who is later paid, and it enables off-platform deals that skip the escrow/commission path (the §8.3 stance against pre-order chat). This differs from the known finding (GET /orders/[id] exposes the phone to the one paid seller after the order): here it happens pre-order, to all matched sellers, through the RFQ endpoint.
- **Fix:** In getRfqForProvider, map goods_spec to a seller DTO: keep item, qty, unit, spec, brand_preference, target_unit_price_paise and product_id, and reduce delivery to { city, state, pincode, pickup } (or to what freight pricing needs). Drop contact_name, contact_phone and the street address. Keep the full object only in getRfqForBuyer. Add a verify-goods-rfq / mart:acceptance assertion that the provider view has no contact_phone.

### M5. RFQ attachment URLs are client-supplied and re-signed with the service role (IDOR on the private bucket)

- **Status:** Open
- **Where:** `apps/web/lib/rfq/attachments.ts:77`, `packages/shared/src/schemas/index.ts:146`
- **Raised by:** 2 findings from 2 audit teams (AuthZ: buyer flows (rfq, orders, checkout, me, profile, pools, webhooks); Web-side agent libraries and the deferred-release RFQ lifecycle)
- **Impact:** Other buyers' RFQ documents (drawings, GST notices, quotations) can be read by anyone who has learned their keys, with persistent re-signing after the original 15-minute link expires. There is potential cross-bucket exposure of private files (invoices with buyer name and GSTIN). This breaks the stated invariant that 'nobody else reaches those loaders'.
- **Fix:** In POST /api/v1/rfq (and anywhere else rfqs.attachments is written), accept a stored reference only if it matches exactly `^rfq-attachments/<actor.msmeId>/[0-9a-f-]{36}\.(jpg|png|webp|pdf|step|stp|dxf)$`, and reject anything containing '..', '%2e', '\' or '//'. Return 422 otherwise. Better still, accept only reference ids returned by POST /rfq/attachments or document-extract, recorded server-side with the uploader. In signRfqAttachments, apply the same regex before signing (defence in depth for legacy rows) and bind the msmeId segment to the RFQ's msme_id. Add a verify-authz criterion: an RFQ carrying a foreign path or a dot-segment path is refused.

### M6. `safeNext` open redirect via tab / CR / LF in `next`

- **Status:** Fixed in code (wave 1). `safeNext` rejects control characters and backslashes and any value that resolves off-origin; the OAuth callback re-checks the origin
- **Where:** `packages/shared/src/safe-next.ts:16`, `packages/shared/src/safe-next.ts:17`
- **Raised by:** 2 findings from 2 audit teams (AuthZ: admin, cron and misc routes; Web application security)
- **Impact:** A trusted AMClub login flow ends on an attacker page that can pose as AMClub, e.g. 'session expired, re-enter OTP' or a fake UPI payment page, right after a real login. Admins are not affected: their destination is fixed. Session tokens are not leaked by the redirect itself.
- **Fix:** In safeNext, reject any value that contains control characters or whitespace (/[\u0000-\u001F\u007F\s\\]/). Better, resolve and compare: `const u = new URL(value, 'https://x.invalid'); if (u.origin !== 'https://x.invalid') return null; return u.pathname + u.search + u.hash`. In the callback, also assert `new URL(dest, origin).origin === origin` before redirecting. Add unit cases for %09, %0A, %0D and a leading %5C.

### M7. Admin mutation routes accept delegated agent tokens by default

- **Status:** Fixed in code (wave 3). `requireAdmin` refuses every delegated agent token unless the route names its read-only ops tool (`summarize_dispute`, `triage_verification`, `recommend_payout_release`, `read_order_evidence`) and that tool is in scope. Admin mutations are never reachable by an agent token
- **Where:** `apps/web/lib/auth/admin.ts:12`, `apps/web/app/api/v1/admin/orders/[id]/route.ts:47`, `apps/web/lib/auth/admin.ts:15`
- **Raised by:** 3 findings from 3 audit teams (AI agents and LLM security; Architecture and code health; AuthZ: admin, cron and misc routes)
- **Impact:** This breaks the documented invariant that admin actions are never tools and that 'any delegated token is refused … so an agent can never reach them even under an admin's own grant'. The blast radius of a runtime credential compromise grows from read-only evidence to diverting and releasing provider payouts, approving providers, changing commission and minting coupons.
- **Fix:** Make requireAdmin refuse any token carrying amc_persona or amc_scopes by default. Add an explicit opt-in for the two scoped reads: requireAdmin({ delegatedScope: 'read_order_evidence' | 'summarize_dispute' }), which then runs requireToolScope. Extend verify-authz §7 with a scoped ops token against every admin POST (expect 403). Separately, consider dual control or a cooling-off hold for set_route_account and set_bank_verified: hold scheduled payouts and require bank re-verification when the Route account changes.

### M8. Delegated tokens are allowed by default on buyer, provider and pool write routes; the transition scope covers every action

- **Status:** Fixed in code (wave 3). The transition route honours `draft_dispute` for `raise_dispute` only; every other action, and the unwrapped writes the audit listed (milestones, documents, review, external-wait, dispute statement, RFQ decline, RFQ attachments, buyer profile, provider settings, simulated checkout, pool join / commit / offer), refuse a delegated token
- **Where:** `apps/web/lib/agent/scope.ts:17`, `apps/web/lib/pools/route-guard.ts:18`
- **Raised by:** 2 findings from 2 audit teams (AuthZ: buyer flows (rfq, orders, checkout, me, profile, pools, webhooks); S3.4 services demand pools: detection, tier pricing and the close path that writes quotes)
- **Impact:** ADR-008/009 treat per-tool scopes as a hard lock, but in practice that lock only covers the handful of wrapped routes. It is not directly reachable by a model today, because tool routes are built from server-side ids, but one leaked runtime token equals the user's full authority on money- and state-changing routes.
- **Fix:** Make delegation deny-by-default. Have getAuthedSupabase (or a shared route wrapper) reject any token carrying amc_persona or amc_scopes unless the route explicitly declares the tools it serves. In /orders/[id]/transition, require 'draft_dispute' only for action==='raise_dispute' and call requireNotDelegated for every other action. Add requireNotDelegated to milestones, documents, review, dispute statement, profile/*, pools/*, rfq/decline and checkout/simulate.

### M9. Any signed-in user can instantly hide any published review

- **Status:** Fixed in code (wave 3). A report is recorded, not acted on; a review is hidden pending ops only after three distinct reporters (never counting the reviewed provider), and never again once ops restored it
- **Where:** `apps/web/app/api/v1/reviews/[id]/flag/route.ts:33`
- **Raised by:** 1 finding from 1 audit team (AuthZ: admin, cron and misc routes)
- **Impact:** The integrity of public ratings, which drive search 'rating' sort, trust badges and buyer decisions, can be manipulated unilaterally and repeatedly, at no cost. Moderation effort is unbounded.
- **Fix:** A flag should queue a report without changing visibility. Insert a review_reports row (reporter, reason, unique per reporter and review) and leave status 'published' until ops decides. Alternatively, hide only after N distinct reporters who are verified buyers. Disallow flagging by the reviewed provider, and mark reviews restored by ops as un-flaggable (or queue-only).

### M10. Coupons: every active code is publicly listable, usage limits are not atomic, no per-buyer limit

- **Status:** Partly fixed (wave 3, migration 0075). Coupons are no longer client-readable, and checkout reads the coupon with the service role. Atomic redemption and a per-buyer limit need a product decision on limits (open)
- **Where:** `packages/db/src/rls/policies.sql:993`, `apps/web/lib/coupons/apply.ts:39`, `packages/db/src/rls/policies.sql:992`, `apps/web/app/api/v1/checkout/route.ts:236`
- **Raised by:** 5 findings from 4 audit teams (AuthZ: admin, cron and misc routes; AuthZ: buyer flows (rfq, orders, checkout, me, profile, pools, webhooks); Database: RLS, grants, functions, views, storage; Payments and money integrity)
- **Impact:** Private or targeted discount codes leak and can be redeemed by anyone. With per-code usage_limit the only cap (there is no per-user limit), a leaked code can be burned by strangers. The per-user brute-force limiter becomes pointless. Money impact is bounded by the discounts ops has created.
- **Fix:** Drop the public read policy, or scope it to nothing: REVOKE SELECT ON coupons FROM anon, authenticated. Read coupons only on the server with the admin client. Note that checkout/route.ts:236 currently reads coupons through the user's RLS client (`supabase.from('coupons')`) and relies on this policy, so switch it to the admin client in the same PR. If some codes are meant to be public, add an explicit `is_public` column and a column-restricted view.

### M11. Key admin decisions are not audit-logged (provider approve / reject, coupon creation, CMS banners)

- **Status:** Open
- **Where:** `apps/web/app/api/v1/admin/verifications/[id]/route.ts:49`
- **Raised by:** 1 finding from 1 audit team (AuthZ: admin, cron and misc routes)
- **Impact:** The Phase 7 'audit log' guarantee and the lib/audit/log.ts contract ('§7 — every admin mutation is audit-logged') are violated for the highest-impact non-money decisions: KYC approval, which gates who can receive money, and coupons, which move money. The suspended→active path through verifications also sidesteps the audited `reactivate` action.
- **Fix:** Call writeAudit, with before and after values, in admin/verifications/[id] POST, admin/coupons POST, and admin/cms POST/PATCH. Add adminMutation rate limits and requireNotDelegated to these routes. In verifications, require p.status IN ('pending_kyc','under_review') (409 otherwise) and return 404 when the provider does not exist. Add a verify-phase7 check that each admin POST produces an audit_logs row.

### M12. Verification flags prove existence, not ownership (Udyam number, penny-drop name match)

- **Status:** Open
- **Where:** `apps/web/app/api/v1/kyc/verify-udyam/route.ts:60`, `apps/web/lib/kyc/surepass.ts:84`
- **Raised by:** 2 findings from 2 audit teams (AuthZ: admin, cron and misc routes; AuthZ: buyer flows (rfq, orders, checkout, me, profile, pools, webhooks))
- **Impact:** The verified-identity trust signal can be borrowed from any real enterprise, which misleads buyers comparing quotes and marks buyer accounts as 'verified' to providers. This is latent while KYC runs in stub mode (the stub never earns the chip), and live as soon as the vendor key lands.
- **Fix:** Set the chip only when the vendor's enterprise name matches (normalised or fuzzy) the profile's GST-locked legal name, or when the vendor-returned PAN or GSTIN matches the provider's. Otherwise record the attempt as `name_mismatch` for ops review. Enforce one active verified claim per Udyam number (a unique partial index on verified rows).

### M13. Suspended providers keep their powers: quote, get paid, accept and deliver, read matched RFQs

- **Status:** Fixed in code (wave 3). `resolveActor` gives a suspended or soft-deleted provider no provider identity (like a suspended buyer) until an admin reactivates them, so quote, deliver, get-paid and matched-RFQ paths refuse
- **Where:** `apps/web/lib/orders/actor.ts:37`
- **Raised by:** 2 findings from 2 audit teams (AuthZ: buyer flows (rfq, orders, checkout, me, profile, pools, webhooks); Server-rendered pages: service-role data serialized into client components, and public ISR pages)
- **Impact:** Admin suspension doesn't stop a suspended provider from taking new business or buyer money, and buyer RFQ data keeps flowing to the suspended account.
- **Fix:** Add providerStatus to resolveActor and treat a non-active provider like a suspended buyer (providerId null) on write paths: quote POST/PATCH, clarifications, pools offers and order transitions, allowing only what is needed to wind down existing orders. In the checkout quote branch, join provider_profiles and refuse unless status='active' and deleted_at is null. On suspend, withdraw the provider's submitted quotes and set declined_at on their open matches.

### M14. A goods return can be opened from `completed` with no time limit

- **Status:** Open
- **Where:** `apps/web/lib/mart/goods-transitions.ts:52`
- **Raised by:** 1 finding from 1 audit team (AuthZ: provider (partner) and Mart routes)
- **Impact:** This breaks the canonical invariant 'completed → disputed only within dispute_window_days' (CLAUDE.md §3.7 / ADR-014 §6) and the per-category return-window policy sellers are promised. A buyer can freeze a seller's payout or open a refund claim on any past goods order indefinitely, and ops load and seller cash-flow risk are unbounded.
- **Fix:** In applyGoodsTransition for open_return:
  - Compute the window end from the order's events. getGoodsDossier(admin, order).gate.returnWindowEndsAt already derives it from delivered_photo/buyer_received plus the category hours.
  - Return 409 `return_window_closed` (carrying endsAt) once it has passed.
  - For `from === 'completed'`, also apply shared canRaiseDispute with agent_settings.dispute_window_days (whichever bound is intended; record the choice in an ADR-014 addendum).

  Send the deadline from the server so the UI hides the action after it. Add a verify-mart / money-rig criterion.

### M15. The public pool API leaks agent rationale (order ids, seller 30-day volume, buyer counts)

- **Status:** Open
- **Where:** `apps/web/lib/mart/group-buy-agent.ts:209`
- **Raised by:** 1 finding from 1 audit team (AuthZ: provider (partner) and Mart routes)
- **Impact:** Other sellers' confidential sales volumes and customer counts, and internal order identifiers, are disclosed to the public. Order UUIDs are meant to be unguessable handles, and publishing them removes that layer of defence for any order-keyed endpoint.
- **Fix:** Build a public PoolDetail DTO that omits rationale (and any other internal fields). Return rationale only from the admin pool routes (mart/admin/pools*). Keep order_ids in ai_decisions.input_refs (admin-only) rather than on the pool row.

### M16. Edits to approved Mart listings go live without re-review (category / commission, GST rate, images)

- **Status:** Open
- **Where:** `apps/web/app/api/v1/mart/seller/products/[id]/route.ts:82`
- **Raised by:** 1 finding from 1 audit team (AuthZ: provider (partner) and Mart routes)
- **Impact:** The 'admin approves the first N listings' control is cosmetic, because content can be swapped after approval. A category switch changes platform commission on future orders and buyer return rights ('Not returnable'). Pool buyers can be charged a different GST than they committed to. The impact is limited by the audit trail in product_events and by the admin's ability to suspend.
- **Fix:** 1. When a material field (category_slug, name, images, hsn_code, gst_rate_bps, unit) changes on an active or pending_approval listing, send it back to pending_approval, at least for sellers still under the auto-approve threshold, and always for a category change.
  2. Pin admin approval to the reviewed version: pass updated_at and use `.eq('updated_at', reviewed)`.
  3. Snapshot gst_rate_bps, unit and hsn_code onto the pool at approveAndOpenPool, and use the snapshot in prepareMemberCheckout.

### M17. `rfq_clarifications.provider_id` is readable by every matched competitor

- **Status:** Fixed in code (wave 3). Migration 0075 grants clients every `rfq_clarifications` column except `provider_id` and `answered_by`; the RLS policies that use them keep working
- **Where:** `packages/db/src/migrations/0034_rfq_clarifications.sql:63`
- **Raised by:** 1 finding from 1 audit team (Database: RLS, grants, functions, views, storage)
- **Impact:** Reveals which competitors are bidding on each RFQ and what they asked. This breaks the sealed-bid fairness the S1.3 design relies on (§8.3 no bidding wars). Blast radius is limited to matched providers.
- **Fix:** `REVOKE SELECT ON rfq_clarifications FROM anon, authenticated; GRANT SELECT (id, rfq_id, question, question_redacted, answer, answer_redacted, asked_at, answered_at, created_at, updated_at, deleted_at) ON rfq_clarifications TO authenticated;`. Alternatively make it service-role only, since the API is the reader. Add a verify-authz check that selecting provider_id errors.

### M18. `buyer_pool_discipline_v1` let every buyer read every buyer's pool record

- **Status:** Fixed on production (0072, applied 2026-09-24; PR #58)
- **Where:** `packages/db/src/migrations/0023_mart_pools.sql:146`
- **Raised by:** 1 finding from 1 audit team (Database: RLS, grants, functions, views, storage)
- **Impact:** Cross-tenant disclosure of a buyer reputation signal that the design keeps admin-only. It is also a standing violation of the ADR-022 rule.
- **Fix:** Recreate the view `WITH (security_invoker = true)`, so a buyer sees only their own row, or revoke SELECT from authenticated entirely if only the service role consumes it (poolDisciplineFactor runs server-side). Update both 0023's mirror in policies.sql and a new migration.

### M19. Services payout release never re-checks the order status or an open dispute

- **Status:** Fixed in code (wave 2, ADR 026). The release route answers 409 `order_not_releasable` outside the release statuses, and `runPayouts` holds any payout whose order is not releasable (reason `order_status:<s>`)
- **Where:** `apps/web/app/api/v1/admin/payouts/[id]/route.ts:58`, `apps/web/app/api/v1/admin/payouts/[id]/route.ts:71`
- **Raised by:** 2 findings from 2 audit teams (Payments and money integrity; Web-side agent libraries and the deferred-release RFQ lifecycle)
- **Impact:** Breaks the invariant that payouts release ONLY from completed/resolved_release/resolved_partial. The provider is paid during an open dispute and the buyer's refund path is blocked.
- **Fix:** In the release route and in runPayouts at claim time, load the order and refuse unless `order.status ∈ PAYOUT_RELEASE_STATUSES` and no dispute is open. Do this always, not only under the evidence cutover. In raise_dispute, also add a payout_held event with 'dispute_open' for rows that are already held.

### M20. Only `payment.captured` is consumed; refund, transfer and chargeback outcomes are never reconciled

- **Status:** Open
- **Where:** `apps/web/app/api/v1/webhooks/razorpay/route.ts:44`
- **Raised by:** 1 finding from 1 audit team (Payments and money integrity)
- **Impact:** Refund, payout and chargeback state drifts from Razorpay, against rule 2 that webhooks are the only payment truth. Buyers can be left unrefunded and chargeback losses go unnoticed.
- **Fix:** Handle refund.processed/failed, transfer.processed/failed/reversed and payment.dispute.created/lost in the webhook. Store the gateway status and mark rows processed or paid only from the webhook. Hold payouts on dispute.created. Paginate reconciliation (`skip`) until the list is exhausted, and alert on refunds stuck pending.

### M21. Checkout sessions never expire at payment time (withdrawn quotes, lapsed pools, expired coupons honoured)

- **Status:** Open
- **Where:** `packages/db/src/migrations/0003_materialize_order.sql:39`
- **Raised by:** 1 finding from 1 audit team (Payments and money integrity)
- **Impact:** Frozen prices and coupons are honoured indefinitely. Providers are bound to quotes they withdrew. The RFQ state machine is violated (cancelled/expired → accepted), and pools produce orphan goods orders.
- **Fix:** In materialize_order (or before it), when now() > expires_at plus a grace period, record the payment but create no order, and auto-refund or queue it for ops. Pass the Razorpay Checkout `timeout` so it matches expires_at. Stop resuming expired sessions in the checkout route. Guard finalize's RFQ claim with `.in('status', ['open','quoted'])`.

### M22. No self-dealing guard: one person can buy from, quote to, review and settle with their own provider profile

- **Status:** Open
- **Where:** `apps/web/app/api/v1/checkout/route.ts:207`, `apps/web/app/api/v1/orders/[id]/review/route.ts:80`
- **Raised by:** 2 findings from 2 audit teams (AuthZ: buyer flows (rfq, orders, checkout, me, profile, pools, webhooks); Payments and money integrity)
- **Impact:** Fraud and chargeback exposure, and corrupted metrics built on paid orders. The payout approval gate is the only control.
- **Fix:** Refuse checkout (package and quote) when the provider's user_id equals the buyer's. Exclude the buyer's own provider profile in fanout and quote submission. Refuse transitions where the actor is both parties. Flag shared bank accounts or phones for ops.

### M23. The model-provider residency and retention guard is off by default

- **Status:** Open
- **Where:** `packages/agent-core/src/llm/gateway.ts:187`
- **Raised by:** 1 finding from 1 audit team (AI agents and LLM security)
- **Impact:** Buyer and provider personal data (DPDP-scoped) may be exported and retained by third parties, contrary to the SECURITY.md commitments. Whether this is actually happening depends on production env and account settings that the code does not enforce.
- **Fix:** Fail closed in production: when NODE_ENV=production and AGENT_ENABLED=true, require either AGENT_RESIDENCY_ENFORCE=true with configured hosts or an explicit, recorded waiver. Send OpenRouter provider preferences per request (`provider: { data_collection: 'deny', zdr: true }`). Run redactContactInfo on the live support message before it reaches the prompt, as is already done for the stored copy.

### M24. The platform AI budget can be drained from outside the cohort; the Mart catalog agent and speech-to-text bypass it

- **Status:** Open
- **Where:** `apps/web/lib/mart/catalog-agent.ts:152`
- **Raised by:** 1 finding from 1 audit team (AI agents and LLM security)
- **Impact:** Low-cost denial of service of every AI feature, plus unbounded vendor spend on the paths that skip the budget. SECURITY.md claims the budget 'cannot be bypassed', which these paths contradict.
- **Fix:** Route the catalog agent (and group-buy-agent) through boundedChatJson. Charge STT to the same budget. Split the month cap into per-feature or per-cohort envelopes, or reserve headroom for cohort and ops traffic. Require sells_goods / verified status for catalog drafts. Consider a per-account-age or verified-phone requirement on paid model endpoints.

### M25. next-intl 3.26.5 middleware open redirect (GHSA-8f24-v5vv-gm5j)

- **Status:** Mitigated (wave 1). The middleware answers 400 for encoded or decoded control characters and backslashes, and replaces any off-origin redirect from next-intl with `/`. The next-intl v4 upgrade stays open
- **Where:** `apps/web/middleware.ts:56`
- **Raised by:** 1 finding from 1 audit team (Supply chain, CI/CD, infra config, mobile app)
- **Impact:** Phishing and credential or OTP theft that borrows the production domain's trust, and it defeats link-domain checks. This was verified against the library locally, not against production: Vercel or Next could normalise %09 before the middleware sees it.
- **Fix:** Upgrade next-intl to >=4.9.1. This is a major version, so migrate the routing and request APIs. As an interim guard at the top of middleware(): if decodeURIComponent(pathname) contains control characters (\x00-\x1F), a backslash, or a leading '//', redirect to '/'. After calling nextIntl, if a Location header exists and its origin differs from request.nextUrl.origin, replace it with a same-origin redirect.

### M26. The agent-runtime deploy workflow trusts a mutable action ref and `latest` flyctl next to FLY_API_TOKEN

- **Status:** Open
- **Where:** `.github/workflows/agent-runtime.yml:38`
- **Raised by:** 1 finding from 1 audit team (Supply chain, CI/CD, infra config, mobile app)
- **Impact:** The Fly token lets an attacker deploy code, or `fly ssh`/read secrets if it is an org token, to the runtime, which holds SUPABASE_SERVICE_ROLE_KEY and DATABASE_URL, so this is a path to a full database compromise outside code review. GitHub branch protection is not enforced on this plan, which makes the workflow the only gate.
- **Fix:** Pin every action to a full commit SHA, and pin the flyctl version (`with: version: x.y.z`). Move FLY_API_TOKEN into a GitHub Environment 'production' restricted to master, with required reviewers if available, and set `environment: production` on the job. Use an app-scoped deploy token (`fly tokens create deploy -a amc-agent-runtime`). Add `if: github.ref == 'refs/heads/master'`, a `concurrency: {group: fly-deploy, cancel-in-progress: false}` block and `permissions: contents: read`. Test the secret via env (`env: T: ${{ secrets.FLY_API_TOKEN }}` then `[ -n "$T" ]`). Add a root .dockerignore (.git, **/node_modules, **/.env*, docs, apps/web, apps/mobile), use `pnpm deploy --prod`, and set `USER node` in the run stage.

### M27. next 15.5.19 is below the patched releases (image optimizer, SSRF, cache and DoS advisories)

- **Status:** Fixed in code (wave 1). next and eslint-config-next 15.5.26
- **Where:** `apps/web/package.json:55`
- **Raised by:** 1 finding from 1 audit team (Supply chain, CI/CD, infra config, mobile app)
- **Impact:** Current production exposure on Vercel is probably limited. But the deployed framework carries a critical RCE advisory whose preconditions (AVIF on, an attacker-reachable remote pattern) the app's own config meets, so any hosting change or self-hosted run is exposed. The cache-confusion advisories concern server-side fetch with request bodies, which the agent and LLM calls make.
- **Fix:** Bump next and eslint-config-next to >=15.5.24 (the latest 15.5.x) and pin the version exactly. Narrow images.remotePatterns to the project host and path (see the separate finding). Add a CI check, for example the npm bulk-advisory endpoint or `pnpm audit --prod --audit-level high`, that fails on high or critical advisories in runtime dependencies.

### M28. The state-machine rule is not enforced by the DB, the types or lint; status literals are spread through the apps

- **Status:** Open
- **Where:** `packages/db/src/migrations/0000_robust_phalanx.sql:262`
- **Raised by:** 1 finding from 1 audit team (Architecture and code health)
- **Impact:** CLAUDE.md hard rule 8 is aspirational. Neither the compiler, the database nor lint catches drift.
- **Fix:** Add CHECK constraints (or enums) on the core status columns, generated from ORDER_STATUSES/RFQ_STATUSES/PAYOUT_STATUSES. Generate `Database` types (supabase gen types or Drizzle) and type the admin, public and session clients. Export ORDER_STATUS/RFQ_STATUS named maps. Replace local lists with the shared groupings (ORDER_DONE_STATUSES, ORDER_IN_FLIGHT_STATUSES, PAYOUT_RELEASE_STATUSES). Add a lint ratchet, like client-money.ts, that forbids status literals outside packages/shared.

### M29. Tax and money formulas are duplicated outside shared, on different bases

- **Status:** Open
- **Where:** `apps/web/lib/orders/transitions.ts:115`
- **Raised by:** 1 finding from 1 audit team (Architecture and code health)
- **Impact:** Latent today (rate_bps = 0), but books and invoices will not match the money actually moved (26Q / GSTR reconciliation). This is a different angle from the known 'payout excludes GST' item.
- **Fix:** Move TDS and commission-GST into packages/shared/money.ts: one `computeTds({ basisPaise, rateBps, thresholdPaise })` with the CA-confirmed basis and one `commissionInvoiceAmounts`, both unit-tested. Use them in schedulePayout, documents-agent, invoices and the transfer amount. Use a single goods line-item builder for totals.ts, pools.ts and goods-rfq.ts.

### M30. Three different contact-masking rule sets; the weakest one guards pre-payment human messages

- **Status:** Open
- **Where:** `packages/shared/src/rfq.ts:49`
- **Raised by:** 1 finding from 1 audit team (Architecture and code health)
- **Impact:** Off-platform deals and payments bypass escrow, dispute protection and commission. Agent-written text is held to a stricter rule than human-written text. This is distinct from the known unmasked RFQ title/details.
- **Fix:** Build one masker in shared from CONTACT_PATTERNS with Indic-digit folding, use it inside both redactContactInfo and stripContactInfo, and drive it with shared table-based test fixtures.

### M31. CI does not exercise the production configuration, and apps/web has no unit tests

- **Status:** Open
- **Where:** `.github/workflows/ci.yml:52`
- **Raised by:** 1 finding from 1 audit team (Architecture and code health)
- **Impact:** Live money and agent paths are untested at merge time, and one gate the docs describe as enforced does not exist.
- **Fix:** Add `pnpm --filter @amclub/web mart:static` to ci.yml. Add vitest to apps/web for the pure lib modules (coupons, transition rule tables, agent scope/token minting). Move evaluateCoupon into shared with tests. Set COUPONS_ENABLED=true on the :3001 production-flags server and run verify-phase6 and the stub-model agent rigs there.

### M32. The pg-boss queue `agent.munshi.growth` is never created, so the weekly job is silently dropped

- **Status:** Open
- **Where:** `apps/agent-runtime/src/worker.ts:260`
- **Raised by:** 1 finding from 1 audit team (Reliability, scalability and operability)
- **Impact:** S2.4's weekly growth nudges never run in production, and the monitoring shows the job as healthy. Any future queue added the same way would fail silently too.
- **Fix:** Add `await boss.createQueue(MUNSHI_GROWTH_QUEUE, { name: MUNSHI_GROWTH_QUEUE, retryLimit: 0 })`. Treat a null jobId without a singleton collision as an error (503), record `enqueued: jobId != null` in the heartbeat, and add a test that every queue the worker sends to has been created.

### M33. Inbound WhatsApp messages can be stored but never processed, invisibly to the health check

- **Status:** Open
- **Where:** `apps/agent-runtime/src/whatsapp/inbound.ts:106`
- **Raised by:** 1 finding from 1 audit team (Reliability, scalability and operability)
- **Impact:** STOP requests, onboarding answers and procurement or support replies are never handled, and no one is alerted. An unhonoured STOP is a consent-compliance problem.
- **Fix:** Exit the process if startWorker fails so Fly restarts it. Report worker state and DATABASE_URL in /health. Either enqueue inside the same transaction as the insert (pg-boss send with the `db` option) or sweep 'received' rows older than about a minute. Return 5xx on non-duplicate insert errors so the vendor retries.

### M34. The public WhatsApp webhook downloads media synchronously, with no size cap or timeout, before its duplicate check

- **Status:** Open
- **Where:** `apps/agent-runtime/src/whatsapp/inbound.ts:85`
- **Raised by:** 1 finding from 1 audit team (Reliability, scalability and operability)
- **Impact:** The only runtime machine can run out of memory and restart, which interrupts every agent job and the webhook. The wa-media bucket also fills with files from unknown numbers.
- **Fix:** Store the message first and download media asynchronously in the job. Enforce a maximum size (check Content-Length and cap the stream) and a MIME allowlist, skip media from unknown or non-opted-in numbers, and add fetch timeouts.

### M35. Cron heartbeats only prove the job ran; failed runs stay green and handled errors never reach Sentry

- **Status:** Open
- **Where:** `apps/web/app/[locale]/(admin)/admin/page.tsx:32`
- **Raised by:** 1 finding from 1 audit team (Reliability, scalability and operability)
- **Impact:** Failures in the money, Mart and agent pipelines go unnoticed until users complain.
- **Fix:** Store an ok/degraded status in each heartbeat and render last_result. Show a row as amber when the result reports failures (payouts failed > 0, enqueued=false). Add pool-close and data-foundations to CRON_JOBS. Call Sentry.captureException in cron catch blocks and on payout_failed and refund errors. Give the runtime Sentry, or a log drain with alerts. Set Sentry's environment from VERCEL_ENV, and alert on stale heartbeats (Sentry Cron Monitors or an uptime check).

### M36. An Upstash error makes every rate-limited route return 500, and a slow Upstash adds 5 s per request

- **Status:** Open
- **Where:** `apps/web/lib/rate-limit.ts:110`
- **Raised by:** 1 finding from 1 audit team (Reliability, scalability and operability)
- **Impact:** An outage at the third-party rate limiter takes down sign-in and checkout.
- **Fix:** Wrap limit() in try/catch. Fail open for low-risk routes (with a log and a Sentry event) and fail closed only for cost-bearing ones (OTP, KYC, voice), ideally with a small in-memory fallback. Lower `timeout` to about 1 s.

### M37. Outbound calls (Resend, Surepass, MSG91, WhatsApp, Razorpay) have no timeouts and run inline in money paths

- **Status:** Open
- **Where:** `apps/web/lib/notifications/channels.ts:67`
- **Raised by:** 1 finding from 1 audit team (Reliability, scalability and operability)
- **Impact:** Slowness cascades into function timeouts on money paths, crons finish only part of their batch, and users see generic errors.
- **Fix:** Add a timeout, such as `AbortSignal.timeout(5000)`, to every outbound fetch and to the Razorpay client. Move notification delivery out of the webhook and cron critical paths into an outbox table processed by a worker with retry and backoff.

### M38. Crons write the new status first and are never re-driven when the side effects fail; money crons set no maxDuration

- **Status:** Open
- **Where:** `apps/web/lib/orders/transitions.ts:407`
- **Raised by:** 1 finding from 1 audit team (Reliability, scalability and operability)
- **Impact:** The provider is silently never paid, because no payout row exists for ops to release. Tax invoices and notifications are also missing.
- **Fix:** Process small batches within a time budget, and set an explicit maxDuration. Add a sweeper that calls schedulePayout and generateInvoices, both already idempotent, for completed or resolved orders that are missing them. Alternatively, write the status and the payout row together in one RPC transaction.

### M39. Reconciliation reads only the first 100 Razorpay payments and never flags a second capture

- **Status:** Partly fixed (wave 2, ADR 026). The captured-payment scan pages through the whole window (up to 5,000). Flagging a second capture on one Razorpay order is still open
- **Where:** `apps/web/lib/payments/razorpay.ts:257`
- **Raised by:** 1 finding from 1 audit team (Reliability, scalability and operability)
- **Impact:** Once volume grows past very low levels, buyers are charged with no order created. Double charges are never refunded, and the 'recovered' metric is misleading.
- **Fix:** Page with `skip` until the list is exhausted, or slice the window. When a session is already materialised under a different payment id, record the new payment as a duplicate and refund it or flag it for ops. Count only newly created orders as recovered.

### M40. Quote and group-offer scope / message text reaches buyers without contact masking

- **Status:** Open
- **Where:** `apps/web/lib/rfq/quote-terms.ts:109`
- **Raised by:** 1 finding from 1 audit team (Server-rendered pages: service-role data serialized into client components, and public ISR pages)
- **Impact:** A pre-order contact channel that bypasses the platform (NOT-NOW §8.3: pre-order provider chat) and undermines the masking already built for clarifications and quote threads. This is the provider→buyer direction; the already-reported finding covers buyer RFQ text.
- **Fix:** Apply redactContactInfo (with scope_redacted/message_redacted flags, like rfq_clarifications) in quoteRowColumns for both POST and PATCH and in the pool offer insert. Backfill existing quotes/offers, and add the injection/contact cases to the quote rig.

### M41. A WhatsApp conversation stays bound to a user after a phone change

- **Status:** Open
- **Where:** `apps/agent-runtime/src/whatsapp/inbound.ts:125`
- **Raised by:** 1 finding from 1 audit team (Agent runtime job handlers and WhatsApp identity binding (about 3,000 unread lines on the service role))
- **Impact:** A third party can read another account's private order and RFQ data and take agent actions in its name: send binding quotes and messages to buyers, create RFQs, decline quotes. It also receives all proactive agent messages meant for the account. No money moves, because payment still needs the web session. Consent and STOP state can be changed by the wrong person.
- **Fix:** On every inbound message, re-derive the owner. If users.phone for conv.user_id is not '+'+phone_e164, or a different user now holds that phone, unbind the conversation: set user_id to null and clear active_session_id, procurement_session_id and support_ticket_id. Also revoke WhatsApp grants whose channel_identity is '+'+phone_e164, and cancel open Munshi drafts and procurement proposals that were delivered there. Tie consent and delivery to the phone, not the user: require grant.channel_identity = '+'+conv.phone_e164 in activeWhatsAppGrant, enabledProviders.waByUser and buyerGrant.whatsapp. Make conversationFor select the conversation whose phone equals the user's current users.phone, not the most recent inbound. Keep public.users.phone in sync with auth.users.phone (trigger or auth hook). Add a trigger that nulls wa_conversations.user_id when the matching users.phone changes.

### M42. A typed or spoken "yes" is captured by Munshi before procurement and approves the wrong proposal

- **Status:** Open
- **Where:** `apps/agent-runtime/src/agents/munshi/index.ts:917`
- **Raised by:** 1 finding from 1 audit team (Agent runtime job handlers and WhatsApp identity binding (about 3,000 unread lines on the service role))
- **Impact:** The confirmation gate for a money-adjacent, binding action (a price quote or a message to a buyer) can be met by a 'yes' meant for a different proposal or a different agent. The platform then sends an offer the provider did not intend, and the buyer's own request is silently dropped.
- **Fix:** Bind free-text confirmations to exactly one open proposal. If the user has more than one open confirmable proposal across Munshi, procurement and support (or more than one Munshi draft), never approve on text. Re-send the buttons, or ask which one. Use the inbound context.id (the quoted wa_messages row carrying run_id) to pick the proposal when present. Check for an active procurement session with an open proposal before the Munshi utterance branch, or make routeMunshiInbound skip text when one exists. Limit Munshi's utterance capture to a short window after the latest draft instead of 24 hours.

### M43. The payout dossier puts party-authored order titles in TRUSTED prompt parts

- **Status:** Open
- **Where:** `apps/agent-runtime/src/agents/payout-dossier/index.ts:183`
- **Raised by:** 1 finding from 1 audit team (Agent runtime job handlers and WhatsApp identity binding (about 3,000 unread lines on the service role))
- **Impact:** The recommendation shown to the founder for releasing held payouts, and the later dispute-triage card, can be steered by one party. PAYOUT_AUTO_RELEASE is off, so a human still decides. The risk is to the integrity of a money decision aid.
- **Fix:** Pass the title as envelope(ev.order.title, { kind: 'order_title', id: ev.order.id }), or drop it and rely on category_slug. Move the dossier parts construction into agent-core as buildPhotoPlausibilityParts, with the same 'no untrusted string in trusted' unit test the other parts builders have.

### M44. A group (pool) quote can be re-priced, or its GST mode flipped, after close via the ordinary quote PATCH

- **Status:** Open
- **Where:** `apps/web/app/api/v1/rfq/[id]/quote/route.ts:332`
- **Raised by:** 1 finding from 1 audit team (S3.4 services demand pools: detection, tier pricing and the close path that writes quotes)
- **Impact:** The group-price guarantee, the basis of ADR 024's argument that pools are not the negotiation or auction that §8.3/ADR-013 forbid, is not enforced. It allows bait-and-switch: a provider wins commitments with a deep volume tier, then re-prices after competitors' pool offers have been shut out. No money moves without consent, because the buyer pays only if they accept the revised quote at checkout, and the rest of the buyer's request is unaffected.
- **Fix:** Mark group quotes, e.g. add `quotes.pool_offer_id` or look up `service_pool_members.quote_id`. Refuse PATCH on them with 409 `pool_quote_fixed`, or allow only a lower price with the same gst_included. Add a verify-pools criterion: a PATCH on a group quote is refused and the price stays at the achieved tier.

### M45. A provider can read competitors' sealed pool offers by joining the pool through their own buyer profile

- **Status:** Open
- **Where:** `apps/web/lib/pools/queries.ts:75`
- **Raised by:** 1 finding from 1 audit team (S3.4 services demand pools: detection, tier pricing and the close path that writes quotes)
- **Impact:** Competitors' confidential price schedules and live commit counts leak to a rival provider. Pools can then be run as sequential undercut bidding, which is the bidding-war dynamic on the §8.3 NOT-NOW list that sealing was meant to prevent. The fake request also fans out to real providers as noise. Precondition: a cohort user with a buyer profile, which every provider can create for themselves.
- **Fix:** In detection and in memberAction('join'), refuse a request whose buyer user also owns a provider_profiles row. At minimum refuse one listed in the pool's category or with an offer in the pool. In poolBuyerView, return no offers when the viewing user has a provider profile. Consider showing buyers only the tiers, not competitors' committedCount. Add a verify-pools case: a dual-role member gets no competitor offers.

### L1. Admin `manual_refund` does not hold the payout, so a refund and a full payout can both go out

- **Status:** Open
- **Where:** `apps/web/app/api/v1/admin/orders/[id]/route.ts:82`
- **Raised by:** 1 finding from 1 audit team (AuthZ: admin, cron and misc routes)
- **Impact:** The platform funds the difference out of its own balance. ADR-014 made planDisputeSettlement the one rule that keeps refund and payout rows coherent, and manual_refund is a second money path outside that rule. Only admin or ops can trigger it, so this is an integrity or mistake risk, not an external exploit.
- **Fix:** Route manual_refund through the ADR-014 settlement planner, or add the same guards: refuse when the payout is paid or processing (409 provider_already_paid / payout_in_flight). Otherwise set the payout to held and require an explicit decision, reducing or cancelling it, in the same audited action. Make the payout release routes refuse when a refund exists for the order unless the planner allows it. Add a money-rig criterion.

### L2. `buyer_licences.certificate_path` is client-writable, and the certificate routes sign whatever path the row holds

- **Status:** Open
- **Where:** `packages/db/src/migrations/0054_licences_obligations.sql:60`
- **Raised by:** 1 finding from 1 audit team (Database: RLS, grants, functions, views, storage)
- **Impact:** Cross-tenant read or delete of private licence certificates (FSSAI, factory licences and similar). Exploitation needs the target object key, which is not easily guessable, hence medium. It is a structural flaw: a service-role signer trusts a client-writable storage pointer.
- **Fix:** Run `REVOKE UPDATE ON buyer_licences FROM authenticated; GRANT UPDATE (licence_type, licence_number, issued_on, expires_on, authority, deleted_at) ON buyer_licences TO authenticated;` and write certificate_path with the admin client. Also, in signedCertificateUrl and storeLicenceCertificate, require `certificate_path.startsWith(`${lic.msme_id}/${licenceId}/`)` before signing or removing, as credentialDocumentRef does for KYC.

### L3. The agent runtime holds the full service-role key and DATABASE_URL in the process that parses public webhooks

- **Status:** Open
- **Where:** `apps/agent-runtime/src/whatsapp/inbound.ts:147`, `apps/agent-runtime/src/deps.ts:36`
- **Raised by:** 2 findings from 2 audit teams (Architecture and code health; Supply chain, CI/CD, infra config, mobile app)
- **Impact:** This contradicts ADR-008 ('never service-role for user data'), and the blast radius of any runtime compromise is the entire production database, not just agent telemetry.
- **Fix:** Give pg-boss a dedicated Postgres role that owns only the pgboss schema. Move user-data reads and writes (phone → user lookup, grant writes, onboarding sessions, demand aggregates) behind /api/v1 routes called with the runtime HMAC and a delegated token, or behind SECURITY DEFINER functions granted to a narrow role. Keep the service-role key only if the telemetry tables truly need it, and consider moving image decoding (sharp) into a separate sandboxed worker.

### L4. The pool "Pay ₹X to confirm" amount is computed on the client before GST (web and mobile)

- **Status:** Open
- **Where:** `apps/web/components/mart/PoolJoin.tsx:110`
- **Raised by:** 1 finding from 1 audit team (Architecture and code health)
- **Impact:** The displayed price differs from the amount charged on a live Mart surface. This breaks the E4/N16 'render only the server display' rule and total-price disclosure expectations.
- **Fix:** Return the member's server-computed display/totalPaise from the pool API and render only that. Extend the client-money ratchet to apps/mobile and shrink the baseline.

### L5. Money and policy switches live in the agent registry, whose only editor sits behind AGENT_ENABLED

- **Status:** Open
- **Where:** `apps/web/app/api/v1/agent/admin/settings/route.ts:34`
- **Raised by:** 1 finding from 1 audit team (Architecture and code health)
- **Impact:** Unrelated kill switches are coupled, config ownership is unclear, and dead flag-off code paths persist and must be defended by rigs.
- **Fix:** Split out a `platform_settings` registry for money and policy keys: admin-only, not behind the agent gate, audited. Keep agent_settings for agents. Delete EXP_V3 flags that are 'on' for everyone along with their flag-off branches. Keep a flag inventory with an owner and expiry per flag.

### L6. Docs drift: seven sampled CLAUDE.md claims are false or contradictory

- **Status:** Open
- **Where:** `CLAUDE.md:107`
- **Raised by:** 1 finding from 1 audit team (Architecture and code health)
- **Impact:** The governance document no longer describes the system, and one statement may mean a money feature is on without its prerequisites.
- **Fix:** Check production agent_settings.bundles_enabled and tenders_enabled now. Correct the CLAUDE.md statements (or implement RFQ cancel and completed→reviewed, or remove them from the machines). Generate the flag and rig inventory sections from code in CI so they cannot drift.

### L7. Hot, growing tables lack indexes (`notifications` has none and is polled every 30 s per tab)

- **Status:** Open
- **Where:** `packages/db/src/migrations/0000_robust_phalanx.sql:401`
- **Raised by:** 1 finding from 1 audit team (Reliability, scalability and operability)
- **Impact:** Database CPU grows with users × notifications. With a few hundred concurrent users and 10^5 to 10^6 rows, these polls dominate Postgres and slow every API.
- **Fix:** Add `CREATE INDEX notifications_user_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL` and a `(user_id, created_at DESC)` index. Add payments(order_id), checkout_sessions(order_id), orders(quote_id), quotes(provider_id, created_at), rfq_matches(provider_id, notified_at) and payouts(status, scheduled_for). Rewrite the policies to `(select auth_user_id())` so it is evaluated once per query, and run the Supabase performance advisors.

### L8. The goods order page sends the seller's payout (amount, status, schedule) to the buyer

- **Status:** Open
- **Where:** `apps/web/lib/mart/order-extras.ts:27`
- **Raised by:** 1 finding from 1 audit team (Server-rendered pages: service-role data serialized into client components, and public ISR pages)
- **Impact:** The buyer learns the seller's net take and margin and whether the seller's payout is held (which signals suspension, an unverified bank account or a dispute). This is new: the API route does not return payouts.
- **Fix:** Pass viewerRole into getGoodsOrderExtras and return payout: null (skip the query) for the buyer, mirroring the services gate at queries.ts:113. Better still, fold this into the role-shaped OrderView DTO.

### L9. Two concurrent (or resumed) pool closes can release the quote slot the pool's own quote holds

- **Status:** Open
- **Where:** `apps/web/lib/pools/close.ts:162`
- **Raised by:** 1 finding from 1 audit team (S3.4 services demand pools: detection, tier pricing and the close path that writes quotes)
- **Impact:** quote_count under-counts by one per affected member, so each affected request can receive more than the 7-quote cap (a Phase-5 done criterion). Member state becomes inconsistent (skipped but carrying a quote_id). B's run may send "Your group has ended" to a buyer who does have a group quote, and closing counts and events are wrong. No money moves.
- **Fix:** On 23505, read the existing (rfq, provider) quote. If it is this pool's quote (e.g. a new `quotes.pool_member_id` column or partial unique index, or a 'submitted' quote_event with pool_offer_id = o.id), link it and do NOT release the slot; release only for a genuine direct quote. Better: do insert + link in one SQL function that locks the member row (return early if quote_id is set). Also take a per-pool lease in closePool, e.g. a CAS on a `closing_run_id` / `closing_started_at` column or pg_try_advisory_xact_lock through an RPC. Add a concurrent-close case to verify-pools.

## Appendix B — low / info observations not put through verification

Raised by the audit teams at low or info severity. They were not adversarially checked, so treat each as a lead to confirm before fixing. Several overlap confirmed issues above.

| # | Severity | Where | Observation |
|---|---|---|---|
| 1 | low | `.github/workflows/ci.yml:40` | Third-party GitHub Actions and CI images pinned to mutable tags; no least-privilege `permissions:` in any workflow; unverified tool download; workflow input interpolated into shell |
| 2 | low | `apps/agent-runtime/src/server.ts:57` | Losing a resume race marks the winning run failed and finalizes the draft or session as failed |
| 3 | low | `apps/agent-runtime/src/server.ts:66` | Runtime credential is not bound to audience, endpoint or body; /internal/jobs does not tie claims.userId to the job's userId |
| 4 | low | `apps/agent-runtime/src/server.ts:88` | Agent runtime reads the whole request body before any authentication and has no body-size limit (single 512 MB machine) |
| 5 | low | `apps/agent-runtime/src/whatsapp/inbound.ts:188` | STOP does not halt an active onboarding interview; the dispatcher and in-window sends ignore the revoked grant |
| 6 | low | `apps/mobile/app/(app)/checkout/[packageId].tsx:25` | Mobile checkout deep link can show one package and buy another (display and purchase use independent URL params) |
| 7 | low | `apps/mobile/lib/analytics.ts:10` | Mobile analytics capture ignores the analytics-consent gate that production web enforces |
| 8 | low | `apps/web/app/api/v1/admin/kpi/route.ts:33` | KPI dashboard and payout counts are silently truncated by PostgREST max_rows (1000) |
| 9 | low | `apps/web/app/api/v1/admin/kpi/route.ts:33` | PostgREST's 1000-row cap silently truncates the admin KPIs and several batch jobs |
| 10 | low | `apps/web/app/api/v1/admin/msmes/[id]/route.ts:53` | Admin write errors are swallowed: routes report success and write audit rows for changes that did not happen |
| 11 | low | `apps/web/app/api/v1/admin/payouts/route.ts:55` | Raw Postgres error.message returned to clients in several routes, bypassing the serverError() helper |
| 12 | low | `apps/web/app/api/v1/agent/grants/route.ts:55` | Grants API does no persona-to-role check and lets users grant themselves tools the design withholds (place_order, accept_quote) |
| 13 | low | `apps/web/app/api/v1/agent/token/route.ts:53` | Runtime token path trusts self-insertable agent_grants for persona. A user can hold an 'ops' or 'provider' grant, and Support derives its token persona from the grant row. |
| 14 | low | `apps/web/app/api/v1/checkout/route.ts:287` | Checkout accepts a quote after its stated valid_until date |
| 15 | low | `apps/web/app/api/v1/cron/rfq-expire/route.ts:167` | If quote_window_hours is set, the quote-window sweep auto-declines the matches that pool offers rely on, so members are skipped at close |
| 16 | low | `apps/web/app/api/v1/mart/pools/[id]/checkout/route.ts:44` | An amount mismatch leaves captured money with no order, no refund and no durable alert; pool checkout builds the gateway amount from live data |
| 17 | low | `apps/web/app/api/v1/mart/seller/images/route.ts:18` | Seller image upload has no rate limit, no seller-state check and no decoder limits |
| 18 | low | `apps/web/app/api/v1/mart/seller/products/route.ts:56` | The product image ownership check is a plain prefix match, so a seller can reference another seller's images through '..' |
| 19 | low | `apps/web/app/api/v1/mart/seller/products/route.ts:95` | catalog_draft ai_decisions rows store client-supplied, unbounded 'proposed' and input_refs |
| 20 | low | `apps/web/app/api/v1/orders/[id]/transition/route.ts:27` | Rate limiting is opt-in; 40 mutating routes have none, including order transitions and quote messages |
| 21 | low | `apps/web/app/api/v1/partner/packages/[id]/route.ts:73` | Partner package writes go through the RLS session client, so direct PostgREST writes skip packageSchema limits (no DB CHECKs) |
| 22 | low | `apps/web/app/api/v1/profile/provider/settings/route.ts:56` | A provider can undo an admin-forced capacity pause |
| 23 | low | `apps/web/app/api/v1/quotes/[quoteId]/messages/route.ts:79` | Quote-thread messages have no rate limit, and suspended or rejected providers can still message buyers and reply to reviews |
| 24 | low | `apps/web/lib/invoices/generate.ts:63` | Refunds after an invoice issue no credit note, and the commission invoice is never adjusted |
| 25 | low | `apps/web/lib/jobs/cron-auth.ts:11` | Cron secret compared with a non-constant-time ===; the payouts cron exposes a test-only '?all=true' switch in production |
| 26 | low | `apps/web/lib/mart/pools.ts:178` | Public Mart pool pages (ISR) and the OG image ignore seller/product status, and the OG image renders draft/cancelled pools |
| 27 | low | `apps/web/lib/mart/pools.ts:364` | One member, or the pool's own seller, can single-handedly flip a goods pool to closed_met |
| 28 | low | `apps/web/lib/mart/pools.ts:705` | Queries that use LIMIT without ORDER BY starve or pick the wrong rows (Mart settlement, GSTIN recheck, top-rated strip) |
| 29 | low | `apps/web/lib/orders/transitions.ts:112` | Goods TDS is recorded on the payout but never withheld from the transfer |
| 30 | low | `apps/web/lib/orders/transitions.ts:305` | Inconsistent API error contract and logging: raw Postgres messages and English prose reach users, and Sentry is barely used |
| 31 | low | `apps/web/lib/payments/materialize.ts:76` | The 'placed' side-effects marker is check-then-insert, so concurrent webhook deliveries send duplicate notifications |
| 32 | low | `apps/web/lib/payments/simulation.ts:17` | The simulation guard keys off the VERCEL_ENV label rather than the database it writes to |
| 33 | low | `apps/web/lib/pools/close.ts:139` | Pool-status checks are not atomic with the writes; claim uses a fresh committed_offer_id the pre-check never saw; a claimed slot can leak with no quote |
| 34 | low | `apps/web/lib/pools/close.ts:74` | After buyers commit, the provider can shrink the claimed count (decline or directly quote one member) so the rest get a dearer tier |
| 35 | low | `apps/web/lib/pools/queries.ts:75` | Invitees who never joined can see every offer's prices once the pool closes, lapses or is cancelled |
| 36 | low | `apps/web/lib/rate-limit.ts:126` | Rate-limit / view-beacon IP key taken from leftmost X-Forwarded-For (spoofable depending on edge config) |
| 37 | low | `apps/web/lib/rfq/attachments.ts:35` | RFQ attachment uploads keep the client-declared image/* content type with no magic-byte sniffing |
| 38 | low | `apps/web/lib/rfq/attachments.ts:80` | RFQ attachments accept any URL string with no ownership check; providers get raw external links or signed URLs for any rfq-attachments path |
| 39 | low | `apps/web/lib/rfq/attachments.ts:80` | RFQ attachments accept any URL string; links outside the bucket are passed through as clickable 'attachments' to matched providers |
| 40 | low | `apps/web/lib/rfq/attachments.ts:80` | Non-bucket attachment URLs and names pass through to matched providers unvalidated (any scheme, no contact masking) |
| 41 | low | `apps/web/lib/rfq/queries.ts:339` | The provider matched-RFQ read is unbounded and builds large IN lists whose errors are ignored |
| 42 | low | `apps/web/lib/rfq/quote-terms.ts:109` | Quote scope and message, and pool offer scope and message, reach buyers without contact masking |
| 43 | low | `apps/web/lib/rfq/release.ts:30` | releaseDeferredRfq does not re-check status or deleted_at in its CAS, so a cancel race can fan out a cancelled request |
| 44 | low | `apps/web/lib/support/nudge.ts:72` | Check-then-insert caps on nudges and clarifications can be raced into WhatsApp spam |
| 45 | low | `apps/web/next.config.ts:52` | Image optimizer and CSP trust every *.supabase.co tenant, not just this project |
| 46 | low | `apps/web/scripts/verify-authz.ts:24` | Verification rigs default to the production URL and hard-delete money rows with the service-role key, with no guard |
| 47 | low | `apps/web/scripts/verify-authz.ts:57` | Verification suites that are run against production create email/password users, including admin-role users, with the static password 'Test1234!' |
| 48 | low | `packages/agent-core/src/runner/index.ts:117` | The agent money-route denylist misses the Mart money routes, and the transition scope covers every action |
| 49 | low | `packages/agent-core/src/runner/index.ts:173` | Tool route resolution interpolates unvalidated payload ids into URL paths; the user-supplied `final` and a resume context without scopes can retarget a confirmed tool |
| 50 | low | `packages/agent-core/src/support/parts.ts:40` | Buyer-written RFQ titles go into the TRUSTED prompt section of the provider's Support classifier and ticket summary |
| 51 | low | `packages/db/src/migrations/0023_mart_pools.sql:176` | pools.rationale (seller 30-day sales volume and up to 50 order ids) is readable by anon through "pools: public read live" |
| 52 | low | `packages/db/src/migrations/0023_mart_pools.sql:222` | pool_events lets any pool member read every co-member's events (user ids, quantities, checkout amounts, order ids, defaults) |
| 53 | low | `packages/db/src/migrations/0027_agent_foundation.sql:149` | agent_grants self-INSERT accepts any persona and scopes; the runtime token path unions stored scopes without re-validating them |
| 54 | low | `packages/db/src/migrations/0064_server_written_money.sql:58` | Money, ledger and audit tables still grant TRUNCATE, REFERENCES and TRIGGER to anon and authenticated (only INSERT, UPDATE and DELETE were revoked) |
| 55 | low | `packages/db/src/rls/policies.sql:13` | has_role() and auth_user_id() are SECURITY DEFINER without a pinned search_path |
| 56 | low | `packages/db/src/rls/policies.sql:164` | Admin/ops FOR ALL policies plus the untouched default write grants let an admin or ops JWT write catalogue and verification tables directly, bypassing audit logging |
| 57 | low | `packages/db/src/rls/policies.sql:208` | Matched providers can read an open RFQ's voice transcript, quality report and CAD features directly through PostgREST, though the API never returns them to providers |
| 58 | low | `packages/db/src/rls/policies.sql:803` | Parties can read all order_events payloads (payout hold reasons, ops audit details) directly through PostgREST |
| 59 | info | `apps/agent-runtime/src/agents/dispute-triage/index.ts:320` | Job handlers do not cross-check related ids in the payload (dispute_triage disputeId vs orderId; onboarding message vs session owner) |
| 60 | info | `apps/agent-runtime/src/server.ts:66` | Runtime credential is not bound to the request, and the public /health endpoint lists missing secrets |
| 61 | info | `apps/mobile/lib/api.ts:12` | Very large files and hand-typed API contracts raise web/mobile drift risk |
| 62 | info | `apps/mobile/lib/supabase.ts:5` | Mobile release configuration is incomplete: Supabase URL/key never provided, API base defaults to cleartext localhost, no EAS config |
| 63 | info | `apps/web/lib/translations/content.ts:107` | Content-translation writeSlot for the 'profile' subject is not bound to the caller's providerId (currently safe only because the route pins subjectId) |
| 64 | info | `docs/RUNBOOK_RESTORE.md:3` | The backup and restore drill is stale and the Supabase plan tier is unverified |
| 65 | info | `docs/adr/024-services-demand-pools.md:6` | Demand pools are live in production without the enablement steps ADR 024 and the runbook require |
| 66 | info | `packages/db/src/migrations/0071_service_pools.sql:209` | No rig proves client roles cannot read or write the service_pool_* tables, and policies.sql has no mirror |
| 67 | info | `pnpm-lock.yaml:1` | Build/dev-only and client-bundled dependencies with open advisories |

## Appendix C — what the teams found done well

Recorded so later changes keep these properties.

- **AuthZ:** Admin role resolution is server-side and hard to spoof: requireAdmin reads users.roles through the service role for both cookie and Bearer callers, and migration 0042 (users_roles_guard trigger plus revoked INSERT/UPDATE/DELETE) stops users writing their own roles. The OAuth callback and profile routes preserve existing roles instead of clobbering them.
- **AuthZ:** The cron guard is uniform and fails closed: all 19 /api/v1/cron routes call verifyCron as the first statement, and in production an unset CRON_SECRET means 403, never open.
- **AuthZ:** The sanctioned money routes (admin/payouts/[id], admin/disputes/[id]/resolve) are careful: zod, adminMutation limiter, requireNotDelegated, CAS/optimistic guards, the goods and services release gates, ADR-014 settlement codes and audit rows.
- **AuthZ:** PostgREST filter-injection is consciously handled: admin/providers strips filter metacharacters before .or(), the reviews keyset cursor is regex-validated before interpolation, universal search uses only plain eq/ilike filters keyed to the caller's own profile ids, and serverError() keeps DB error text out of most responses.
- **AuthZ:** KYC documents are handled well: writers force paths under the caller's own prefix, admin viewing re-checks (verification id, provider id), signs a 15-minute URL on click, and sets Cache-Control no-store and Referrer-Policy no-referrer. Provider logo keys are server-generated, never client paths.
- **AuthZ:** Party checks are consistent across order and RFQ routes: every in-scope order and RFQ handler resolves the caller through resolveActor (suspended buyers become null) and compares msme_id or provider_id before touching data with the admin client. Documents, messages, dispute statements, milestones and licence facts also confirm that referenced document ids belong to the same order.
- **AuthZ:** Payments: the webhook verifies an HMAC over the raw body with timingSafeEqual and refuses to run without a secret in production. materializeFromCapture checks the captured amount against the frozen session total. Materialization is idempotent, and finalize refunds duplicate RFQ orders through a guarded (compare-and-set) state path.
- **AuthZ:** Checkout money is computed only on the server and frozen on the session: add-ons, quote options and coupons are re-resolved on the server, client prices are ignored, simulate checks session ownership, and there is one live checkout per RFQ.
- **AuthZ:** Quote and pool writes use compare-and-set updates on the expected status or revision (decline, withdraw, revise, pool join, commit and close), so replays and races are safe there.
- **AuthZ:** Past hardening is visible: users.roles has a revoke plus trigger (0042), msme_profiles and money tables have writes revoked (0043, 0064), KYC credential references are pinned to the caller's own storage prefix, credential uploads use magic-byte sniffing, and buckets are private with service-role-only signing.
- **AuthZ:** Goods checkout, cart preview and pool checkout take only product ids and quantities from the client. prepareGoodsCheckout re-reads live tiers, MOQ, the BIS block, product status and seller status/sells_goods, then computes every paise column on the server with computeGoodsOrderAmounts, including a GST cross-check. There is no client price path.
- **AuthZ:** Every seller product route resolves ownership through getSellerProduct(seller.id, id) or getSellerCtx on the service role, so there is no IDOR on product reads or writes. Every /api/v1/mart/admin/* route calls martApiGate() + requireAdmin() before anything else, and mutations are rate-limited and audited (writeAudit / product_events).
- **AuthZ:** The pool money path is tightly guarded. prepareMemberCheckout creates a session only when mayCapturePoolMember(pool.status, member.payment_state) holds, uses a deterministic (pool, member) idempotency key, and every state write is guarded on the expected prior state.
- **AuthZ:** Goods order actions check the party first (msme_id/provider_id match), then the per-action role and the allowed from-states. Referenced documents must belong to the same order and be of the right kind. The services transition path refuses kind='goods'.
- **AuthZ:** Partner add-on, milestone and tier-group writes go through ownPackageFor / saveTierGroup (ownership plus requireNotDelegated), and the public tier loader re-checks group ownership. Service-pool offers are sealed, checked for eligibility (fan-out-matched, active, cohort) and coherence-checked with poolTierProblems.
- **Database:** ADR-018 (0064) revokes client writes on every money and order-state table and makes materialize_order, claim/release_quote_slot and increment_coupon_usage service-role only. verify-authz §7a proves it with real tamper attempts on every PR.
- **Database:** Most SECURITY DEFINER functions pin `SET search_path = public`, and the sensitive ones are revoked FROM PUBLIC, anon, authenticated and granted to service_role: score_inputs_*, benchmark_*, refresh_quote_sla_stats, bump_view_count, the checkout triggers, service_pool_claim.
- **Database:** Earlier escalation holes are closed at the DB layer: users (write revoke plus the users_roles_guard trigger, 0042), msme_profiles, messages, order_events and audit_logs (0043), and order_safe_view as security_invoker (0070). Column-level grants hide PAN/GSTIN and quotes.decline_note.
- **Database:** Append-only ledgers (order_events, quote_events, audit_logs, ai_decisions, agent_events, pool_events, score_events, service_pool_events) use a shared raise_append_only trigger in addition to revokes.
- **Database:** Storage is server-mediated: every bucket except public-assets is private, there are no client storage.objects policies, reads use 15-minute signed URLs, KYC paths are prefix-checked (credentialDocumentRef), Mart images are re-encoded, and bank account numbers use app-layer AES-256-GCM with HMAC fingerprints.
- **Payments and money integrity:** Razorpay webhook verifies HMAC-SHA256 over the raw body (`request.text()` before JSON.parse), compares with a length-checked `timingSafeEqual`, refuses to run in production without RAZORPAY_WEBHOOK_SECRET, and returns 400 only for forgeries.
- **Payments and money integrity:** materialize_order is atomic and replay-safe. A single-transaction CAS on checkout_sessions (created → materializing) and the UNIQUE constraints on payments.razorpay_payment_id and razorpay_order_id stop duplicate orders. The order is built only from frozen session amounts, with a captured-amount cross-check (F5). EXECUTE is revoked from anon and authenticated (0064).
- **Payments and money integrity:** ADR-018 is implemented in the schema: client INSERT/UPDATE/DELETE is revoked on orders, checkout_sessions, payments, payouts, refunds, invoices, disputes, coupons, coupon_redemptions, bank accounts and quotes. The money idempotency anchors exist: payouts UNIQUE(order_id), refunds UNIQUE(idempotency_key = rfnd_<order>), invoices UNIQUE(number), disputes UNIQUE(order_id).
- **Payments and money integrity:** Pricing is server-side throughout. Clients send only ids and quantities. Add-ons are re-read by id (409 addon_changed), quote options are pinned to the quote revision, goods prices come from DB tiers with a GST cross-check, and bundle splits give the paise remainder to the last child. All money is integer paise with zod bounds.
- **Payments and money integrity:** Dispute settlement is well engineered: planDisputeSettlement decides before any write, the order claim is a CAS on status plus updated_at (for resumes), paid or processing payouts are never rewritten, the refund amount is read back, and the provider leg runs before the refund. Payouts use a CAS claim (scheduled → processing), an approval gate (PAYOUT_AUTO_RELEASE off) and a fee-headroom guard.
- **AI agents and LLM security:** Runtime HMAC credential is well built. It uses timingSafeEqual on hex, a ±5-minute window and persona enum validation, and is bound to (user, persona, run). The token endpoint's runtime path also requires an active agent_grants row, and the runtime never holds a user's real session.
- **AI agents and LLM security:** The confirm gate is enforced in code, not prompts. AgentRun.proposeTool parks confirm:true tools, and resume() verifies an ai_decisions row bound to (run_id, tool). ai_decisions/agent_runs/agent_events have no client write grants and have update-blocking triggers. Munshi approval needs isUnambiguousYes, and a model 'approve' is explicitly not an approval. Procurement money-adjacent tools are button-only, and scriptedCall refuses checkout/payment/payout/refund/admin paths.
- **AI agents and LLM security:** Untrusted-content boundary is well engineered. Envelope is a branded type with NFKC/homoglyph/invisible-char folding, per-kind caps, tag escaping and provenance. A taint rule blocks non-confirm write tools after untrusted input. customerFacingText output validation (contact/payment/url/approval bans) covers every customer-facing prompt schema, and no model output is rendered with dangerouslySetInnerHTML.
- **AI agents and LLM security:** Live WhatsApp drivers fail closed. Meta uses X-Hub-Signature-256 HMAC with timingSafeEqual and returns false when the app secret is missing; Interakt uses a shared-secret header. Webhook replays are idempotent on vendor_message_id, and button payload run/session ids are cross-checked against the conversation's user.
- **AI agents and LLM security:** Spend and exposure controls: Redis budgets (per run / user-day / month) fail closed in production without Upstash, there are per-route rate limits on paid model endpoints, and cohort gating is applied per agent. agentApiGate comes first on all 48 agent routes. Admin agent routes use requireAdmin, and runtime-callback routes (notify/reminders/tickets) bind claims to the run/user.
- **Web application security:** OAuth callback and post-auth routing consistently run every `next` through the shared safeNext() (protocol-relative // and /\ backslash tricks are blocked, auth-route loops rejected) — only the control-char edge case slips through; the design intent and central choke-point are sound.
- **Web application security:** The Razorpay webhook is a clean single-source-of-truth: HMAC-SHA256 over the raw body with a length-checked timingSafeEqual compare (lib/payments/signature.ts), getWebhookSecret() throws in production if unset, and materialize is idempotent — replay/forgery are handled correctly.
- **Web application security:** Strong CSP and header posture in next.config.ts (frame-ancestors 'none', X-Frame-Options DENY, nosniff, HSTS preload, tight Permissions-Policy, object-src 'none', base-uri/form-action 'self'); the documented 'unsafe-inline' script-src is an accepted, tracked tradeoff.
- **Web application security:** F4 (stored XSS via CMS link/ctaHref) is genuinely fixed: admin/cms/route.ts now validates links with safeHref (https:// or site-relative only, no javascript:/data:) and the only dangerouslySetInnerHTML sinks (JsonLd, low-mem probe) are `<`-escaped or static — no user-content HTML sink remains.
- **Web application security:** Upload routes are well-hardened where it matters: credential-upload does true magic-byte sniffing and derives the extension from the verified type (never the client filename); logos/product images are re-encoded through sharp (stripping any polyglot payload); storage-key path segments are enum-clamped ([a-z_]) so no client string reaches the object key.
- **Web application security:** Personalised API responses (profile/me, orders, me/*) are Cache-Control: private, no-store; only genuinely public catalog/mart/reviews/cms endpoints carry `public, s-maxage`, and the service worker never caches /api/* or navigations — no private-data-at-edge exposure found.
- **Supply chain, CI/CD, infra config, mobile app:** No pull_request_target or workflow_run triggers, and no github.event.* expressions in run: blocks. Repo secrets are scoped to the single step that needs them (the OPENROUTER key only in the eval step). Money rigs run against a disposable `supabase start` stack with throwaway values and never against production.
- **Supply chain, CI/CD, infra config, mobile app:** Lockfile hygiene: all 1,501 lockfile entries resolve from the npm registry with integrity hashes (no git or tarball sources), and CI and the Dockerfile install with --frozen-lockfile. No committed secrets turned up in the tree or across all 380 commits of history (JWT, sk_/rzp_ live/test, AKIA, private-key and OpenRouter patterns). .gitignore covers .env*, signing keys and load-test token fixtures.
- **Supply chain, CI/CD, infra config, mobile app:** Mobile auth storage is sound: the Supabase session and even the cart live in expo-secure-store (Keystore/Keychain), never AsyncStorage. Google OAuth uses PKCE, so an intercepted amclub:// redirect code is useless. No Android permissions are requested beyond scoped mic and camera prompts.
- **Supply chain, CI/CD, infra config, mobile app:** Web platform config: strict security headers (CSP with frame-ancestors 'none', object-src 'none', form-action 'self'; HSTS preload; nosniff; Permissions-Policy). All 19 cron routes are guarded by verifyCron, which fails closed in production. The PWA service worker never caches navigations or /api responses and purges on sign-out.
- **Supply chain, CI/CD, infra config, mobile app:** Agent runtime internals: /internal/* requires an HMAC credential (timing-safe compare, ±5 min window, run-bound on resume), and job payloads are shape-validated per queue. Live WhatsApp drivers (meta_cloud, interakt) fail closed when their webhook secret is absent. Bank-data column encryption refuses to fall back to a default key under NODE_ENV=production.
- **Architecture and code health:** packages/shared keeps its layering rule: zod is the only runtime import (node fs/path appear only in one test), and its 64 unit-test files cover money, state machines, dispute settlement (ADR-014), bundles, add-ons, quote options, masking and the agent tool taint law.
- **Architecture and code health:** Flag gating is consistent where it is centralised: all 41 Mart handlers call martApiGate(), agent routes go through agentApiGate or feature guards built on it, and every (mart-*)/(agent-*) route group reuses the parent group's role-checking layout (e.g. `import AdminLayout from '../(admin)/layout'`), so gating a group never skips the role check.
- **Architecture and code health:** Where compare-and-set is used, it is done correctly: lib/disputes/resolve.ts claims with `.select('id')` plus a length check and resumes idempotently; runPayouts claims scheduled→processing; processRefund inserts its row first under a deterministic idempotency key; webhook-replay and dropped-webhook kill-tests run in CI.
- **Architecture and code health:** Agent safety is enforced in code, not only by prompts: the per-persona tool registry, confirm gates tied to ai_decisions, scriptedCall refusing money routes, and agent-writes.audit.test.ts mechanically holding the write allow-list.
- **Architecture and code health:** The CI money rigs run against a throwaway Supabase built from the commit (verify-authz proves no client write grants on money tables per ADR-018/022), and a client-money lint ratchet stops new client-side paise arithmetic on web.
- **Reliability, scalability and operability:** Payment webhook: HMAC is verified over the raw body with a timing-safe compare, and materialize_order is atomic and idempotent (it claims the checkout session with a CAS and payments are unique on razorpay_payment_id). The webhook and the reconciliation cron share this one path.
- **Reliability, scalability and operability:** Money primitives are designed for retries: processRefund writes the key-guarded refund row before calling the gateway and looks for an earlier refund by receipt; runPayouts claims each payout with a scheduled→processing CAS; the goods transitions, dispute resolve (ADR-014) and Mart pool transitions all guard status writes with CAS.
- **Reliability, scalability and operability:** The score and benchmark crons page through RPC results with `.range()` (so the 1000-row cap does not truncate them), write in batches, and record heartbeats. rfq-expire notifies only about the rows the current run actually moved, so overlapping runs do not duplicate notices.
- **Reliability, scalability and operability:** The agent model gateway has a hard timeout, jittered retries and a stub mode. The web→runtime enqueue call has a 5 s timeout and never throws into money paths. pg-boss queues have per-queue retry policies with a NO_RETRY classifier, and singletonKey collapses overlapping cron ticks.
- **Reliability, scalability and operability:** The notification dispatcher always writes the in-app row first and isolates each channel with its own try/catch, and the checkout session upsert is keyed on an idempotency key that is reused across retries.
- **Server-rendered pages:** Party binding comes first on every private page: getOrderDetail, getRfqForBuyer (.eq('msme_id', actor.msmeId)), getRfqForProvider (rfq_matches row), poolBuyerView (membership), poolProviderView (own offer or eligible+cohort) and plansForBuyer all bind the object to the session's profile before any child read, and non-parties get notFound().
- **Server-rendered pages:** Public catalog ISR pages (/p/[provider], /p/[provider]/[package], tiers, compare, sitemap) read through the anon client with explicit status='active' and deleted_at IS NULL filters on top of RLS. getProviderBySlug selects an explicit safe column list, and service-role reads there return only aggregates (mostChosen label, trust facts).
- **Server-rendered pages:** Cached pages hold no per-viewer data: revalidated pages use isOnForEveryone (never isOnFor(userId)), read no cookies, and per-viewer state (save, join status, recently viewed) is loaded client-side after render.
- **Server-rendered pages:** Many pages already hand the client a proper DTO: clarifications hide other providers' identities, sealed pool offers, compare ordering without score values (ADR-010), buyer invoice list (buyer_invoice kind only), events with payloads stripped, procurement state from the user's own RLS client, and checkout/pool checkout money shaped to taxable/GST/total.
- **Server-rendered pages:** Documents, invoices and RFQ attachments are exposed only as 15-minute signed URLs generated on the server after the party check. The tender portal_url has a DB CHECK (^https://), CMS links go through safeHref, and agent text links are limited to http(s).
- **Agent runtime job handlers and WhatsApp identity binding (about 3,000 unread lines on the service role):** Every WhatsApp button and job path re-checks ownership before acting. Munshi: draft.user_id vs conv.user_id, both in routeMunshiInbound and runMunshiDecide. Support decide: run.userId vs conv.user_id. Procurement: run.userId, session.user_id and open_run_id === runId, label buttons tied to the user's session, session-choice buttons tied to the same conversation. Web procurement turns check procurement_turns.user_id. Replaying another user's button id is refused.
- **Agent runtime job handlers and WhatsApp identity binding (about 3,000 unread lines on the service role):** The confirm gate is enforced in code, not by the model. AgentRun.resume requires an ai_decisions row for (run_id, tool) and re-checks scopes from the current grant. A model 'approve' from approvalIntentAgent is downgraded to re-ask. Onboarding confirms only on the exact 'confirm:<draft_run_id>' button payload. Money-adjacent procurement tools (choose, decline, nudge) are button-only.
- **Agent runtime job handlers and WhatsApp identity binding (about 3,000 unread lines on the service role):** Untrusted-input handling is consistent in agent-core. The Munshi, Support, onboarding, procurement and dispute-triage parts builders wrap all party text in envelope(). Every customer-facing output schema (thread_reply, quote_draft, onboarding_interview, provider_message, clarification_answer) is wrapped in customerFacingText, which rejects contact details, payment instructions, URLs and approval claims.
- **Agent runtime job handlers and WhatsApp identity binding (about 3,000 unread lines on the service role):** State changes are replay-safe: compare-and-set updates on munshi_drafts status, onboarding_sessions state, procurement_sessions state and agent_runs status, partial unique indexes on open Munshi drafts, and inbound de-duplication on vendor_message_id. The decision route answers 409 for a run that has already advanced.
- **Agent runtime job handlers and WhatsApp identity binding (about 3,000 unread lines on the service role):** User data is read through /api/v1 under short-lived (15-minute or less), run-bound delegated tokens, so RLS and route checks apply. The service role is mostly limited to agent-owned tables. Ops agents run only for agent_settings.ops_user_id.
- **S3.4 services demand pools:** Migration 0071 enables RLS and REVOKEs everything from anon/authenticated on all five pool tables. Only service_role can EXECUTE service_pool_claim. Tiers are immutable (raise_append_only on UPDATE) and events are append-only, so PostgREST exposes nothing.
- **S3.4 services demand pools:** Every pool status move is a compare-and-set: forming→open (`.eq('status','forming')`), forming→lapsed, open→closing, closing→closed and cancel (`.in('status',['forming','open'])`, so a closing pool cannot be cancelled). The cancel/close race resolves cleanly to one winner, and a pool left in 'closing' resumes on the next run instead of getting stuck.
- **S3.4 services demand pools:** The slot claim reuses the atomic claim_quote_slot (7-cap, status and expiry in one UPDATE). service_pool_claim takes a FOR UPDATE row lock and marks the member claimed in the same transaction, so a member is never double-claimed even when closes run concurrently.
- **S3.4 services demand pools:** The achieved tier is persisted once (`.is('achieved_count', null)`) before any quote is written, and the quote price comes from that persisted value (close.ts:142), so a resumed close uses the same price.
- **S3.4 services demand pools:** Eligibility is computed entirely server-side from DB state: cohort, category, service_slug, the buyer's state, fanout_at not null, open/quoted and unexpired, no must-haves (matching rfqMustHavesSchema exactly), plus the clock-fit rule. Person-facing routes are gated on AGENT_ENABLED, the switch and the cohort (404 otherwise), validate UUIDs, use strict zod schemas and are rate-limited. Member and offer lookups are keyed to the caller's own msme or provider id.
- **Web-side agent libraries and the deferred-release RFQ lifecycle:** Deferred RFQs are not visible to providers: no rfq_matches rows exist until releaseDeferredRfq, the rfqs/rfq_clarifications RLS requires is_provider_matched_to_rfq, the provider loader (getRfqForProvider) and quote/extract routes require a match row, rfq_matches has no client write grant (0064), and pools/detect.ts filters `fanout_at IS NOT NULL`.
- **Web-side agent libraries and the deferred-release RFQ lifecycle:** The release path is a single CAS on `fanout_at IS NULL`, so answer / send-as-is / cron races produce one fan-out. The buyer routes check msme ownership (loadDeferredRfqForBuyer), and the cron is behind verifyCron.
- **Web-side agent libraries and the deferred-release RFQ lifecycle:** Intake rows are bound to the uploader (checkIntakeExtractions checks user_id, unlinked, at most 4 before insert). The storage_key used for the corpus comes from the server-generated upload path, and consent withdrawal deletes both corpus tables.
- **Web-side agent libraries and the deferred-release RFQ lifecycle:** Model output cannot steer money: the dispute triage schema is .strict() with no amount fields, the console only shows a percent band and never pre-fills the refund amount, triage links are fragment-only hrefs, triage_id is checked against the dispute before settlement, dossier photo findings are reconciled to the order's own photo ids and the recommendation is deterministic code, and the dossier decision route accepts only 'hold' (approve goes through the release route with dossier/payout/order binding).
- **Web-side agent libraries and the deferred-release RFQ lifecycle:** Provider-scoped agent data is bound correctly: quote_extractions and munshi drafts are checked for rfq + provider on submit, price-book rows are written with actor.providerId, soft-delete is scoped by provider_id, and onboarding draft/session reads and the profile link are keyed to the session user.
