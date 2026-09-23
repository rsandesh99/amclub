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
| **Notifications** | MSG91 (SMS) · Gupshup/Interakt (WhatsApp) · Resend (email) · Web Push |
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
completed → reviewed
```

**Payout rule:** provider payout releases ONLY from `completed` or `resolved_release` / `resolved_partial`.

The state machine may be **extended** (new states added) but transitions may never be repurposed — downstream payout logic depends on them (§8.4).

---

## RFQ state machine

```
open → quoted → accepted → (converts to order)
open → expired            (72h, no quotes)
open → cancelled          (buyer cancels)
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
- **Agent programme PAUSED after S3.2 (founder, 2026-09-23)** so Experience v3 can take the build. S3.3 resumes when H7 (Razorpay test keys) + ADR-011 + the CA opinion land; S3.4's tiered quotes are redesigned together with E12b speed tiers after Wave 1; S4.2 waits on D1; S4.1 keeps its six-month gate; S4.3 is paperwork. Do not start any S3.3+ prompt until this line is removed.
- **Agent programme (staged build).** Before any agent work read `docs/agents/ARCHITECTURE.md` (the locked architecture; its §7 invariants checklist goes into every agent PR) + ADR-009 (build shape) alongside ADR-008 (topology). The executable plan is `BUILD_PROMPTS.md` — sequential gated PRs S0.1→S4.3, run in order, one PR per prompt, never combined; everything ships dark behind `agent_settings.agents_enabled.<name>` + a cohort allowlist.
- **H1 landed (CI):** `.github/workflows/money-rigs.yml` runs `verify-authz`, `verify-money-loop`, both webhook kill-tests, `verify-phase7` and `verify-rfq` on every PR against a throwaway `supabase start` stack (`.github/supabase-ci`, schema from the commit via `db:bootstrap` + seed, buckets from `buckets.sql`, Redis behind an Upstash REST front so limiters engage, simulate-payment mode). A money-path change adds or extends a rig criterion there; rigs never run against production. **GitHub does not enforce required checks on this private repo (plan limit), so the rule is ours: never merge a PR while `Money rigs · disposable Supabase` or `Lint · Typecheck · Test · Build` is red or still running.**
- **ADR-018 landed (security hotfix, migration 0064):** money and order-state rows are **server-written only**. Client roles hold no INSERT/UPDATE/DELETE on orders, checkout_sessions, payments, payouts, refunds, invoices, disputes, order_documents, rfqs, quotes, rfq_matches, coupons, coupon_redemptions, provider_bank_accounts or reviews, and `materialize_order()` is EXECUTE for `service_role` only. Every writer is a `/api/v1` route or job on the admin client, after its own authorisation. A new client write grant on these tables is review-blocking. `verify-authz` §7a proves it on every PR.
- **ADR-019 landed (E12a, money, dark: `addons_enabled`, migration 0065):** package add-ons. Shared `packageCharge` is the ONE rule: package + Σ add-ons, the package discount on the package only, a coupon on the whole subtotal, one `computeOrderAmounts`, byte-identical with no add-ons. Checkout, `POST /api/v1/checkout/preview`, the coupon route and the checkout page all call it. The snapshot is frozen on the session and copied onto the order by trigger. An id that isn't an active add-on → 409 `addon_changed`. Invoices get one line per add-on. Writes go only through `/api/v1/partner/packages/[id]/addons` on the service role.
- **ADR-020 landed (E12b, money, dark: `quote_options_enabled`, migration 0066):** quote speed options. The quote row IS Standard. `quote_options` holds Economy / Express per quote revision (immutable rows, service role only). Coherence is shared `quoteOptionsProblems`: Express faster and never cheaper, Economy slower and never dearer; otherwise 400. Compare choices come from shared `quoteChoices` / `choiceExtremes`. Checkout `optionId` must be this quote's at its current revision, else 404 `option_not_found`; it charges `quoteChargeAmounts(option price, quote GST mode)` with the option's days. Finalize records `quotes.selected_option_id`, and loss labels use the winning option.
- **ADR-015 landed (H5, money):** a services quote with `gst_included = true` is charged exactly its quoted price. Shared `computeGstInclusiveOrderAmounts` carves GST out (`total = gross`, commission on taxable); `false` / `null` still add GST on top. Only the checkout quote branch uses it.
- **ADR-014 landed (H3 + H4, money safety):** shared `planDisputeSettlement` is the ONE rule for what a dispute resolution may do to the payout and refund rows. `paid` / `processing` payouts are never rewritten or re-sent (409 `provider_already_paid` / `payout_in_flight`); one refund row per order, so an earlier refund is a 409 `refund_exists` (resolve AND `manual_refund`), and every caller reads back `processRefund`'s amount (`refund_mismatch`). The claim is atomic, and an interrupted resolve is finished only with the same resolution and amount after 10 minutes (CAS on `orders.updated_at`). Console codes are `admin_ops.money_err_*`. **H2 (ADR-014 §6):** every status after the provider accepts can be disputed (the `accepted` / `requirements_submitted` / `revision_requested` → `disputed` edges), and `completed → disputed` only within `agent_settings.dispute_window_days` (default 7) via shared `canRaiseDispute`; the server sends the deadline (`disputeWindowEndsAt`) and clients never compute it. **H6 (ADR-014 §7):** a second paid order on an accepted RFQ goes `placed → cancelled_duplicate → refunded` in the same `finalizeQuoteAcceptance` pass, with a 100 % refund read back; anything that cannot complete stays flagged for ops. ADR-014 no longer blocks ADR-011.
- **E14c landed (dark; N32b):** provider content translation — `provider_content_translate@v1` (task class `content_translate`, residency in) DRAFTS a package title / "Choose this if…" / the About into hi / te / ta; drafts live in `content_translations` (0061) and never render; only the provider's approve (`lib/translations/content.ts`, a spine path; claim-first, re-checks English unchanged + shared `contentNumbersProblems` + the customer-facing contract) writes the slot + `i18n_sources` `machine_approved` + exactly one `ai_decisions` row (feature `content_translation`); buyers see "Translated · View original". Locks `AGENT_ENABLED` + `agents_enabled.content_translate` + cohort; route group `(agent-translate-provider)`. Runbook `docs/agents/CONTENT_TRANSLATION.md`.
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
- **Agent S1.1 landed (dark):** bounded helper `apps/web/lib/agent/bounded.ts` (Vercel single-shot calls, `run_id = null`, one `ai_invocations` row each) over `@amclub/agent-core` `runBoundedChatJson`; `quote_extractions` + `provider_price_book` (0032); `POST /api/v1/rfq/[id]/quote/extract` 404s unless `AGENT_ENABLED` + `agents_enabled.quote_extract` + cohort; the submit route is still the only quote writer and records the confirmation in `ai_decisions` (feature `quote_extraction`).
- **Agent S0.1 landed (dark).** `@amclub/agent-core` (gateway, prompt registry, untrusted Envelope, ledger, budget, runtime credential, `runAgent`/`AgentRun`) is the ONE library shared by `apps/agent-runtime` (Hono + pg-boss, Fly `bom`) and the Vercel functions. Delegated identity: `POST /api/v1/agent/token` mints a ≤15-min run-bound JWT (session persona ⊆ role, or an `AMC-Runtime` HMAC + an active `agent_grants` row); `requireToolScope` gates the five wrapped routes (no-op for ordinary sessions). **`ai_decisions` is the ONE confirmation ledger** — migration 0027 (NOT staged) lifts it out of staged Mart 0022 into an always-applied table (+`run_id`/`tool`) and adds `agent_settings` + `agent_grants`. Agent config is the closed registry `packages/shared/src/agent-settings.ts` (never add an `agent_settings` key without registering it). Whole surface 404s while `AGENT_ENABLED=false`; the model gateway stubs with no key.
- Feature flags (PostHog flags) for all user-visible changes; ship dark, enable per-cohort.
- ADRs in `docs/adr/NNN-*.md` for any decision touching money, auth, or the order state machine.
- Schema changes after launch: migration + backfill plan + rollback note in PR description.

