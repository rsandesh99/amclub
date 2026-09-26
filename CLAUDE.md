# AMClub — CLAUDE.md (AI agent working context)

**Source of truth:** `docs/DESIGN.md`. Sections §2 (TRD), §5 (schema), §6 (implementation plan), and §8 (scope governance) are binding. Changes require updating `docs/DESIGN.md` first via §8.1 (mini-PRD + RICE score), then code.

---

## Stack (§2.2)

| Layer | Choice |
|---|---|
| **Web** | Next.js 15 App Router · TypeScript strict · Tailwind CSS · shadcn/ui + Radix |
| **Mobile** | Expo (React Native) · TypeScript · NativeWind · expo-router |
| **State** | TanStack Query (server state) + Zustand (minimal client state) |
| **Backend** | Supabase (Postgres · Auth · Storage · Realtime) — `ap-south-1` (Mumbai) |
| **Jobs** | pg-boss (Postgres-backed queue) for V1 → BullMQ+Redis at scale trigger |
| **Search** | Postgres FTS + pg_trgm → Meilisearch/Typesense at >5K listings |
| **Auth** | Supabase Auth · phone OTP primary (MSG91 hook) · Google OAuth secondary |
| **Payments** | Razorpay PG + Route · UPI default · webhooks are the ONLY payment truth |
| **Notifications** | MSG91 (SMS, DLT) · WhatsApp direct on Meta's Cloud API (ADR-030) · Resend (email) · Web Push |
| **i18n** | next-intl · ICU messages · en + hi at launch; 8+ languages later |
| **Validation** | Zod everywhere — API input, forms, env. Schema first, types derived. |
| **Monitoring** | Sentry · PostHog · Vercel Analytics |
| **Hosting** | Vercel (web + API) · Supabase cloud ap-south-1 |
| **Monorepo** | Turborepo + pnpm workspaces |

---

## Hard rules (§2.5) — enforce on every PR

1. **RLS-by-default.** Never use the service-role key in client-reachable code paths without an explicit authorisation check. Service-role key is server-only.
2. **Webhooks as payment truth.** Every payment mutation is idempotent (idempotency keys). Razorpay webhooks are the single source of truth for payment state — never trust client redirects.
3. **i18n everywhere.** Every user-visible string goes through `next-intl`. No hardcoded copy anywhere.
4. **Timestamps & soft delete.** Every table gets `created_at`, `updated_at`. User-content tables add `deleted_at` (soft delete; never hard-delete buyer/provider data).
5. **Zod first.** Write the Zod schema first; derive TypeScript types, form validation, and API input validation from it.
6. **Money in paise.** All money stored as `bigint paise` (integer). Never floats. Never rupees in the DB.
7. **UTC in, IST out.** DB timestamps are `timestamptz` UTC. Render in IST for users.
8. **State machines in one place.** Order/RFQ/payout statuses are enums with a transition map in `packages/shared/src/state-machines.ts`. The API rejects illegal transitions. No status string literals anywhere else in the codebase.

---

## Order state machine (§3.7 — canonical, do not repurpose transitions)

```
placed → accepted → requirements_submitted → in_progress
      ↘ (24h no accept) auto_cancelled → refunded
in_progress → delivered → completed            ← buyer accepts OR 72h auto-accept
in_progress → delivered → revision_requested → in_progress   (max N per package config)
any-pre-completed → disputed → { resolved_refund | resolved_release | resolved_partial }
completed → disputed                           ← only within dispute_window_days (ADR-014 §6)
placed | accepted → cancelled_by_buyer         ← policy-based refund %
placed → cancelled_duplicate → refunded        ← a second paid order on one RFQ, refunded in full (ADR-014 §7)
completed → reviewed                           ← reserved: nothing writes it yet; a review leaves the order `completed` (payout releases from `completed`, so writing it would hold payouts)
```

**Payout rule:** provider payout releases ONLY from `completed` or `resolved_release` / `resolved_partial`.

The state machine may be **extended** (new states added) but transitions may never be repurposed — downstream payout logic depends on them (§8.4).

---

## RFQ state machine

```
open → quoted → accepted → (converts to order)
open → expired            (72h, no quotes)
open → cancelled          (buyer cancels — reserved: no route writes it yet)
```

Quote statuses: `submitted → accepted | declined | withdrawn | expired`

---

## Payout state machine

```
scheduled → processing → paid
scheduled → failed       (retry)
any → held               (dispute open, provider suspended, or bank verification stale)
```

---

## Implementation phases — DO NOT start a phase until the previous one's done-criteria pass (§6)

| Phase | Scope | Done criteria |
|---|---|---|
| **0 — Foundations** | Monorepo, CI, env, hello-world on web + mobile, locale switch | Empty app deploys; sample migration runs; PostHog event fires; locale switch works |
| **1 — Database & RLS** | All §5 tables as Drizzle migrations, RLS policies, seed data | RLS test suite passes; seeded data visible via SQL |
| **2 — Auth & profiles** | Phone OTP, signup wizards, KYC, admin verification queue | End-to-end: new provider → admin approves → listings live |
| **3 — Catalog & discovery** | Landing, search (Postgres FTS), provider profiles, ISR | Lighthouse ≥90; search <300ms p95; package live in <5s after publish |
| **4 — Payments & Buy-Now** | Razorpay PG + Route, checkout, webhooks, order workspace, jobs | Full money loop in test mode; replayed webhook does NOT double-create |
| **5 — RFQ engine** | RFQ creation, fan-out, quote inbox, quote-accept → order | 7-quote cap enforced; accepted quote = paid order identical to package order |
| **6 — Reviews & notifications** | Post-completion review, notification dispatcher, coupons, CMS | Completing order → review prompt; WhatsApp template delivered in sandbox |
| **7 — Admin & ops** | KPI dashboard, dispute console, payout monitor, audit log | Ops resolves seeded dispute end-to-end; commission change affects only NEW orders |
| **8 — Polish & hardening** | Empty/error states, PWA, a11y, OWASP, load test (k6) | axe zero criticals; k6 p95 <800ms; restore-from-backup rehearsed |
| **9 — Pilot launch** | Live keys, 30–50 providers, ~500 MSMEs | 25 real completed paid orders; dispute flow exercised |

---

## Scope governance (§8)

