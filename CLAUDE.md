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
placed | accepted → cancelled_by_buyer         ← policy-based refund %
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

- **NOT-NOW register (§8.3):** AI matching/chatbot, bidding wars on RFQs, pre-order chat, cash/offline payments, social feed, gamification, video consults, multi-currency, dynamic surge pricing, blockchain — do not implement under any circumstances.
- Feature flags (PostHog flags) for all user-visible changes; ship dark, enable per-cohort.
- ADRs in `docs/adr/NNN-*.md` for any decision touching money, auth, or the order state machine.
- Schema changes after launch: migration + backfill plan + rollback note in PR description.

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
│   ├── DESIGN.md     # Master design document (source of truth)
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