---

## AMC Mart — goods mode (dark build, `MART_ENABLED`)

**Source of truth for Mart:** `docs/MART_DESIGN.md` (build spec — §0 posture, §4 data model, §7 milestones, §8 Launch Gate) + `docs/FRONTEND.md` (Emerald & Brass UI system) + `docs/AMC_Mart_Design_Document.md` (strategy/regulatory). Session step 1 report: `docs/mart/SPINE_VERIFICATION.md`. Decision record: `docs/adr/005-mart-dark-build-one-spine.md`.

- **ONE SPINE, TWO MODES.** Sellers are providers (`provider_profiles.sells_goods`, gated on a verified GSTIN). Goods orders are `orders` rows with `kind='goods'` + `line_items`. Delivery photos are `order_documents` (`dispatch_photo` / `delivery_photo`). `payout.ts` / `processRefund` / `generateInvoices` are the only money paths — a second one is a design violation.
- **Flag gate first.** Every Mart page calls `martPageGate()` and every `/api/v1/mart/*` route calls `martApiGate()` (`apps/web/lib/mart/gate.ts`) before anything else. Nav entries are filtered on `MART_ENABLED`. Mobile reads `/profile/me.martEnabled`. **Mart pages live in their own route groups** — `(mart-public)/mart`, `(mart-msme)/app/mart`, `(mart-provider)/partner/goods`, `(mart-admin)/admin/mart` — whose layout gates before rendering the parent group's shell; a Mart page placed under `(public)`/`(msme)`/`(provider)`/`(admin)` would stream a 200 with the 404 UI when the flag is off (group `loading.tsx`). Put new Mart routes in the `(mart-*)` group. The same rule holds for agent pages, **one group per agent switch** (a group layout cannot see which page it wraps): `(agent-provider)` = Munshi, `(agent-support-provider)` / `(agent-msme)` = Support, `(agent-translate-provider)` = content translation (E14c), `(agent-admin)` = the console.
- **Migration 0022 is STAGED** — never apply to prod during the build; it deploys with the `MART_ENABLED=true` release (Launch Gate §8.2). `verify-migrations.ts` marks it `staged`; use `MART_MIGRATIONS_EXPECTED=false` when verifying prod.
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
- **Env vars:** all validated via Zod in `lib/env.ts` at boot. Server-only vars (service-role key, webhook secrets, payment secrets) are never prefixed `NEXT_PUBLIC_`.
- **PostHog events:** every feature ships with instrumentation in the same PR. Canonical event names in `docs/DESIGN.md` Appendix A.