- **NOT-NOW register (§8.3):** bidding wars/auctions on RFQs, pre-order provider chat, cash/offline payments, per-buyer price negotiation in V1, social feed, gamification, video consults, international/multi-currency, dynamic surge pricing, blockchain — do not implement under any circumstances.
- **AI features are version-gated (§8.2), not NOT-NOW.** The AI RFQ assistant is pulled forward by §8.6 (founder-authorised, 2026-09-08); AI matching / the buyer agent with tools stays at the V1.5→V2 gate. Agent rules: ADR-008 — agents call `/api/v1` under the user's own session (never service-role for user data), confirm gates are fixed in `packages/shared/src/agent.ts`, admin actions are never tools, `AGENT_ENABLED` default OFF.
- **Experience v3 "Precision" is the active build (founder-approved 2026-09-23).** `docs/prd/PRD_EXPERIENCE_V3.md` is the §8.1 bundle for the September 2026 market survey: epics E0→E17 in the §8 wave order, one PR per epic (large ones split), each behind its own flag (`exp_v3_*`, default off) and extending `apps/web/scripts/verify-experience.ts` (CI step "Experience v3" in `money-rigs.yml`). Money items (E12a/b/c, the PAN path) need their ADR first and add money-rig criteria. Items waiting on a founder decision (§10: D1, D2, D3, D9, D-PRD5, D-UX2) are built dark and stay off until that decision. **Prices are the server's `display` (E4 / N16):** every catalog, package and checkout payload carries `display` from shared `priceDisplay` (= `computeOrderAmounts`, no coupon); `PriceBlock` (web + mobile) renders only that, and `pnpm lint` runs `scripts/lint/client-money.ts` (a ratchet: any NEW `*Paise` arithmetic in a `'use client'` file fails; the baseline only shrinks). **Checkout has its own route group `(checkout)` (E5):** its layout mirrors `(msme)` with the flag off; with `EXP_V3_CHECKOUT=on` the middleware lets a guest open `/app/checkout/<uuid>` (nothing else under `/app`) for inline sign-up.
- **Production state (founder go-live, 2026-09-24):**
  - **Vercel Production:** every `EXP_V3_*` switch is `on`, `MART_ENABLED`, `AGENT_ENABLED` and `COUPONS_ENABLED` are `true`, and `NEXT_PUBLIC_ANALYTICS_CONSENT_REQUIRED=true`.
  - **`agent_settings`:** every boolean switch and every `agents_enabled.<name>` is `true`; `cohort_user_ids` holds the users that existed on 2026-09-24.
  - **Deliberately off:** `PAYOUT_AUTO_RELEASE` and member pricing.
  - **Open question (audit L6):** "every boolean switch is `true`" includes `bundles_enabled` and `tenders_enabled`, whose own preconditions (ADR-021: counsel + Razorpay; D9) were not recorded as met. The founder confirms or turns them off.
  - **Payments:** simulated nowhere on production (ADR-023), so checkout needs real Razorpay keys (ADR-003 cutover).
  - **"Dark" and "default off" below** describe the code defaults, not production.
- **Agent programme RESUMED (founder, 2026-09-24; it was paused after S3.2 on 2026-09-23 so Experience v3 could take the build).**
  - **Built dark:** S3.4 (see its landed line below). Nothing else is open until a gate moves.
  - **S4.3 paperwork landed:** ADR-013 (Proposed) recommends keeping §8.3 unchanged. Option B (the sealed one-round counter) may be revisited only at the V1.5→V2 gate under its §7 preconditions.
    - Its spike `packages/shared/src/spikes/negotiation.ts` is not exported and has no caller. Never import it into product code.
  - **Still gated:**
    - S3.3 needs ADR-011 (Proposed, `docs/adr/011-first-order-guarantee.md`) to be Accepted: the founder's numbers, the CA opinion and a recorded Razorpay test-mode run (H7).
    - S4.1 keeps its six-month gate.
    - S4.2 waits on D1.
  - **S3.4 rule:** its tiered quotes reuse the E12b `quote_options` design (ADR-020).
- **Agent programme (staged build).** Before any agent work read `docs/agents/ARCHITECTURE.md` (the locked architecture; its §7 invariants checklist goes into every agent PR) + ADR-009 (build shape) alongside ADR-008 (topology). The executable plan is `BUILD_PROMPTS.md` — sequential gated PRs S0.1→S4.3, run in order, one PR per prompt, never combined; everything ships dark behind `agent_settings.agents_enabled.<name>` + a cohort allowlist.
- **H1 landed (CI):** `.github/workflows/money-rigs.yml` runs `verify-authz`, `verify-money-loop`, both webhook kill-tests, `verify-phase7`, `verify-rfq`, `verify-experience`, the **browser journeys** (`apps/web/e2e/journeys.ts`: a real Chromium clicks package → pay → deliver → payout and requirement → quote → pay; failed steps upload screenshots), the **signed-in axe scan** (`a11y-scan.ts` in full mode, `A11Y_ENFORCE=1`), and **Mart**: `mart:acceptance` (M0 goods lifecycle, M2 goods RFQ, E16 storefront, the 0022–0025 / 0069 DB kill-tests) on a second server with production's flags (agents + Mart on, :3001, which also runs `verify-pools`), plus `mart:acceptance --inert` on the flag-off :3000. All of this runs on every PR once it is ready for review (Actions minutes are metered: drafts run nothing, CI and rigs are not re-run on the merge push to master, a newer push cancels the older run; `workflow_dispatch` runs them by hand) against a throwaway `supabase start` stack (`.github/supabase-ci`, schema from the commit via `db:bootstrap` + seed, buckets from `buckets.sql`, Redis behind an Upstash REST front so limiters engage, simulate-payment mode). A money-path change adds or extends a rig criterion there; the money rigs never run against production (the read-only services suites named under Mart below are the only scripts pointed at prod). **GitHub does not enforce required checks on this private repo (plan limit), so the rule is ours: never merge a PR while `Money rigs · disposable Supabase` or `Lint · Typecheck · Test · Build` is red or still running.**
- **ADR-018 landed (security hotfix, migration 0064):** money and order-state rows are **server-written only**. Client roles hold no INSERT/UPDATE/DELETE on orders, checkout_sessions, payments, payouts, refunds, invoices, disputes, order_documents, rfqs, quotes, rfq_matches, coupons, coupon_redemptions, provider_bank_accounts or reviews, and `materialize_order()` is EXECUTE for `service_role` only. Every writer is a `/api/v1` route or job on the admin client, after its own authorisation. A new client write grant on these tables is review-blocking. `verify-authz` §7a proves it on every PR.
- **ADR-022 landed (security hotfix, migration 0070):** `order_safe_view` is `security_invoker = true`, nothing for `anon`, SELECT only for `authenticated`. It had run as its BYPASSRLS owner, so the anon key read every order and buyer phone. A view over an RLS table must be `security_invoker` unless it is a deliberate public projection (`public_providers`); a new definer view is review-blocking. `verify-authz` §7a5 proves it on every PR.
- **ADR-025 landed (security hotfix, migrations 0072 + 0073):** provider and catalog rows are **server-written only**. `public_providers` is SELECT-only (it was an auto-updatable definer view holding the default ALL grant, so the anon key could rename or delete active providers). No client role holds INSERT/UPDATE/DELETE on provider_profiles, provider_categories, packages, products or price_tiers; owners keep READ. `buyer_pool_discipline_v1` is `security_invoker` with no client grant. The partner package routes check ownership on the session client, then write with the service role. **Every new table or view gets an explicit grant decision** (Supabase default privileges grant ALL to anon and authenticated), and a new auto-updatable view gets `REVOKE ALL` + `GRANT SELECT`. `verify-authz` §7a6 proves it on every PR. **0072 and 0073 are applied to production (2026-09-24).** The full audit and its remediation waves are `docs/audit/2026-09-24-architecture-security-audit.md`.
- **Audit wave 1 landed (security, migration 0074):**
  - The Supabase "Send SMS" hook (`/api/v1/auth/sms-hook`) verifies the Standard Webhooks signature (`lib/auth/standard-webhook.ts`, `SEND_SMS_HOOK_SECRET`) and refuses an unsigned or badly signed call once the secret is set; +91 mobiles only, per-phone limited. Until the secret is set on production it logs an error per call under a global hourly cap (transition, so the deploy cannot stop phone login).
  - The WhatsApp webhook refuses unsigned requests unless it is not production and `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=true`.
  - **Decode an uploaded image only through `openUploadImage`** (`lib/images/untrusted.ts`: magic-byte sniff, JPEG / PNG / WebP loaders only, 40 MP cap).
  - Redirect targets go through shared `safeNext`; the middleware answers 400 for control characters and backslashes and never follows an off-origin next-intl redirect.
  - 0074 (applied to production 2026-09-24): `generate_order_number` and `order_number_seq` are service-role only; the advisor-flagged functions pin `search_path`. `verify-authz` §9 proves it.
- **ADR-026 landed (money safety, audit wave 2; no migration):**
  - **One run-time release rule:** `payoutRunBlockers` (`lib/payments/release-gate.ts`) runs inside `runPayouts` after the claim; a payout moves only from `PAYOUT_RELEASE_STATUSES`, and a plain `completed` order must also clear the goods / services evidence gate. Blocked → `held` with the reasons. Never add a release path around `runPayouts`.
  - **Transfers are confirmed, never assumed:** `notes.payout_id` on every transfer; only a definite rejection marks `failed`; anything ambiguous stays `processing` with `payout_unconfirmed`; a retry calls `findTransfer` first; the reconcile cron settles stuck payouts (`settleUnconfirmedPayouts`).
  - **Every order status write is compare-and-set** (`.eq('status', from)` + a row count): a party that loses gets 409 `order_changed`, a cron skips, and no side effect runs for the loser.
  - **Refunds and invoices never strand:** refund failures leave `refund_failed` and are re-driven by the auto-cancel cron (`redriveCancellationRefunds`, shared `ORDER_REFUND_OWED_STATUSES`); admin "Finish refund". `safeGenerateInvoices` never fails an order action; the reconcile cron generates missing ones. "Retry payout" is for `failed` payouts only; held ones are released from `/admin/payouts`.
  - Gateway lookups never read "unknown" as "none" (`listRefunds` / `findTransfer` throw). `verify-money-loop` DC11 proves it.
- **Audit wave 3 landed (authorisation, migration 0075):**
  - **Delegated agent tokens are refused by default.** `requireAdmin()` refuses one unless the route passes `{ agentTool }` for a read-only ops tool in scope; buyer / provider / pool write routes call `requireNotDelegated()` unless a scope is wired (`requireToolScope`). A new write route refuses delegated tokens unless its tool is registered.
  - The token endpoint never renews from a delegated token and binds `run_id` to the caller's own run.
  - A suspended or soft-deleted provider resolves with no provider identity (`resolveActor`).
  - One review report never hides a review: three distinct reporters, never the reviewed provider, never after an ops restore.
  - 0075: clients cannot read `rfq_clarifications.provider_id` / `answered_by` (column grant) or `coupons`. `verify-authz` §10 proves it with hand-signed delegated tokens.
- **Audit wave 4 landed (privacy, migration 0076; applied to production 2026-09-24):** a matched seller sees where, not who (shared `goodsSpecForSeller` strips the buyer's contact name, phone and street address from a goods request). Quote and group-offer text is contact-masked before storage (`quoteRowColumns`, `redactContactInfo`). The public pool API never returns the agent rationale (`publicPool`; 0076 withdraws the column from clients). RFQ attachments must be the buyer's own uploads and are signed only under the owner's prefix (`attachmentRefAllowed`); licence certificates only under `<msme_id>/<licence_id>/`.
- **Audit wave 5a landed (operations, migration 0080; applied to production 2026-09-24):**
  - **Every scheduled cron runs through `runCronJob`** and is listed in `lib/jobs/cron-registry.ts` with its degraded rule; a new cron is added to `vercel.json`, its route folder and the registry together (`pnpm lint` fails otherwise). Heartbeats store ok / degraded / failed; failures reach Sentry.
  - Rate limiting never 500s: `enforce()` fails open on an Upstash error for ordinary limiters; cost-bearing limiters keep enforcing in memory. **Every outbound fetch carries a timeout.**
  - CI supply chain: pin every action to a commit SHA; the Fly deploy runs only from master in the `production` environment.
  - next-intl is 4.x (`localeCookie.maxAge` keeps the one-year locale cookie).
- **ADR-027 landed (money, audit wave 5b, migration 0078; applied to production 2026-09-24):** payment truth after checkout.
  - **No money moves on simulated state:** `moneyMovementBlock` (`lib/payments/simulation.ts`) stops payouts, refunds and reconcile when the mock is on production or a payment was simulated. Never call a gateway money method without it.
  - **The webhook settles refunds, transfers and chargebacks** (state-guarded, once per gateway id); an open chargeback holds the payout.
  - **A capture with no live session makes no order:** `capture_payment()` records a `capture_exceptions` row (expired session / second capture) and it is refunded in full; checkout never resumes an expired session.
  - `manual_refund` follows ADR-014 (`platformAbsorbs` only by explicit confirm); `payoutRunBlockers` refuses a full payout beside a refund.
- **ADR-029 landed (audit wave 5b, migration 0081; applied to production 2026-09-24):** coupon uses are claimed under the coupon's row lock before any payment opens (`claim_coupon_for_session`; optional `per_buyer_limit`); **no self-dealing** (`lib/orders/self-dealing.ts`: 409 `self_dealing` on checkout, own-request quotes, order actions and own reviews; fan-outs skip the buyer's own provider); `sweepMissingPayouts` backfills a completed order's missing payout; money crons run in bounded batches inside `timeBudget` with `maxDuration = 300`. Admin verification / coupon / CMS decisions are audit-logged.
- **Audit wave 5c landed (migrations 0077, 0082, 0083; applied to production 2026-09-24):**
  - **Goods returns** from `completed` close at the earlier of the category window and `dispute_window_days` (shared `goodsReturnDeadline`; the server sends it).
  - **Listings:** a material edit goes back to `pending_approval`; approval names `reviewed_updated_at`; pools freeze GST / HSN / unit at open and checkout charges the frozen values.
  - **Group requests:** a group quote is never revised (`quotes.pool_member_id`); a dual-role user (buyer + provider) is kept out of pools; the close holds a per-pool lease.
  - **`rfqs.goods_spec` is server-read only** (0083): read it on the service role after the ownership check, never on a session client.
  - **One contact masker** (`packages/shared/src/contact-mask.ts`): add a pattern there, with a fixture row, never a second rule set.
  - **ADR-028 (KYC):** a verification chip or penny drop needs ownership (shared `kycOwnership`: own GSTIN / PAN, or a name matching the GST-locked name); one active Udyam claim per number (0082).
- **Audit wave 5d landed (agents, migration 0079; applied to production 2026-09-24):**
  - **The runtime package is CommonJS on purpose** (as ESM it cannot see the source packages' re-exports and dies at boot); its image runs as `node`. Every pg-boss queue is in `apps/agent-runtime/src/queues.ts` and created before use (a unit test proves it).
  - **WhatsApp is bound to the phone:** consent must come from the conversation's phone; a phone change unbinds (trigger 0079). Inbound media is downloaded in the job, capped; unprocessed inbound is swept every minute.
  - **A free-text "yes" approves at most one open proposal** across Munshi / procurement / support; ambiguity re-sends the cards.
  - **Residency (M23):** `residencyPosture()` is shown on /admin/agents and runtime /health; an undecided production posture refuses user-data model calls only with `AGENT_RESIDENCY_FAIL_CLOSED=true` (held by the founder until AGENT_RESIDENCY_WAIVER or ENFORCE + hosts is recorded). Out-of-cohort traffic spends from `budget_month_open_paise`; every model / STT call goes through the bounded helper.
- **WhatsApp readiness audit (2026-09-26, `docs/audit/2026-09-26-whatsapp-readiness-audit.md`; migration 0085):**
  - `agent_grants` is **server-written only**. It is consent evidence and the source of delegated-token scopes, and a delegated token is role=authenticated. `/api/v1/agent/grants` writes on the service role after `requireNotDelegated` and a persona-held check; the `agent_grants_immutable` trigger lets only `revoked_at` change and never revives a grant. A client write grant on it is review-blocking.
  - Every write route no agent tool wraps calls `requireNotDelegated` first — Mart included. `verify-authz` §10 and `verify-mart` F2 probe for an exact 403.
  - Eight blockers stand before any live WhatsApp number (section 1 of the audit). Read the audit before WhatsApp work.
- **ADR-030 wave 1 landed (WhatsApp on Meta's Cloud API + notifications; migrations 0086, 0087; nothing reaches Meta until `WHATSAPP_DRIVER=meta_cloud` + its credentials). It fixes the audit's B1–B7; B8 is the `cohort_mode` switch (default `list`, D-WA2):**
  - **One send path:** every WhatsApp message goes through agent-core `sendWhatsApp`, from the web dispatcher, the runtime or the ops console. Its steps: consent (`mayMessage`), then the window, then a `wa_messages` ledger row keyed by an idempotency key, then the driver, then a classified error. Never call a driver directly. The Graph version is pinned to `v24.0`.
  - **Consent is per phone and purpose** (transactional / assistant / marketing):
    - `wa_consent_events` is append-only. `wa_phone_consents` is written only by `record_wa_consent()` (service role).
    - STOP stops everything. A greeting is not consent, and "no" / "cancel" are not STOP (shared `classifyWaKeyword`).
    - A business send needs an opt-in the recipient themselves gave. A phone change withdraws the old number's opt-ins (0086 trigger).
    - `WA_ALWAYS_ALLOWED_KINDS` stays empty.
  - **Templates:**
    - The registry is CORE + NOTIFY + SYSTEM (`whatsapp/templates*.ts`): four locales, utility only, and every template has sample values.
    - A URL button only opens our own domain (template-kit `linkSuffix`).
    - A template change regenerates PRE_LAUNCH_CHECKLIST 1.3 (`templates:list`).
  - **Notifications:**
    - Call sites name a KIND. Shared `NOTIFICATION_KINDS`, the user's preferences and the essential floor decide the channels. Register a new kind there first; it needs a template before it gets WhatsApp.
    - Delivery runs through `notification_outbox` and the cron `notify-dispatch`: retry, IST quiet hours, the lead digest, and WhatsApp → SMS / email fallback. `NOTIFY_OUTBOX=off` is the kill switch.
    - SMS goes out only for a kind with a DLT template in `sms_dlt_templates`.
  - **User controls:** `/me/whatsapp`, `/me/notification-preferences` and `/me/privacy-requests` (DPDP, one open request per kind), all behind `requireNotDelegated`; web and mobile settings; the HELP menu on WhatsApp.
  - **Ops:** `/admin/whatsapp` (driver, delivery, spend, templates vs Meta, unrouted replies) and `/admin/privacy` (the DPDP queue); crons `wa-retention` and `wa-template-sync`.
  - **No WhatsApp content in any corpus or eval set**, nor anything derived from it (shared `corpusSourceAllowed`).
  - Runbooks: `docs/agents/WHATSAPP.md`, `docs/agents/WHATSAPP_OPS.md`. Rigs: `whatsapp:verify`, `verify-whatsapp-consent`, `verify-whatsapp-ops`, `verify-notifications`.
- **ADR-023 landed (money safety; amends ADR-003):** the simulation gateway never takes a payment on the production deployment. ADR-003's live-cutover procedure and checklist still govern how production starts taking payments. `paymentsAvailable(isReal, VERCEL_ENV)` (`lib/payments/simulation.ts`) is false only for the mock on `VERCEL_ENV=production`; then every checkout entry point (`/checkout`, `/checkout/simulate`, `/mart/checkout`, `/mart/pools/[id]/checkout`) returns 503 `payments_unavailable`. Previews, CI and the rigs keep simulating. `verify-money-loop` asserts it.
- **ADR-019 landed (E12a, money, dark: `addons_enabled`, migration 0065):** package add-ons. Shared `packageCharge` is the ONE rule: package + Σ add-ons, the package discount on the package only, a coupon on the whole subtotal, one `computeOrderAmounts`, byte-identical with no add-ons. Checkout, `POST /api/v1/checkout/preview`, the coupon route and the checkout page all call it. The snapshot is frozen on the session and copied onto the order by trigger. An id that isn't an active add-on → 409 `addon_changed`. Invoices get one line per add-on. Writes go only through `/api/v1/partner/packages/[id]/addons` on the service role.
- **ADR-020 landed (E12b, money, dark: `quote_options_enabled`, migration 0066):** quote speed options. The quote row IS Standard. `quote_options` holds Economy / Express per quote revision (immutable rows, service role only). Coherence is shared `quoteOptionsProblems`: Express faster and never cheaper, Economy slower and never dearer; otherwise 400. Compare choices come from shared `quoteChoices` / `choiceExtremes`. Checkout `optionId` must be this quote's at its current revision, else 404 `option_not_found`; it charges `quoteChargeAmounts(option price, quote GST mode)` with the option's days. Finalize records `quotes.selected_option_id`, and loss labels use the winning option.
- **ADR-021 landed (E12c, money, dark: `bundles_enabled`, migration 0067; enabling waits on counsel + Razorpay):** compliance bundles. A package with 2–6 `bundle_milestones` sells as ONE payment. Shared `bundlePlan` splits it exactly (the last milestone takes the remainder), frozen on `checkout_sessions.bundle_plan`. The trigger `checkout_sessions_materialize_bundle` turns the materialised order into child 1 and inserts children 2..N (a replay creates nothing). Each child is an ordinary order with its own payout. Refunds per child go through `paymentForOrder` / `refundForOrder` (byte-identical for ordinary orders). Auto-cancel counts from `available_at`. "Cancel remaining" sends the unstarted children through the ordinary `cancel`.
- **E18 landed (founder request 2026-09-24; PRD §E18):**
  - **Assistant home:** `/app/ai` and `/partner/ai`, route groups `(agent-home-msme)` / `(agent-home-provider)`, gated on `AGENT_ENABLED` only.
    - Capabilities are shown in plain words, each "On" per person through `agentAvailability` (the switch + the cohort + the runtime).
    - The permission card lists what the assistant does on its own vs only after a tap; never tool names. Consent `v2`.
    - The profile page links there.
  - **Corner assistant:** `AssistantLauncher`, on every buyer / provider page with `AGENT_ENABLED`.
    - It reads `GET /api/v1/agent/assistant`.
    - It sits above anything marked `data-bottom-bar`. **Mark any new fixed or sticky bottom bar with `data-bottom-bar`.**
  - **"Why AMClub"** (flag `guide`, `EXP_V3_GUIDE`): two tabs, buyers | providers, on:
    - the buyer home rail (with `HomeSnapshot`);
    - the provider Today rail;
    - the `/services` and `/mart` front pages.
    - Plus the trust strip under the search bars, and the side-rail "Post a requirement" card.
  - **Every promise is worded to the code** (the evidence table is in the PRD). Change the copy when a rule behind it changes, and never add an item the code doesn't do.
- **E17 landed (dark, gated D-UX2):** analytics consent behind the build flag `NEXT_PUBLIC_ANALYTICS_CONSENT_REQUIRED` (default off = PostHog as before). When on, `posthog.tsx` captures nothing until Accept, and Decline opts out. The one-line notice has equal Accept / Decline. The choice lives in the cookie `amc_analytics_consent` plus `users.analytics_consent` (migration 0068, via `/api/v1/me/analytics-consent`), versioned by shared `ANALYTICS_NOTICE_VERSION`. The consent rate comes from stored rows (admin KPI), never from analytics.
- **E16a landed (staged, Mart Launch Gate):** migration **0069 is STAGED** with 0022–0025 (Mart tables only). Typed attributes: `mart_category_attributes` (config) + `products.attributes`, validated by shared `validateProductAttributes` in both seller routes (422 `invalid_attributes`); facetable (enum / bool) attributes are `a.<key>` facet chips, filtered by one jsonb containment. The Services | Goods `ModeSwitch` renders only with `MART_ENABLED`; goods search shows "Make to order" (goods RFQ) and a weak-result RFQ card. Suites: `verify-mart-storefront` (in `mart:acceptance`) + `killtest-mart-storefront`.
- **E16b landed (staged, same 0069):** seller promises are `products.promises` (shared `martPromisesSchema`). Breaches are measured by the hourly Mart cron (`measureGoodsPromiseBreaches` → shared `measurePromiseBreaches`, from the dispatch photo / the invoice document's timestamps) into `mart_promise_breaches`, one row per (order, product, promise). They **never touch money or the release gate**. Public reads show only standing badges (`withActiveBadges`, `mart_settings.promise_breach_limit`). `mart_categories.returnable` / `itc_eligible` drive "Not returnable" (quality / other returns → 409 `not_returnable`; damaged / wrong / short stay claimable via shared `returnAllowed`) and the per-line ITC credit (shared `goodsItcSplit`, server-computed `itcPaise` / `afterItcPaise`).
- **E16c landed (staged, same 0069):** a **sample** is an ordinary goods order of one unit at `products.sample_price_paise` through the one `prepareGoodsCheckout` (`{ sample: true }`, MOQ waived, line flagged `sample`; only one listing at qty 1, else 422 `sample_one_unit`; no price → 409 `no_sample`). "Customise" = the goods RFQ prefilled from the listing's attributes + specs. The **reorder library** `/app/mart/reorder` + `GET /api/v1/mart/reorder` (shared `groupPastGoodsLines`, today's server price vs then). The opt-in reminder `POST /api/v1/mart/reorder/reminders` runs at the usual interval (shared `usualReorderIntervalDays`); the hourly Mart cron sends it once, guarded on `next_at`.
- **ADR-015 landed (H5, money):** a services quote with `gst_included = true` is charged exactly its quoted price. Shared `computeGstInclusiveOrderAmounts` carves GST out (`total = gross`, commission on taxable); `false` / `null` still add GST on top. Only the checkout quote branch uses it.
- **ADR-014 landed (H3 + H4, money safety):** shared `planDisputeSettlement` is the ONE rule for what a dispute resolution may do to the payout and refund rows. `paid` / `processing` payouts are never rewritten or re-sent (409 `provider_already_paid` / `payout_in_flight`); one refund row per order, so an earlier refund is a 409 `refund_exists` (resolve AND `manual_refund`), and every caller reads back `processRefund`'s amount (`refund_mismatch`). The claim is atomic, and an interrupted resolve is finished only with the same resolution and amount after 10 minutes (CAS on `orders.updated_at`). Console codes are `admin_ops.money_err_*`. **H2 (ADR-014 §6):** every status after the provider accepts can be disputed (the `accepted` / `requirements_submitted` / `revision_requested` → `disputed` edges), and `completed → disputed` only within `agent_settings.dispute_window_days` (default 7) via shared `canRaiseDispute`; the server sends the deadline (`disputeWindowEndsAt`) and clients never compute it. **H6 (ADR-014 §7):** a second paid order on an accepted RFQ goes `placed → cancelled_duplicate → refunded` in the same `finalizeQuoteAcceptance` pass, with a 100 % refund read back; anything that cannot complete stays flagged for ops. ADR-014 no longer blocks ADR-011.
- **E14c landed (dark; N32b):** provider content translation — `provider_content_translate@v1` (task class `content_translate`, residency in) DRAFTS a package title / "Choose this if…" / the About into hi / te / ta; drafts live in `content_translations` (0061) and never render; only the provider's approve (`lib/translations/content.ts`, a spine path; claim-first, re-checks English unchanged + shared `contentNumbersProblems` + the customer-facing contract) writes the slot + `i18n_sources` `machine_approved` + exactly one `ai_decisions` row (feature `content_translation`); buyers see "Translated · View original". Locks `AGENT_ENABLED` + `agents_enabled.content_translate` + cohort; route group `(agent-translate-provider)`. Runbook `docs/agents/CONTENT_TRANSLATION.md`.
- **S3.4 landed (dark; ADR 024; migration 0071 NOT staged, applied to production 2026-09-24):** demand aggregation for services. The hourly cron `agent-demand-pools` (code, no model) groups open, released services requests from cohort buyers by (category, `details.service_slug`, buyer state) with shared `clusterPoolCandidates`. A request qualifies only if its own clock fits the whole pool (form + open + pay buffer) and it has no must-haves. Buyers opt in (one `ai_decisions` row, feature `demand_pool`, tool `join_pool`). Fan-out-matched cohort providers state ONE sealed volume-tier offer (shared `poolTierProblems`: first tier = one business, then more businesses at strictly lower prices; 400 `tiers_incoherent`). Buyers choose one. At close, `service_pool_claim` takes each member's ordinary 7-cap slot and the offer's tier comes from its claimed count (shared `planPoolClose`, saved before any write). Then ONE ordinary quote per member is written through `resolveQuoteTerms` / `quoteRowColumns`. From there it is the ordinary Accept & pay: no new checkout, order state or money path. Pool tables have no client grant. Routes: `/api/v1/pools/*`, `/api/v1/rfq/[id]/pool`, `/api/v1/partner/pools`, `/api/v1/agent/admin/pools`. Route groups: `(agent-pools-msme)`, `(agent-pools-provider)`. The rig is `verify-pools.ts`, run against a second CI server with `AGENT_ENABLED=true` on :3001. Runbook `docs/agents/AGGREGATION.md`.
- **S3.2 landed (dark):** fair price ranges — shared `benchmarks.ts` (`BENCHMARK_VERSION`, nearest-rank p25/p50/p75 on paid orders only, four privacy gates + a 25 % share cap that settings can only TIGHTEN, the rounding rule, `benchmarkLine` in en/hi/te/ta, strict `benchmarkViewSchema` with no id); migration 0046 (`price_benchmarks` has NO id column; `benchmark_inputs()` + `replace_price_benchmarks()` service_role only; any signed-in user reads aggregates); nightly `cron/benchmark-compute` (no model; one transaction; a gated key disappears the same night; `benchmark_compute_enabled`); the SAME line for the buyer (compare header) and every matched provider (summary card), web + mobile + `GET /rfq/[id].benchmark` (`benchmark_display_enabled`; null renders nothing); the optional `benchmark_explain@v1` sentence (AGENT_ENABLED + `agents_enabled.benchmark` + cohort; only the row's numbers, no advice word; cached on the row). Runbook `docs/agents/BENCHMARKS.md`.
- **S3.1 landed (dark; A2 — enablement at the V1.5→V2 gate + its own §8.1 mini-PRD):** Buyer Procurement Agent = the buyer's own agent on WhatsApp + the web / mobile mirror (`/app/assistant`, route group `(agent-procurement-msme)`). `procurementTurnAgent` / `procurementWatchAgent` (agent-core, harness-driven in 24 golden conversations) run in the runtime (`agent.procurement.turn` / `.decide` / `.watch`, cron `agent-procurement-watch`) under a buyer grant `PROCUREMENT_SCOPES` that holds **neither `accept_quote` nor `place_order`**; "go with B" is the LOCAL gate `choose_quote` whose only effect is the decision-bound link `/app/rfq/<id>?pay=<quote>&d=<decision>` (the page's own confirm sheet, `verifyChooseDecision`); `clampProviderMessage` refuses amounts / % / counter-offers (§8.3 no negotiation); choose / decline / the chase nudge confirm by **button only**; every confirmation is `ai_decisions` feature `procurement_step`; `AgentRun.scriptedCall` refuses money routes. Dispatcher: procurement sits with Munshi BEFORE the opt-in keywords; Support's `new_need` (`support_intent@v2`) offers the start. Migration 0045 (`procurement_sessions`, `procurement_turns`, `wa_conversations.procurement_session_id`; clients SELECT only). Runbook `docs/agents/PROCUREMENT.md`.
- **S2.4 landed (dark):** AMC Score v1 — deterministic formula in shared `score.ts` (`SCORE_VERSION`, weights in code, 90-day window, sample gates, null = neutral prior), nightly `cron/score-compute` via `score_inputs_provider/buyer` functions into `provider_scores` / `buyer_scores` / `score_history` / append-only `score_events`; provider sees own score (`score_card_enabled`), buyers never see a number, admins see both; reliability-adjusted compare ordering server-side above `reliability_rank_threshold_paise` (`reliability_rank_enabled`); Munshi weekly growth nudge (template, no model); ADR-010; migration 0044. Runbook `docs/agents/SCORE.md`.
- **S2.3 landed (dark):** Support agent = intent classifier + template replies from `/api/v1` data (the model never writes user-visible text; `runSupportTurn` in agent-core is the ONE engine for web/mobile (session client, RLS) and WhatsApp (delegated token, scope `support_lookup`)); one action `nudge_counterparty` (confirm-gated, spine routes `POST /orders|rfq/[id]/nudge`, 24 h cap); escalation = `support_tickets` (model summary for ops, halts automation until a human resolves at `/admin/support`); migration 0041. Runbook `docs/agents/SUPPORT.md`.
- **S2.2 landed (dark):** Digital Munshi = proactive provider clerk in the runtime (`munshi.scan` every 15 min, `munshi.followup` hourly, `munshi.decide`), reads only through `/api/v1` under a scoped provider grant (`MUNSHI_SCOPES`; the token carries the union of the user's active grants), drafts require ≥ 1 price-book row and a code-enforced price band (`clampMunshiDraft`), submits only through the ordinary quote/clarification/message routes after the provider's button/web tap (`ai_decisions` feature `munshi_draft` / `munshi_reply`), voice approves only via `isUnambiguousYes` (the model never approves); `munshiDraftAgent` (agent-core) is driven through the eval harness in every golden and red-team case; `munshi_drafts`, `munshi_provider_state`, `quotes.munshi_draft_id`, price-book `accepted_at/deleted_at/source` (+ manual rows via `POST /partner/price-book`); migration 0040. Runbook `docs/agents/MUNSHI.md`.
- **S2.1 landed:** the injection boundary is ONE library behaviour — `envelope()` scores every untrusted part (`injection_suspected` event, never blocks; caps by source kind; Indic digits folded), `customerFacingText()` post-validates every customer-facing schema (contact / payment / ranking / approval / urls; a violation rejects and the route falls back), the taint law is a shared test over `AGENT_TOOLS` plus an agent-writes audit test (`agent-writes.audit.test.ts`, allow-list with two column-scoped exceptions), and `eval --set injection` (79 cases, stub 100 %, live gate blocking in CI when the key exists) must be green before S2.2 / S2.3 / S3.1 start. Migration 0039. Runbook `docs/agents/SECURITY.md`.
- **S1.8 landed (dark):** Phase 8b parser now `rfq_parse@v1/v2` in the registry via `boundedChatJson` (behaviour preserved; `VOICE_PARSE_MODEL` through a per-call gateway override); one clarifying question (`agents_enabled.rfq_clarify`, the ONE rule `needsClarification` in shared, one round enforced server-side — a request carrying `prior` never gets another `clarify`; optional TTS `clarify_tts_enabled`); document intake `POST /api/v1/rfq/document-extract` (`agents_enabled.document_intake`; images / text PDFs → `document_extract@v1` + the masking clamp; STEP / DXF parsed deterministically in shared `drawings/`, never a model); spine `rfq-attachments` bucket + `POST /api/v1/rfq/attachments` (detail loaders sign, pages list them); `rfq_intake_extractions` linked to the RFQ on create with ONE `ai_decisions` row (feature `rfq_intake`); migration 0038. Runbook `docs/agents/VOICE_RFQ_V2.md`.
- **S1.7 landed (dark):** party statements `dispute_statements` (spine, one per party, contact-masked, editable until a triage exists; `POST/PATCH/GET /api/v1/orders/[id]/dispute/statement`); Dispute-Triage agent (ops persona, runtime queue `agent.dispute_triage`, two GET tools `read_order_evidence` + `summarize_dispute`, one frontier call, strict `disputeTriageSchema` with no amount/tool fields, `clampTriage` forces `needs_more_info` on a missing statement) writes `dispute_triages` + `disputes.triage_id`; the resolve route is still the only money path (now `requireNotDelegated`) and links the founder's click to `ai_decisions` (feature `dispute_triage`, tool `summarize_dispute`) when `triage_id` is passed; re-triage on the second statement, cap 3; migration 0037. Runbook `docs/agents/DISPUTE_TRIAGE.md`.
- **S1.6 landed (dark):** Onboarding agent = scripted WhatsApp interview in the runtime (`agent.onboarding` queue; the pure machine in `packages/agent-core/src/onboarding`), ONE model call for the draft (`onboarding_interview@v1`, max two drafts per session), provider confirms by button (`ai_decisions` feature `onboarding`, tool `confirm_onboarding_draft` — a LOCAL confirm gate; free text never confirms), the web/mobile wizard submits (prefilled from `GET /api/v1/agent/onboarding/draft`; `POST /profile/provider.onboardingSessionId` is the only draft → profile link); the agent never verifies, never writes `provider_profiles`; migration 0036 (`onboarding_sessions`, `provider_capability_facts`, `wa_conversations.active_session_id`). Dispatcher order: keywords → active session → JOIN → holding. Settings `budget_run_paise_by_agent`, `onboarding_session_ttl_hours`. Runbook `docs/agents/ONBOARDING.md`; live eval gate (≥ 85 % + 5/5) before any cohort.
- **S1.5 landed (dark):** two-phase RFQ create — `fanout_at IS NULL` = deferred (never a status); `releaseDeferredRfq` (`apps/web/lib/rfq/release.ts`) is the only fan-out release, guarded on `fanout_at IS NULL`; precheck in shared `rfq-quality.ts` with the union rule (rule gaps always stay, the model only adds, cap 3); buyer decides via `POST /api/v1/rfq/[id]/quality/{answer|send}` (one `ai_decisions` row, tool `check_rfq_quality`); hold guard in `cron/rfq-expire` via `agent_settings.rfq_quality_hold_minutes` (default 30); goods RFQs single phase; migration 0035 backfills `fanout_at`. Runbook `docs/agents/RFQ_QUALITY.md`; live eval gate before any cohort.
- **S1.3 landed (spine, no agent):** Clarifications are RFQ-level `rfq_clarifications` visible to all matched providers (`POST/GET /api/v1/rfq/[id]/clarifications`, `POST …/[cid]/answer`; ≤ 3 open per provider; contact-masked with `*_redacted`); "in clarification" is derived (`isInClarification`), never a status — the 72-hour clock and the expiry cron are untouched. Quote revision = `PATCH /api/v1/rfq/[id]/quote` in place (`quotes.revision` 1..3, `quote_events.revised` before/after, optimistic lock), one terms/price path in `lib/rfq/quote-terms.ts` shared by POST and PATCH. Migration 0034. Tools `ask_clarification` / `answer_clarification` / `revise_quote` are `confirm: true` and scope-gated for later agents.
- **Agent S1.2 landed:** `compareQuotes` (shared, deterministic flags + normalised totals — never a model), buyer decline route `POST /api/v1/rfq/[id]/quote/[quoteId]/decline` + `QUOTE_TRANSITIONS` (the one quote map), pointers (`agents_enabled.compare_pointers`, strict schema + banned-phrase gate, no `ai_decisions`) and decline-message (`agents_enabled.decline_message`, template fallback, one `ai_decisions` row) agents; migration 0033 (`quotes.decline_*`, `rfqs.compare_pointers`; `decline_note` hidden from clients by column privileges).
- **Agent S1.1 landed (dark):** bounded helper `apps/web/lib/agent/bounded.ts` (Vercel single-shot calls, `run_id = null`, one `ai_invocations` row each) over `@amclub/agent-core` `runBoundedChatJson`; `quote_extractions` + `provider_price_book` (0032); `POST /api/v1/rfq/[id]/quote/extract` 404s unless `AGENT_ENABLED` + `agents_enabled.quote_extract` + cohort; the submit route records the confirmation in `ai_decisions` (feature `quote_extraction`). Quotes are written by the submit route and, since S3.4, by the group close on the provider's recorded offer; both go through `lib/rfq/quote-terms.ts`.
- **Agent S0.1 landed (dark).** `@amclub/agent-core` (gateway, prompt registry, untrusted Envelope, ledger, budget, runtime credential, `runAgent`/`AgentRun`) is the ONE library shared by `apps/agent-runtime` (Hono + pg-boss, Fly `bom`) and the Vercel functions. Delegated identity: `POST /api/v1/agent/token` mints a ≤15-min run-bound JWT (session persona ⊆ role, or an `AMC-Runtime` HMAC + an active `agent_grants` row); `requireToolScope` gates the five wrapped routes (no-op for ordinary sessions). **`ai_decisions` is the ONE confirmation ledger** — migration 0027 (NOT staged) lifts it out of staged Mart 0022 into an always-applied table (+`run_id`/`tool`) and adds `agent_settings` + `agent_grants`. Agent config is the closed registry `packages/shared/src/agent-settings.ts` (never add an `agent_settings` key without registering it). Whole surface 404s while `AGENT_ENABLED=false`; the model gateway stubs with no key.
- Feature flags for all user-visible changes; ship dark, enable per-cohort. The flags are env switches (`lib/flags.ts`, `lib/public-flags.ts`), the `EXP_V3_*` cohort switches, `agent_settings` and `mart_settings`; PostHog feature flags are not used.
- ADRs in `docs/adr/NNN-*.md` for any decision touching money, auth, or the order state machine.
- Schema changes after launch: migration + backfill plan + rollback note in PR description.

---

## AMC Mart — goods mode (dark build, `MART_ENABLED`)

**Source of truth for Mart:** `docs/MART_DESIGN.md` (build spec — §0 posture, §4 data model, §7 milestones, §8 Launch Gate) + `docs/FRONTEND.md` (Emerald & Brass UI system) + `docs/AMC_Mart_Design_Document.md` (strategy/regulatory). Session step 1 report: `docs/mart/SPINE_VERIFICATION.md`. Decision record: `docs/adr/005-mart-dark-build-one-spine.md`.

- **ONE SPINE, TWO MODES.** Sellers are providers (`provider_profiles.sells_goods`, gated on a verified GSTIN). Goods orders are `orders` rows with `kind='goods'` + `line_items`. Delivery photos are `order_documents` (`dispatch_photo` / `delivery_photo`). `payout.ts` / `processRefund` / `generateInvoices` are the only money paths — a second one is a design violation.
- **Flag gate first.** Every Mart page calls `martPageGate()` and every `/api/v1/mart/*` route calls `martApiGate()` (`apps/web/lib/mart/gate.ts`) before anything else. Nav entries are filtered on `MART_ENABLED`. Mobile reads `/profile/me.martEnabled`. **Mart pages live in their own route groups** — `(mart-public)/mart`, `(mart-msme)/app/mart`, `(mart-provider)/partner/goods`, `(mart-admin)/admin/mart` — whose layout gates before rendering the parent group's shell; a Mart page placed under `(public)`/`(msme)`/`(provider)`/`(admin)` would stream a 200 with the 404 UI when the flag is off (group `loading.tsx`). Put new Mart routes in the `(mart-*)` group. The same rule holds for agent pages, **one group per agent switch** (a group layout cannot see which page it wraps): `(agent-provider)` = Munshi, `(agent-support-provider)` / `(agent-msme)` = Support, `(agent-translate-provider)` = content translation (E14c), `(agent-pools-msme)` / `(agent-pools-provider)` = group requests (S3.4), `(agent-admin)` = the console.
- **Migration 0022 is STAGED** — it deploys with the `MART_ENABLED=true` release (Launch Gate §8.2). `verify-migrations.ts` marks it `staged`; use `MART_MIGRATIONS_EXPECTED=false` when verifying a database without them. **Prod status (2026-09-24): 0022–0025 and 0069 are applied and `MART_ENABLED=true`** (Mart launched together with services). The staged-column rule below still holds so the flag-off path stays inert and the kill switch stays clean.
- **Inertness is a deliverable.** Any edit to a shared file must be a `kind === 'goods'` branch and must keep `pnpm --filter @amclub/shared test`, `killtest-mart-schema.ts`, and `verify-mart-inert.ts` green. **Never name a staged column (0022–0025) in a non-Mart select/filter** — production lacks them until the Launch Gate and PostgREST fails the whole query (2026-09-09 incident: fan-out, RFQ list, compare, quote→order all dead with the flag off). Append the fragments from `lib/mart/staged-columns.ts` instead; `pnpm --filter @amclub/web mart:static` enforces it offline, and the four services suites must run against prod after every Mart merge.
- **Money is server-computed only.** `computeGoodsOrderAmounts` (per-line GST + commission) runs in `lib/mart/totals.ts`; clients render server paise (cart preview, checkout response, tier displays). Client money arithmetic is review-blocking (FRONTEND.md §8).
- **Goods actions** live in `apps/web/lib/mart/goods-transitions.ts` and map onto the existing §3.7 transitions (`dispatch` = `accepted → requirements_submitted → in_progress`; `open_return` = `delivered|completed → disputed`). Release gate: `apps/web/lib/mart/release.ts` (`evaluateGoodsReleaseGate` in shared).
- **Config, not constants:** return windows / commission per category in `mart_categories`; e-way threshold, auto-approve N, TDS in `mart_settings`. Founder decisions §9 are edited there.
- **Every AI proposal a human confirms → `ai_decisions`** (`recordAiDecision`), refs only.
- Vocabulary: product statuses `draft | pending_approval | active | suspended`; goods events `dispatched | delivered_photo | buyer_received | return_opened | return_resolved`; pool machine in `packages/shared/src/mart/pools.ts`.
- **M1 pools (migration 0023, STAGED with 0022; ADR-006).** Pay-on-close: joining records a commitment, no money moves; on `closed_met` each member pays an ordinary goods checkout session at the pool price (one order per member). `apps/web/lib/mart/pools.ts` owns every transition; `mayCapturePoolMember` is the ONLY capture guard; every status write is guarded on the state it expects (replay-safe). `pool_payment_mode='block_capture'` is refused until `docs/mart/PSP_BLOCK_CAPTURE_REPORT.md` §5 is signed off. Agents draft (`group-buy-agent.ts`, `documents-agent.ts`), humans confirm → `ai_decisions`.
- **M2 goods RFQ (migration 0024, STAGED with 0022/0023; ADR-007).** Bulk / spec goods requests are `rfqs` rows with `kind='goods'` + `mart_category_slug` + `goods_spec` (`goodsRfqSpecSchema`); `category_id` is NULL only for goods. Fan-out goes to in-state `sells_goods` sellers (`fanoutGoodsRfq`), never the services category graph. A goods quote states unit price + GST slab + HSN (`goodsQuoteTermsSchema`); the route sets `price_paise = qty × unit` and ignores the client total. Accepting a goods quote = an ordinary goods checkout session built by `apps/web/lib/mart/goods-rfq.ts` (`goodsQuoteLineItem` + `computeGoodsOrderAmounts`) — no second money path. Compare-screen money is computed in `lib/rfq/queries.ts` (`mapQuoteGoods`). Page `/app/mart/rfq/new` is `martPageGate()`d; the goods branch of `/api/v1/rfq` 404s when the flag is off.
- **Launch Gate readiness (migration 0025, STAGED; `docs/mart/LAUNCH_RUNBOOK.md`).** §9 founder decisions are edited at `/admin/mart/settings` against the closed registry `packages/shared/src/mart/settings.ts` (`MART_SETTING_DEFS`, `martCategoryPatchSchema`) — never add a `mart_settings` key without registering it. The provider addendum goods schedule (sections 6–8) renders and bumps ONLY when `MART_ENABLED=true` (`effectiveLegalVersions` in shared; web reads `lib/legal/versions.ts`, never `LEGAL_VERSIONS` directly). Ops scripts: `mart:preflight` (read-only §8 check, `EXPECT_FLAG=on|off`), `mart:smoke` (one real internal order), `mart:acceptance` (M0–M2 suites; `--inert` for flag-off).

---

## Scope note — native mobile (deliberate deviation from §1.7)

§1.7 lists native mobile apps as V1 out-of-scope (plan: PWA first, React Native when PWA retention plateaus). Per explicit founder instruction, `apps/mobile` (Expo/React Native, Android-first) is built alongside `apps/web` from Phase 0, sharing `packages/shared` and consuming the same `/api/v1`. This decision is recorded here per §8.4 as a founder-authorised scope override.

---

## Repo layout

```
amclub/
├── apps/
│   ├── web/          # Next.js 15 App Router — three route groups + /api/v1
│   └── mobile/       # Expo (React Native) — Android-first
├── packages/
│   ├── shared/       # Zod schemas, types, state machines, category constants — zero runtime deps except zod
│   └── db/           # Drizzle ORM schema + migrations — source of truth for Postgres schema
├── docs/
│   ├── DESIGN.md     # Master design document (source of truth — services)
│   ├── MART_DESIGN.md# AMC Mart build spec (goods mode, dark build)
│   ├── FRONTEND.md   # Emerald & Brass UI system + Goldsmith motion
│   ├── mart/         # Mart verification reports
│   └── adr/          # Architecture Decision Records
├── .env.example      # Variable names only — no secrets ever in repo
├── CLAUDE.md         # This file
├── turbo.json
└── pnpm-workspace.yaml
```

## Key conventions

- **Naming:** `snake_case` DB columns, `camelCase` TypeScript, `kebab-case` routes.
- **Package names:** `@amclub/shared`, `@amclub/db`.
- **Internal packages** use the "source" pattern — `main` points to `./src/index.ts`; consumers handle transpilation (`transpilePackages` in Next.js, `watchFolders` in Metro).
- **Env vars:** new server variables are validated via Zod in `lib/env.ts`; some older ones are still read straight from `process.env` (audit L6), so read `lib/env.ts` before assuming a variable is validated. Server-only vars (service-role key, webhook secrets, payment secrets) are never prefixed `NEXT_PUBLIC_`.
- **PostHog events:** every feature ships with instrumentation in the same PR. Canonical event names in `docs/DESIGN.md` Appendix A.
