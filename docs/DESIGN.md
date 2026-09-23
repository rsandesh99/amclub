# AMClub (All India MSME Club) — Master Design Document

**Company:** Swathisri Infra Projects Private Limited
**Product:** AMClub — a two-sided B2B services marketplace for India's MSMEs
**Document version:** 1.0 · June 2026
**Status:** Source of truth for all build work. AI agents and developers must treat this document as authoritative. Anything not in this document is out of scope until added through the change process in §8.

---

## How this document is organised

| § | Document | Purpose |
|---|----------|---------|
| 0 | Context & Strategy | Why AMC exists, market grounding, the marketplace model |
| 1 | PRD | What we're building, for whom, and what success looks like |
| 2 | TRD | The exact tech stack, services, and conventions |
| 3 | App Flow | Every screen, journey, and edge case |
| 4 | UI/UX Design Brief | Visual language, components, accessibility, localisation |
| 5 | Backend Schema | Full data model, auth, RLS, storage, API surface |
| 6 | Implementation Plan | Phased build sequence with done-criteria |
| 7 | Scale-Up Architecture | How the system evolves from 1K to 1M+ MSMEs |
| 8 | Feature-Creep Governance | Version gates, scoring, and the explicit NOT-NOW list |
| 9 | Risks, Compliance & Trust | Legal, payments, data protection, marketplace integrity |

---

# §0 — CONTEXT & STRATEGY

## 0.1 The opportunity (from AMC research)

- India has **63+ million MSMEs** (~6.2 crore micro, ~33 lakh small, ~5–10K medium), contributing ~30% of GDP and ~45% of exports.
- Sector split: ~36% trade, ~33% services, ~31% manufacturing. The top 10 states (UP, WB, TN, MH, KA, BR, AP, GJ, RJ, MP) hold ~74% of all MSMEs.
- The pain is documented: **68%** face documentation difficulties, **62%** lack scheme awareness, **55%** face approval delays, **49%** lack operational guidance, **37%** face digital accessibility barriers, and **>90% remain informal**.
- MSMEs today juggle multiple unconnected vendors — CA, lawyer, HR consultant, marketer, banker — with no price transparency, no quality signal, and no single place to compare.

## 0.2 The product in one sentence

**AMClub is the Swiggy/Zomato of MSME business services**: MSMEs on the demand side discover, compare (pricing, discounts, ratings, verification), and hire vetted service providers on the supply side — legal, CA/audit, company registration, HR & staffing, financing facilitation, digital marketing, web development, government licensing/subsidy assistance, raw-material procurement, and more.

## 0.3 The marketplace model — key design decision

Food delivery has *fixed-price SKUs*. B2B services do not — a GST registration is fixed-price, but "draft my shareholder agreement" is not. AMC therefore supports **two transaction modes from day one**:

1. **Fixed-Price Packages ("Buy Now")** — productised services with a defined scope, price, delivery time, and optional discount (e.g., "Private Ltd Registration — ₹6,999, 7 days, 20% off for AMC members"). This is the Swiggy-like core: browse → compare → pay → track.
2. **Request for Quote (RFQ)** — the MSME describes a need; matched providers respond with quotes; the MSME accepts one and it converts to an order. This covers everything that can't be productised.

Both modes flow into the same **order pipeline** (milestones → delivery → review), the same **payment/escrow rail**, and the same **commission engine**. This unification is the single most important architectural decision in this document.

## 0.4 Sides of the marketplace

| Side | Who | What they do |
|------|-----|--------------|
| **Demand** | MSME owners/managers (manufacturing, trade, services; Tier 2/3 heavy) | Discover, compare, request quotes, buy, track orders, review |
| **Supply** | Service providers: CA/CS firms, law firms, HR agencies, marketing agencies, web dev shops, loan DSAs/financing facilitators, licensing consultants, procurement vendors | List packages, respond to RFQs, deliver, get paid |
| **Platform** | AMC ops & admin | Verify providers, moderate, resolve disputes, manage categories/commissions, run promotions |

## 0.5 Monetisation (aligned with the pitch deck)

1. **Service commission** — % per transaction (category-configurable, e.g., 8–15%). Primary revenue.
2. **AMC membership subscriptions** — MSME-side plans (Free / Pro / Premium) unlocking discounts, priority support, and tools.
3. **Provider subscriptions & visibility** — listing tiers, "Featured" placement (clearly labelled as sponsored).
4. **Marketplace revenue (AMC Mart)** — later-phase procurement transactions.
5. **Premium AI tools** — later-phase analytics/automation.

Only #1 and a simple version of #2 ship in V1 (see §8).

---

# §1 — PRD: PRODUCT REQUIREMENTS DOCUMENT

## 1.1 Identity

- **App name:** AMClub (All India MSME Club)
- **Tagline:** *Every service your business needs. One platform. Verified. Transparent.*
- **Hindi tagline (for localisation):** *आपके व्यवसाय की हर ज़रूरत, एक ही जगह।*

## 1.2 Problem statement

MSME owners waste weeks finding trustworthy professionals, have zero price transparency (the same GST registration is quoted ₹500–₹15,000), can't verify credentials, and have no recourse when work goes wrong. Service providers, in turn, spend heavily on lead generation with no structured pipeline. There is no Zomato-equivalent trust layer for B2B services in Bharat.

## 1.3 Core value proposition

- **For MSMEs:** Compare verified providers side-by-side with transparent pricing and real reviews; pay safely through the platform; track delivery like a food order.
- **For providers:** A qualified, high-intent lead pipeline with payments guaranteed via platform escrow — pay only on success (commission), not per lead.
- **Differentiator vs. Saarthika/InfoTree/Udyam Assist (per competitive matrix):** they stop at *discovery/information*; AMC owns the **full transaction and delivery loop** — discovery → comparison → payment → milestone tracking → review.

## 1.4 Target personas

**P1 — "Ramesh", MSME owner (primary buyer).** 38, runs a 12-person fabrication unit in Vijayawada. Smartphone-first, comfortable in Telugu + functional English/Hindi. Needs: GST filings, a labour-law compliance check, a website, and a working-capital loan. Currently relies on word-of-mouth. Will pay for certainty and speed. Patience for forms: very low.

**P2 — "Priya", CA firm partner (primary seller).** 31, runs a 6-person CA practice in Pune serving 80 clients. Wants predictable lead flow without paying ₹500/lead to listing sites. Comfortable on desktop; her staff use mobile. Needs a clean order queue, document exchange, and reliable payouts.

**P3 — "Arjun", AMC operations admin (internal).** Verifies provider credentials, handles disputes, configures categories and commissions, monitors marketplace health.

## 1.5 Core features — MUST HAVE (V1)

**MSME side**
- M1. Signup/login (phone OTP primary, email optional) + MSME business profile (Udyam no., GST no., sector, state, language preference)
- M2. Category browse (2-level taxonomy) + search with filters (price, rating, location/state, language, delivery time, verified-only)
- M3. Provider profile page: credentials, verification badges, packages with pricing & discounts, reviews, response time
- M4. Package detail + **Buy Now** checkout (Razorpay: UPI, cards, netbanking)
- M5. **RFQ flow:** post a requirement → receive up to N quotes → compare → accept → pay
- M6. Order tracking: status timeline, milestones, document upload/download, in-order messaging
- M7. Ratings & reviews (post-completion only, verified-purchase)
- M8. Saved/shortlisted providers; order history; invoices (GST-compliant)
- M9. Notifications: in-app + SMS/WhatsApp for order events (transactional only)
- M10. Language: English + Hindi at launch (architecture ready for 8+ languages)

**Provider side**
- S1. Provider onboarding: business KYC, credential upload (CA membership, Bar Council, GST, etc.), bank details for payouts
- S2. Service listing management: create packages (title, scope, deliverables, price, discount, delivery days, FAQs)
- S3. RFQ inbox: view matched requests, submit quotes (price + scope + timeline)
- S4. Order workspace: accept order, update milestones, exchange documents/messages, mark delivered
- S5. Earnings dashboard: completed orders, pending payouts, commission breakdown
- S6. Profile & availability management (pause listings, set capacity)

**Admin side**
- A1. Provider verification queue (approve/reject with reasons; badge assignment)
- A2. Category/taxonomy management; commission-rate configuration per category
- A3. Order & dispute monitoring; manual refund/payout triggers
- A4. Review moderation (flagged content)
- A5. Basic analytics: GMV, orders, take rate, conversion funnel, top categories/states
- A6. CMS for banners/announcements; coupon creation

## 1.6 NICE TO HAVE (V1.5 — only after V1 ships and metrics justify)

- WhatsApp-bot order status & RFQ creation
- AMC membership tiers with member-only discounts (full version)
- Provider "Featured" paid placement
- Scheme-discovery content hub (SEO play, links to MyScheme/MSME portals)
- Referral programme
- Telugu, Tamil, Marathi, Bengali, Gujarati language packs

## 1.7 Explicitly OUT OF SCOPE for V1 (see §8 for the full NOT-NOW register)

- AMC Mart raw-material/product marketplace
- AI matching engine, AI chatbot, AI document analysis
- Lending/NBFC integration (financing listed only as *facilitation services* by DSA providers)
- Native mobile apps (V1 is a mobile-first PWA)
- Multi-branch/team accounts, API for third parties, white-labelling
- Automated compliance-calendar engine

## 1.8 User stories (acceptance-level)

- As an MSME owner, I want to compare three CA firms' GST-registration packages by price, rating, and delivery time on one screen, so that I can choose in under 5 minutes.
- As an MSME owner, I want to post "I need a trademark for my brand" and receive quotes within 48 hours, so I don't have to call ten lawyers.
- As an MSME owner, I want my payment held by the platform until the provider delivers, so I'm protected from no-shows.
- As a provider, I want to list a fixed-price package with a strikethrough discount, so AMC members see a deal and convert faster.
- As a provider, I want to be notified instantly when an RFQ matches my category and state, so I can quote before competitors.
- As an admin, I want to verify a provider's CA membership number before their badge goes live, so the trust layer stays credible.
- As an MSME owner, I want the entire app in Hindi, so my accountant can use it without my help.

## 1.9 Success metrics (first 6 months post-launch)

| Metric | Target |
|--------|--------|
| Verified providers onboarded | 500 across 8 core categories |
| Registered MSMEs | 10,000 |
| Monthly completed orders | 600 by month 6 |
| RFQ → quote response rate | ≥70% within 48h |
| Buyer NPS / avg review | ≥4.2/5 |
| Take rate (blended) | 10–12% |
| Order dispute rate | <5% |
| Search → provider-view → checkout conversion | ≥2.5% end-to-end |
| Repeat purchase rate (90-day) | ≥25% |

## 1.10 Service category taxonomy (launch set)

1. **Company & Registrations** — Pvt Ltd/LLP/OPC incorporation, Udyam, GST reg, FSSAI, IEC, MSME certs
2. **Tax & Accounting** — GST filing, ITR, bookkeeping, audits, TDS
3. **Legal** — contracts, trademarks/IP, notices, labour-law compliance
4. **HR & Staffing** — recruitment (skilled/unskilled), payroll, HR policy setup
5. **Finance Facilitation** — loan documentation & DSA services, CGTMSE/Mudra application help, project reports
6. **Digital Marketing** — social media, SEO, performance ads, branding
7. **Web & Tech** — websites, e-commerce setup, ONDC onboarding, app dev
8. **Government & Licensing** — factory licence, pollution NOC, subsidy/scheme application assistance (PMEGP, state schemes), tender/GeM onboarding

Each category carries: icon, description (i18n), commission rate, RFQ form template, and required provider credentials.

---

# §2 — TRD: TECHNICAL REQUIREMENTS DOCUMENT

## 2.1 Guiding constraints

- **Mobile-first PWA** (Ramesh is on a ₹12K Android phone, often on 4G in a Tier-3 town). Target <200KB critical JS, works on slow networks, installable.
- **One codebase, three surfaces:** MSME app, Provider app, Admin — same Next.js monorepo, separate route groups.
- **India-stack native:** Razorpay, phone-OTP, GSTIN/Udyam validation, INR-only V1.
- **Boring technology** where possible; the startup risk is market, not tech.

## 2.2 Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Frontend | **Next.js 15 (App Router) + TypeScript + Tailwind CSS** | SSR/ISR for SEO (provider pages must rank), single team skillset |
| Component lib | shadcn/ui + Radix primitives | Accessible, themeable, no lock-in |
| State/data | TanStack Query (server state) + Zustand (minimal client state) | Cache-first, avoids Redux overhead |
| Backend | **Next.js API routes / Route Handlers + Supabase** (Postgres, Auth, Storage, Realtime) | Fastest path to production; Postgres is the long-term DB regardless (see §7 exit ramps) |
| Heavy/async jobs | Supabase Edge Functions + **pg-boss** (Postgres-backed queue) for V1; BullMQ+Redis at scale | Notifications, matching fan-out, payout batching |
| Search | **Postgres FTS + pg_trgm** in V1 → **Meilisearch/Typesense** at >5K listings | Don't run a search cluster before you need it |
| Auth | Supabase Auth: **phone OTP (MSG91/Twilio SMS hook)** + email/password + Google OAuth | Phone-first for Bharat |
| Payments | **Razorpay**: Payment Gateway + **Route** (split settlements for marketplace payouts) + Webhooks | Native marketplace splits, UPI dominant |
| File storage | Supabase Storage (S3-compatible) | Order documents, credentials, images |
| Notifications | MSG91 (SMS), **WhatsApp Business API via Gupshup/Interakt** (transactional), Resend (email), Web Push | Order events; WhatsApp is the channel MSMEs actually read |
| i18n | next-intl, ICU messages, all strings in locale JSON; **no hardcoded copy ever** | en + hi launch; 8+ languages later |
| Hosting | Vercel (frontend+API), Supabase cloud (Mumbai region `ap-south-1`) | Data residency + latency |
| Monitoring | Sentry (errors), Vercel Analytics, PostHog (product analytics, self-serve funnels) | Funnel metrics in §1.9 must be measurable from day 1 |
| Validation | Zod everywhere (API input, forms, env) | One schema → form + API + types |

## 2.3 Third-party APIs

| Service | Purpose | Tier |
|---------|---------|------|
| Razorpay PG + Route | Payments, refunds, split payouts | % per txn |
| MSG91 | OTP + transactional SMS | Paid, cheap |
| Gupshup / Interakt | WhatsApp transactional messages | Paid |
| Resend | Email | Free tier OK V1 |
| Surepass / Signzy (pick one) | **GSTIN, Udyam, PAN, bank-account verification APIs** for provider KYC | Paid per check — critical for the trust layer |
| Google Maps Places | Provider location autocomplete | Free tier |
| PostHog Cloud | Analytics | Free tier V1 |

## 2.4 Repo & conventions

```
amclub/
├── apps/web/                  # Next.js app
│   ├── app/
│   │   ├── (marketing)/       # Public: landing, category SEO pages, provider public profiles
│   │   ├── (msme)/            # Buyer dashboard: /app/...
│   │   ├── (provider)/        # Seller dashboard: /partner/...
│   │   ├── (admin)/           # /admin/... (role-gated)
│   │   └── api/               # Route handlers (REST-ish, versioned /api/v1/...)
│   ├── components/{ui,marketplace,orders,forms}/
│   ├── lib/{supabase,razorpay,notifications,validation}/
│   └── messages/{en,hi}.json  # i18n
├── packages/db/               # Drizzle ORM schema + migrations (source of truth = code)
├── packages/shared/           # Zod schemas, types, constants (category enums, order states)
└── docs/                      # This document, ADRs
```

- **Naming:** snake_case DB, camelCase TS, kebab-case routes. All money in **paise (integer)**. All timestamps `timestamptz` UTC; render in IST.
- **State machines:** order/RFQ/payout statuses are enums with a transition map in `packages/shared/state-machines.ts`; API rejects illegal transitions. No status string literals anywhere else.
- **Env vars:** `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (server only), `RAZORPAY_KEY_ID/KEY_SECRET/WEBHOOK_SECRET`, `MSG91_AUTH_KEY`, `WHATSAPP_API_KEY`, `RESEND_API_KEY`, `KYC_API_KEY`, `SENTRY_DSN`, `POSTHOG_KEY`. Zod-validated at boot in `lib/env.ts`.

## 2.5 Hard rules for AI agents building this

1. Never bypass RLS by using the service-role key in client-reachable code paths without an explicit authz check.
2. Every payment mutation is idempotent (idempotency keys) and driven by **Razorpay webhooks as source of truth**, never client redirects.
3. Every user-visible string goes through next-intl.
4. Every table gets `created_at`, `updated_at`; soft-delete (`deleted_at`) on user-content tables.
5. Write the Zod schema first; derive form + API validation from it.

---

# §3 — APP FLOW: NAVIGATION & USER JOURNEYS

## 3.1 Page inventory

**Public (marketing + SEO)**
| Route | Purpose |
|-------|---------|
| `/` | Landing: hero search, category grid, trust stats, top providers, how-it-works |
| `/services` | All categories |
| `/services/[category]` | Category page: provider/package listings + filters (ISR, SEO-critical) |
| `/services/[category]/[subcategory]` | Filtered listing |
| `/p/[provider-slug]` | **Public provider profile** (SEO-critical: this is the Zomato restaurant page) |
| `/p/[provider-slug]/[package-slug]` | Package detail |
| `/about`, `/for-partners`, `/pricing`, `/contact`, `/legal/*` | Static |
| `/login`, `/signup`, `/partner/signup` | Auth |

**MSME app (`/app/*`, role: msme)**
`/app` (home: active orders, recommendations, RFQ status) · `/app/search` · `/app/rfq/new` · `/app/rfq/[id]` (quotes comparison) · `/app/orders` · `/app/orders/[id]` (workspace: timeline, docs, chat) · `/app/saved` · `/app/profile` (business details, language) · `/app/invoices` · `/app/notifications`

**Provider app (`/partner/*`, role: provider)**
`/partner` (dashboard: new RFQs, active orders, earnings snapshot) · `/partner/onboarding` (multi-step KYC wizard) · `/partner/listings` + `/partner/listings/new|[id]/edit` · `/partner/rfqs` + `/partner/rfqs/[id]/quote` · `/partner/orders` + `/partner/orders/[id]` · `/partner/earnings` (payouts, commission statements) · `/partner/profile` · `/partner/reviews`

**Admin (`/admin/*`, roles: admin, ops)**
`/admin` (KPI dashboard) · `/admin/verifications` · `/admin/providers` · `/admin/msmes` · `/admin/categories` · `/admin/orders` · `/admin/disputes/[id]` · `/admin/reviews` · `/admin/coupons` · `/admin/payouts` · `/admin/cms`

## 3.2 Navigation structure

- **Mobile (default):** bottom tab bar — MSME: *Home · Search · Orders · Inbox · Profile*; Provider: *Dashboard · RFQs · Orders · Earnings · Profile*. Sticky top bar: logo, language switcher, notification bell.
- **Desktop:** top navbar (public), left sidebar (app/partner/admin).
- **Entry point:** new visitor lands on `/` → search or category tap works **without login**; auth is demanded only at the first high-intent action (RFQ submit, Buy Now, save provider) — "browse first, register at intent," like food apps.

## 3.3 Auth flows

**MSME signup:** Phone → OTP → name + business name → (optional, skippable) Udyam/GST, sector, state, language → land on `/app` with a contextual nudge to complete profile (profile-completeness meter; certain actions like RFQ require state + sector).

**Provider signup:** Phone+email → OTP → business type & categories → **KYC wizard** (legal name, GSTIN [API-verified live], credentials upload per category — e.g., ICAI no. for Tax, Bar Council for Legal — address, bank account [penny-drop verified]) → "Under review" state (browse-only) → admin approves → listings go live. Target: <24h verification SLA.

**Session:** Supabase JWT, 7-day refresh; role claim (`msme | provider | admin | ops`) drives route-group middleware guards. A user CAN hold both msme & provider roles (one account, role switcher in profile).

## 3.4 Core Journey 1 — Browse → Buy Now (the Swiggy flow)

1. Ramesh opens `/`, taps **Tax & Accounting** → `/services/tax-accounting`.
2. Filter chips: *State: AP · Language: Telugu · Sort: Rating*. Listing cards show: provider name + verified badge, rating (count), package title, **price with strikethrough discount**, delivery days.
3. Taps a card → `/p/sharma-associates`: credentials, badges (✓ GSTIN verified, ✓ ICAI member), 3 packages, 47 reviews, "responds in ~2h".
4. Taps package → scope checklist, deliverables, FAQs, requirements-from-buyer list → **Buy Now**.
5. Auth wall (if logged out) → OTP → returns to checkout with state preserved.
6. Checkout: package summary, coupon field, GST invoice details toggle, total incl. GST → Razorpay sheet (UPI default).
7. Payment success (webhook-confirmed) → order created in `placed` → provider notified (push+WhatsApp) → buyer sees order workspace with a "share requirements" form (per-package requirement template).
8. Provider accepts (<24h SLA, else auto-cancel & refund) → milestones progress → provider marks **delivered** with attachments → buyer **accepts** (or auto-accept after 72h with reminders) → payout scheduled (T+2) → review prompt.

## 3.5 Core Journey 2 — RFQ → Quotes → Order

1. Need is non-standard → `/app/rfq/new`: pick category → category-specific dynamic form (from `rfq_templates`) + free text + attachments + budget range (optional) + deadline.
2. Submit → matching fan-out job: providers matching category + state(s) + verified + capacity get notified. RFQ visible in their `/partner/rfqs` for 72h.
3. Providers submit quotes: price, scope, timeline, message. Buyer notified per quote; max 7 quotes shown, then RFQ auto-closes to new quotes. *(S0.4: the cap is config — `agent_settings.rfq_max_quotes`, 3–7; unset = legacy 7. Matched providers quote OR decline with a reason; matches silent past `quote_window_hours` (default 48) are auto-declined by the rfq-expire cron and the buyer is told how many could not take it up.)*
4. Buyer compares quotes on one screen (sortable table: price / timeline / rating) → can chat-clarify within the quote thread (contact-info masked pre-payment, see §9) → **Accept quote** → checkout (same rail as Buy Now) → quote converts to order; other quotes auto-declined politely.
5. Expiry handling: no quotes in 72h → suggest top providers to contact directly + option to rebroadcast with edits.

*S1.2 — comparability + buyer decline.* Step 4's compare screen shows a side-by-side table with a **normalised total** per quote (GST added only when the quote says it is excluded; silence is flagged, never assumed; transport is a flag, never a rate) and twelve deterministic **comparability flags** computed in `@amclub/shared` `compareQuotes` at read time — never a model. The buyer may **decline** a quote with a reason (`POST /api/v1/rfq/[id]/quote/[quoteId]/decline`, the first buyer-initiated `quotes.status` write, guarded on `submitted` and governed by the one `QUOTE_TRANSITIONS` map); the provider receives a courteous two-line message in their own language (a fixed template, or the `decline_message` agent's text when that agent is on for the buyer). Optional per-quote **pointers** in the buyer's language (the `compare_pointers` agent) only restate the flags and can never rank or recommend (strict schema + a banned-phrase gate). Auto-declines on accept keep the existing bulk notification.

*S1.3 — clarification threads + quote revision (spine work; no model, no agent flag).* Between steps 3 and 4 a matched provider may **ask a clarification** on an active RFQ (`rfq_clarifications`, RFQ-level, ≤ 3 open per provider; a provider who already quoted may still ask) and the buyer **answers once**; every question and answer is visible to **every matched provider** (fairness, no duplicate questions) and no provider learns who asked. Both free-text fields cross parties, so they are contact-masked before storage (§9.3) with a `*_redacted` flag. **"In clarification" is derived** — an active RFQ with an unanswered question — never an RFQ status: the 72-hour window and the expiry cron are untouched, and a closed RFQ takes no answers (the rescue UI re-broadcasts). A provider may **revise** their own `submitted` quote in place (`PATCH /api/v1/rfq/[id]/quote`, every field restated, at most three submissions, optimistic-locked on `quotes.revision`); it is not a status change, the buyer sees a "rev N" chip and the before/after history from `quote_events.revised`, and POST and PATCH share one terms/price path (`lib/rfq/quote-terms.ts`). Three tools (`ask_clarification`, `answer_clarification`, `revise_quote`) are registered `confirm: true` for later agents.

*S1.5 — RFQ Quality agent (two-phase create, dark behind `agents_enabled.rfq_quality` + cohort).* Step 2 becomes two-phase for an enabled buyer's **services** RFQ: the request is inserted with `fanout_at NULL`, a deterministic **precheck** (shared `rfqQualityPrecheck`: missing required template fields, generic gaps quantity/location/timeline/budget/specs, risk flags incl. contact info) runs, and ONE bounded model call judges specificity and writes at most three questions in the buyer's locale; the server **merges under the union rule** (every rule gap stays, the model can only add). Nothing to ask ⇒ released at once (`quality_decision='skipped'`). Otherwise the buyer sees "Before we send this" and either **answers** (contact-masked into `details`) or **sends as is**; each is ONE `ai_decisions` row (feature `rfq_quality`, tool `check_rfq_quality`). **Deferred is derived, never a status** — `status='open'` with `fanout_at IS NULL`; nobody is matched, so no provider sees it; the 72-hour clock and the quote-window sweep are untouched and do not pause. A cron guard in `rfq-expire` releases anything older than `agent_settings.rfq_quality_hold_minutes` (default 30) as is; any model failure or budget breach yields rule-only questions or an inline fan-out. `releaseDeferredRfq` is the single release path, guarded on `fanout_at IS NULL`, so the buyer and the cron racing produce exactly one fan-out. Goods RFQs stay single phase. Migration 0035 backfills `fanout_at` for every existing row.

*S2.4 — reliability-adjusted ordering (dark; ADR-010).* Step 4's compare screen may order quotes by **price adjusted for each provider's AMC Score** — only with `reliability_rank_enabled`, at least two quotes, and the largest normalised total at or above `reliability_rank_threshold_paise` (₹25,000); services only. The server computes `total × (1 000 000 + k × (100 − s)) ÷ 1 000 000` (k = `reliability_rank_k_bps`, the penalty at a score of 0; a provider below the sample gate ranks as the neutral `score_null_prior`) and returns only `ordering: { mode, ids }`. The buyer never sees a score, a component or a per-provider label: the screen shows one fixed line, "Ordered by price, adjusted for each provider's delivery and dispute record on AMClub. Sort by price instead", and the price sort is one tap away. Prices shown are unchanged. Below the threshold, with the switch off or with one quote, the order is byte-identical to the price sort. The switch stays off until the founder confirms ADR-010 §9 (e).

## 3.6 Core Journey 3 — Provider lists a package

`/partner/listings/new`: category/subcategory → title (with i18n hint) → scope builder (included items checklist, excluded items) → deliverables → buyer-requirements template → price (₹) + optional discount % + AMC-member extra discount → delivery days → revision count → FAQs → preview → publish (live instantly if provider verified; flagged sample audited by ops).

## 3.7 Order state machine (canonical)

**Disputes — party statements and the triage card (S1.7).** While an order is `disputed` and the dispute is open, each party may file ONE statement (`dispute_statements`, ≤ 2000 chars, contact-masked, up to five of the order's own documents), editable until a triage exists; both parties and ops read both. A runtime agent (ops persona) reads the order evidence and the dispute detail under the founder's delegated token and writes a **triage card** (`dispute_triages`): neutral timeline, each party's claims with evidence refs, gaps, a recommended resolution CLASS (never an amount; partial refunds as a percent band) with confidence. The card sits above the resolve controls and never pre-selects one; the founder's click on the existing resolve route is the decision, linked to `ai_decisions` after settlement. The order state machine and `resolveDispute` are unchanged.

```
placed → accepted → requirements_submitted → in_progress
      ↘ (24h no accept) auto_cancelled → refunded
in_progress → delivered → completed (buyer accepts or 72h auto)
in_progress → delivered → revision_requested → in_progress  (max N revisions per package)
any-pre-completed → disputed → {resolved_refund | resolved_release | resolved_partial}
completed → disputed  (only within dispute_window_days of completion — ADR-014)
placed|accepted → cancelled_by_buyer (policy-based refund %)
placed → cancelled_duplicate → refunded  (a second paid order on one RFQ — ADR-014 §7)
completed → reviewed
```
Payout to provider releases ONLY from `completed` or `resolved_release/partial`.

**Dispute reachability and window (ADR-014 §6).** "Any-pre-completed" means every status after the provider accepts: `accepted`, `requirements_submitted`, `in_progress`, `delivered`, `revision_requested` (not `placed`, where the buyer cancels with a full refund). After completion a dispute is accepted only until `completed_at + agent_settings.dispute_window_days` (default 7). The order page shows the buyer that deadline and hides the action once it passes. Goods returns keep their own Mart category window.

**External/government-wait sub-state (display only — not a new enum):** while an order is `in_progress`, work may block on a government portal/registrar/bank — time outside the provider's control. This is modelled as a marker on the order (`external_wait_since timestamptz NULL` + an `external_wait` / `external_resume` timeline event), **not** a new status in the canonical machine above. While the marker is set the timeline shows **"Pending Government Portal Processing"** (External time), and the delivery-SLA / 72h auto-accept clock **pauses**. Canonical transitions and the payout-release set are unchanged (§8.4-safe).

**Services evidence engine (S0.3 — events + a release gate, not new transitions):** a services order records staged milestones with photo proof — `accepted → site_or_materials → in_progress → work_complete` — as `order_milestones` rows (`kind` + `photo_doc_id`) plus a `milestone_added` timeline event. `work_complete` performs the existing `in_progress → delivered` transition (arming the 72h auto-accept); buyer confirmation stays the existing `delivered → completed` accept. **No new enum, no repurposed transition (§8.4-safe).** The payout release gate gains a services branch mirroring the goods gate (`evaluateServicesReleaseGate` in `@amclub/shared`): an order placed on/after the `agent_settings.evidence_required_from` cutover is held until a work-complete photo + buyer confirmation exist and no dispute is open. `null` cutover = not enforced (byte-identical to today). The payout-release set (`completed` / `resolved_release` / `resolved_partial`) is unchanged.

## 3.8 Empty, loading & error states (explicit)

- **Empty orders:** illustration + "Your orders will appear here" + CTA "Explore services".
- **Empty RFQ quotes (pending):** timeline showing "Sent to 12 providers · usually replies within 24h".
- **Empty search results:** "No providers yet for this in {state}" + CTA "Post a requirement instead" (RFQ funnel rescue) + relax-filters suggestion.
- **Payment failure:** order NOT created; sheet shows retry + support link; abandoned-checkout nudge after 1h (one only).
- **Offline (PWA):** cached shell + "You're offline" banner; the offline page only — no authenticated page or API data is cached on the device (shared-device privacy, USER_EXPECTATIONS_AUDIT P0-6), and sign-out purges caches.
- **Provider unverified:** dashboard shows verification checklist with per-item status, not a dead end.
- **Skeletons everywhere** listings/cards load; never spinner-on-white.
- **Clarification thread empty (S1.3):** "No questions yet" inside the card, with the "visible to all providers who received this request" hint; never a blank card.
- **Clarification cap reached (S1.3):** the ask box disables with "You have 3 open questions on this request — wait for an answer before asking another" (server 409 `clarification_cap` says the same).
- **RFQ closed — thread read-only (S1.3):** questions and answers stay visible; the ask/answer boxes are replaced by "This request is closed — the thread is read-only" (server 409 `rfq_closed`).
- **Answer race (S1.3):** a second answer to the same question gets 409 `already_answered`; the UI shows "This question was just answered — refreshing" and reloads the thread.
- **Quality check, model unavailable (S1.5):** the rule-only questions still show, with "Our checker is unavailable right now, so these are the standard questions for this category" (`quality_meta.model_used=false`); a create never fails on the model.
- **Quality deadline passed while the card is open (S1.5):** answer / send-as-is get 409 `already_sent` (the cron guard released it); the UI says "This request was already sent — refreshing" and goes to the RFQ page.
- **Quality check, zero questions (S1.5):** never shown — the RFQ is released inline (`skipped`) and the create redirects exactly as before.
- **Deferred RFQ in the list (S1.5):** badge "Answer N questions to send"; the detail page shows the questions card instead of the (empty) compare table.
- **Help chat empty (S2.3):** "Ask me anything about your orders, requests, payments or payouts." plus quick chips (refund, payout timing, fees, talk to a person); never a blank pane.
- **Help chat, not understood (S2.3):** the `unclear` template asks the user to name the order or pick a chip; a second miss (`support_escalate_after_turns`) opens a ticket instead of looping.
- **Help chat escalated (S2.3):** a banner "A person is looking at this (T-…)" + "We acknowledge within 24 hours. Anything you write here is added to the ticket." (the SLA from `lib/legal/grievance.ts`); the escalated reply carries the ticket ref, the SLA (24 hours / 15 days) and the human contact line; further messages are kept for the person and answered with the same template — no automated answers until the ticket is resolved.
- **Help chat, classifier unavailable (S2.3):** treated as a not-understood turn (never a guessed answer); the numbers in any reply come only from the user's own data.
- **Nudge already sent (S2.3):** the Nudge button toasts "A reminder was already sent in the last {hours} hours." with `{hours}` = the configured `support_nudge_cooldown_hours` returned by the 429 (`cooldown_hours`); a plain rate-limit 429 says "A reminder was already sent recently."; a failed nudge toasts "Could not send the reminder" — never a false "sent".

## 3.9 Redirect map

login→ role home (`/app` | `/partner` | `/admin`) · logout→ `/` · pay-success→ `/app/orders/[id]?first=1` (confetti once) · provider-approval→ WhatsApp deep link to `/partner/listings/new` · expired session at action→ OTP modal preserving in-flight state (never lose a half-written RFQ).

---

# §4 — UI/UX DESIGN BRIEF

## 4.1 Aesthetic direction

**"Confident utility for Bharat business."** Not startup-pastel, not sarkari-portal. The reference feeling: Zomato's scannability + Paytm-for-Business' density + the trust cues of a bank. Light-mode primary (sunlit-shop usage), generous tap targets, information-dense cards that still breathe. The design must feel **trustworthy at first glance** because we're asking strangers for ₹7,000 — verification badges, real numbers, and review counts are the decoration; avoid abstract illustrations of "synergy."

## 4.2 Tokens

**The palette is LOCKED.** Green `#1B4D3E` is the primary brand colour — **final, never switch to blue/navy.** Tokens are named by *meaning*, and every colour has exactly one job. Hardcoded hex and raw Tailwind palette colours (`gray-*`, `amber-*`, …) are prohibited in components — use the semantic tokens below so a future polish pass is a token change, not a file sweep.

| Semantic token | Value | Job — and ONLY this job |
|-------|-------|-----|
| `primary` | `#1B4D3E` (deep enterprise green) | Brand: CTAs, active nav. **FINAL.** |
| `success` | `#1E8E5A` | Positive/completed states (green family, sibling of brand) |
| `verified` (alias `trust`) | `#1A6FBF` (verification blue) | **Verification badges/ticks ONLY — never decorative, never brand** |
| `destructive` (alias `danger`) | `#C73E3E` | **Destructive actions + hard errors ONLY — never decorative/branding** |
| `accent` | `#F4A300` (marigold) | **Discounts + rating stars ONLY** |
| `warning` | `#B45309` on `warning/10` | Caution/pending states (e.g. "under review", external waits). Distinct from `accent`. |
| `background` / `surface` | `#FAFAF7` / `#FFFFFF` | App background / cards |
| `foreground` / `foreground-secondary` | `#1A1D1A` / `#5C645C` | Primary text / **de-emphasis (muted gray) + disabled** |
| `border` | `#E6E7E3` | All card/divider borders (replaces raw `gray-*` borders) |
| `muted` | `#F3F4F1` | Muted surfaces, skeletons, chip backgrounds (replaces raw `gray-*` fills) |

**Colour discipline (enforced):** green = brand + success/verified-positive; marigold = discounts/ratings only; **red = destructive/warnings only (never decoration or branding)**; blue = verification badges only; gray = secondary text + disabled. If a colour's job isn't in this table, it doesn't ship.

| Non-colour token | Value |
|-------|-------|
| Radius | 12px cards (`rounded-card`), 10px buttons (`rounded-button`), 999px chips (`rounded-chip`) |
| Shadow | `0 1px 3px rgb(0 0 0 / .08)` cards; **one level only** |
| Spacing | Generous/institutional: page gutters `px-4` mobile, content `max-w-*` centred, vertical rhythm `py-6`–`py-8`, card padding `p-4`–`p-5`, list gaps `gap-3`. Standardised via a shared `<PageContainer>` — not cramped. |
| Type | **Display:** Bricolage Grotesque (headings, price numerals) · **Body/UI:** Inter · **Devanagari:** Noto Sans Devanagari (same optical size) |
| Scale | 13/15/17/20/24/30; body 15px mobile |

**Signature element:** the **price block** — large tabular numeral, strikethrough original, marigold discount pill ("20% off · AMC member −5% more"), and delivery-days chip — repeated identically on every card and detail page. It is the product's thesis (price transparency) rendered as a component. *(V1 pricing model: professional fee only; split professional/govt-fee display is a logged future enhancement, not built in V1.)*

**CTA copy convention (LOCKED — applies to Phases 5–7):** buttons use action-oriented verbs only — "Get quotes", "Pay securely", "Accept draft", "Send requirements". **Never** "Submit", "OK", or "Click here". One verb, sentence case.

## 4.3 Key patterns

- **Provider card — CREDENTIAL-FIRST (LOCKED):** the card *leads* with professional credential + verification, because MSMEs hire on trust, not slogans. Order: logo/initials avatar → **provider name + headline credential + verified tick** (e.g. "CA R. Sharma · ICAI-verified", or "Sharma & Associates · ICAI #12345 · ✓"), → package title → price block → delivery/state/response chips. **Rating is secondary** (smaller, below the credential line) — never the headline. The headline credential is the highest-priority *professional* verification (ICAI/ICSI/Bar Council/CA/credential); KYC items (GSTIN/PAN/bank) stay as detail-page badges, and their raw numbers are never surfaced on cards.
- **Jurisdiction/state selector — FIRST-CLASS (LOCKED):** compliance is local, so state/jurisdiction is a **prominent header-level selector** (in the app shell, from screen one), *not* a buried filter. It seeds and persists the `state` filter across browse/search; the in-filter state control remains as a secondary refine. Persisted per user like locale.
- **Comparison view:** RFQ quotes render as a swipeable card stack on mobile, sortable table on desktop.
- **Order timeline — PROVIDER TIME vs GOVERNMENT/EXTERNAL TIME (LOCKED):** vertical stepper with timestamps; current step pulses subtly. The timeline visually **distinguishes time the provider controls from time spent waiting on an external party** (government portal, registrar, bank). When work is blocked on a government/statutory process, the order surfaces a display sub-status **"Pending Government Portal Processing"** (muted/`warning`, grouped as *External time*) so the buyer sees the delay is outside the provider's control, and the provider isn't unfairly penalised. Implementation note: this is a **display sub-state on `in_progress`** (an `external_wait_since` marker + timeline event), **not** a new enum in the order state machine — the canonical §3.7 transitions and payout-release set are untouched (§8.4). The delivery SLA / 72h auto-accept clock **pauses** while external-wait is active.
- **Badges are earned, never decorative:** ✓ GSTIN · ✓ Credential (ICAI/Bar) · ✓ Bank verified · ⭐ Top Rated (algorithmic: ≥4.5 over ≥20 orders). Sponsored placement always labelled "Promoted". **Verification is API + admin-queue driven (§5/§9) — never a manual `is_verified` boolean.**
- **In-order communication stays masked/in-app (LOCKED, anti-disintermediation §9.3):** order messaging is the masked in-app thread. **Never** expose a WhatsApp link, phone number, or email for direct off-platform contact inside an order — that enables disintermediation and breaks the escrow/trust loop.
- **Forms:** one question-group per screen on mobile (wizard), inline validation, save-as-draft on RFQ.

## 4.4 Localisation & accessibility

- Language switcher in top bar from screen one; locale persisted per user; **strings never concatenated** (ICU plurals/genders), numerals localised (₹ format `₹6,999`), dates in IST `12 Jun 2026`.
- Layout must tolerate +40% string length (Hindi) — no fixed-width buttons.
- WCAG 2.1 AA: 4.5:1 contrast (the green/marigold pair is pre-checked), visible focus rings, 44px tap targets, full keyboard nav on desktop, `prefers-reduced-motion` respected, alt text on provider logos, form errors announced via aria-live.
- Performance budget: LCP <2.5s on Moto-G-class 4G; images via next/image AVIF/WebP; category pages ISR-cached.

## 4.5 Voice & microcopy

Plain verbs, sentence case, no jargon: "Get quotes", "Pay securely — released after delivery", "Sharma Associates accepted your order". Errors say what happened and the fix: "Payment didn't go through. No money was deducted — try UPI again." Hindi copy written natively, not machine-translated, reviewed by a native speaker before each release.

---

# §5 — BACKEND SCHEMA: DATA MODEL & AUTH ARCHITECTURE

All money columns are `bigint` paise. All tables have `id uuid pk default gen_random_uuid()`, `created_at timestamptz default now()`, `updated_at timestamptz` (trigger-maintained). User-content tables add `deleted_at timestamptz` (soft delete).

## 5.1 Identity & profiles

```sql
-- users: thin wrapper over supabase auth.users
users (
  id uuid pk references auth.users,
  phone text unique not null,
  email text unique,
  full_name text,
  preferred_locale text default 'en',          -- 'en' | 'hi' | ...
  roles text[] default '{msme}',               -- {'msme','provider','admin','ops'} — one account, many hats
  last_seen_at timestamptz
)

msme_profiles (
  id uuid pk, user_id uuid fk users unique,
  business_name text not null,
  udyam_number text, gstin text,               -- both optional; verified flags below
  udyam_verified bool default false, gstin_verified bool default false,
  sector text,                                  -- manufacturing|trade|services
  state text not null, city text, pincode text,
  employee_band text,                           -- '1-9','10-49','50-249'
  membership_tier text default 'free',          -- 'free'|'pro'|'premium' (V1: free only, column ready)
  profile_completeness int default 0
)

provider_profiles (
  id uuid pk, user_id uuid fk users unique,
  legal_name text not null, display_name text not null,
  slug text unique not null,                    -- /p/[slug], SEO
  about text, logo_url text,
  gstin text, pan text,
  state text not null, city text, languages text[] default '{en}',
  status text default 'pending_kyc',            -- pending_kyc|under_review|active|suspended|rejected
  avg_rating numeric(2,1) default 0, review_count int default 0,   -- denormalised, trigger-updated
  completed_orders int default 0,
  median_response_minutes int,                  -- computed nightly
  capacity_paused bool default false,
  top_rated bool default false                  -- nightly job
)

provider_verifications (
  id uuid pk, provider_id uuid fk provider_profiles,
  kind text not null,        -- 'gstin'|'pan'|'bank'|'icai'|'icsi'|'bar_council'|'msme_cert'|...
  value text not null,       -- the number/identifier
  document_url text,         -- uploaded proof in storage
  status text default 'pending',  -- pending|api_verified|manually_approved|rejected
  verified_by uuid fk users, verified_at timestamptz, rejection_reason text,
  api_response jsonb         -- raw KYC-API payload for audit
)

provider_bank_accounts (
  id uuid pk, provider_id uuid fk unique,
  account_number_enc text not null,             -- encrypted (pgcrypto) — sensitive
  ifsc text not null, account_holder text not null,
  penny_drop_verified bool default false,
  razorpay_route_account_id text                -- Razorpay Route linked account
)
```

## 5.2 Catalog

```sql
categories (
  id uuid pk, parent_id uuid fk categories null,      -- 2-level tree
  slug text unique, name_i18n jsonb not null,         -- {"en":"Tax & Accounting","hi":"कर एवं लेखा"}
  description_i18n jsonb, icon text,
  commission_bps int not null default 1000,           -- 10.00% in basis points
  required_credentials text[] default '{}',           -- e.g. {'icai'} gates listing in this category
  rfq_template jsonb,                                 -- dynamic form schema (field defs) for RFQs
  sort_order int, is_active bool default true
)

provider_categories (provider_id fk, category_id fk, primary key(provider_id, category_id))

packages (                                            -- a fixed-price listing
  id uuid pk, provider_id uuid fk, category_id uuid fk,
  slug text, title_i18n jsonb not null,
  scope_included jsonb not null,                      -- ["GST application filing","ARN tracking",...]
  scope_excluded jsonb,
  deliverables jsonb not null,
  requirements_template jsonb,                        -- what buyer must submit after purchase
  price_paise bigint not null check (price_paise > 0),
  discount_bps int default 0,                         -- strikethrough discount
  member_extra_discount_bps int default 0,
  delivery_days int not null, revision_count int default 1,
  faqs jsonb, status text default 'active',           -- draft|active|paused|removed
  search_tsv tsvector                                 -- generated, GIN-indexed
)
create index on packages using gin(search_tsv);
create index on packages (category_id, status);
unique (provider_id, slug)
```

## 5.3 RFQ & quotes

```sql
rfqs (
  id uuid pk, msme_id uuid fk msme_profiles,
  category_id uuid fk, title text not null,
  details jsonb not null,                 -- answers to category rfq_template + free text
  attachments jsonb default '[]',
  budget_min_paise bigint, budget_max_paise bigint,
  needed_by date,
  status text default 'open',             -- open|quoted|accepted|expired|cancelled
  expires_at timestamptz not null,        -- now() + 72h
  max_quotes int default 7, quote_count int default 0
)

rfq_matches (                              -- fan-out: which providers were invited
  rfq_id fk, provider_id fk, notified_at timestamptz, viewed_at timestamptz,
  primary key (rfq_id, provider_id)
)

quotes (
  id uuid pk, rfq_id uuid fk, provider_id uuid fk,
  price_paise bigint not null, delivery_days int not null,
  scope text not null, message text,
  status text default 'submitted',         -- submitted|withdrawn|accepted|declined|expired
  unique (rfq_id, provider_id)             -- one quote per provider per RFQ
)
```

## 5.4 Orders, payments, payouts

```sql
orders (
  id uuid pk, order_number text unique,             -- human-friendly AMC-2026-000123
  msme_id uuid fk, provider_id uuid fk,
  source text not null,                              -- 'package'|'quote'
  package_id uuid fk null, quote_id uuid fk null,
  title text not null, scope_snapshot jsonb not null, -- IMMUTABLE copy at purchase time
  price_paise bigint not null, discount_paise bigint default 0,
  gst_paise bigint not null, total_paise bigint not null,
  commission_bps int not null,                       -- frozen at order time
  commission_paise bigint not null, provider_earning_paise bigint not null,
  delivery_days int not null, due_at timestamptz,
  status text not null default 'placed',             -- §3.7 state machine
  revision_used int default 0, revision_max int,
  cancelled_reason text, completed_at timestamptz, auto_accept_at timestamptz
)
create index on orders (msme_id, status); create index on orders (provider_id, status);

order_events (                                        -- append-only audit timeline
  id uuid pk, order_id uuid fk, actor_id uuid fk users null,
  event text not null,                                -- 'placed','accepted','milestone_added',...
  payload jsonb, created_at timestamptz default now()
)

order_milestones (
  id uuid pk, order_id uuid fk, title text, status text default 'pending', completed_at timestamptz, sort int
)

order_documents (
  id uuid pk, order_id uuid fk, uploaded_by uuid fk users,
  file_url text, file_name text, mime text, size_bytes int, kind text  -- 'requirement'|'deliverable'|'other'
)

payments (
  id uuid pk, order_id uuid fk,
  razorpay_order_id text unique, razorpay_payment_id text unique,
  amount_paise bigint, method text, status text,       -- created|authorized|captured|refunded|failed
  webhook_payload jsonb, idempotency_key text unique
)

refunds (id, payment_id fk, amount_paise, reason, razorpay_refund_id, status)

payouts (
  id uuid pk, provider_id uuid fk, order_id uuid fk unique,
  amount_paise bigint, status text default 'scheduled',  -- scheduled|processing|paid|failed|held
  scheduled_for date,                                     -- completion + T+2
  razorpay_transfer_id text, paid_at timestamptz
)

disputes (
  id uuid pk, order_id uuid fk unique, raised_by uuid fk users,
  reason text, details text, status text default 'open',  -- open|under_review|resolved
  resolution text,                                          -- refund_full|refund_partial|release
  resolution_amount_paise bigint, resolved_by uuid fk users, resolved_at timestamptz
)
```

## 5.5 Reviews, messaging, engagement

```sql
reviews (
  id uuid pk, order_id uuid fk unique,                -- verified purchase: one review per order
  msme_id fk, provider_id fk,
  rating int check (rating between 1 and 5),
  text text, provider_reply text,
  status text default 'published'                     -- published|flagged|removed
)

conversations (id uuid pk, context_type text, context_id uuid,  -- 'order'|'quote'
               msme_id fk, provider_id fk, unique(context_type, context_id))
messages (id, conversation_id fk, sender_id fk users, body text, attachments jsonb,
          redacted bool default false,                -- contact-info masking flag (§9.4)
          read_at timestamptz)

saved_providers (msme_id fk, provider_id fk, pk(msme_id, provider_id))

notifications (id, user_id fk, kind text, title_i18n jsonb, body_i18n jsonb,
               link text, channels text[], read_at timestamptz)

coupons (id, code unique, kind text, value_bps int, max_discount_paise bigint,
         category_id fk null, valid_from, valid_to, usage_limit int, used_count int, is_active bool)
coupon_redemptions (coupon_id fk, order_id fk, msme_id fk)

invoices (id, order_id fk, number text unique, kind text,   -- 'buyer_invoice'|'commission_invoice'
          pdf_url text, gstin_snapshot jsonb, totals jsonb)

audit_logs (id, actor_id, action, entity, entity_id, before jsonb, after jsonb, ip inet)
cms_banners (id, slot text, image_url, link, locale, starts_at, ends_at, is_active)
```

## 5.6 Relationships summary

users 1—1 msme_profiles · users 1—1 provider_profiles · provider 1—N packages/quotes/orders/payouts · msme 1—N rfqs/orders/reviews · rfq 1—N quotes (≤7) · quote 1—0..1 order · order 1—N events/milestones/documents, 1—1 payment/review/payout/dispute · categories self-referencing tree.

## 5.7 Auth model & Row-Level Security (Supabase)

- JWT carries `roles[]`. Helper SQL: `auth_user_id()`, `has_role(r)`.
- **msme_profiles / provider_profiles:** owner read-write own row; public read of `provider_profiles` limited to `status='active'` via a **public view** exposing only safe columns (no PAN/GSTIN/bank).
- **packages:** public read where `status='active'` and provider active; provider CRUD own.
- **rfqs:** owner full; providers read only rows joined through `rfq_matches` for their id while `status='open'`.
- **quotes:** provider CRUD own; msme read quotes on own rfqs.
- **orders & children:** read-write only where `msme_id = me` or `provider_id = me`, column-level: provider cannot see buyer phone until order accepted (enforced via view).
- **payments/payouts/disputes/audit:** service-role + admin only; users read-only their own via views.
- **reviews:** insert only by order's msme where `orders.status='completed'` and no existing review (enforced by unique + RLS predicate).
- **admin/ops:** `has_role('admin')` bypass policies, every admin mutation writes `audit_logs`.
- **Storage buckets:** `logos` (public), `credentials` (admin+owner), `order-docs/{order_id}/...` (order parties only via signed URLs, 15-min expiry).

## 5.8 API surface (route handlers, `/api/v1`)

`POST /auth/otp/send|verify` · `GET /catalog/categories` · `GET /catalog/search?q&category&state&min_price&max_price&rating&sort&page` · `GET /providers/[slug]` · `POST /rfqs` · `GET /rfqs/[id]/quotes` · `POST /quotes` · `POST /quotes/[id]/accept` · `POST /checkout` (creates razorpay order) · `POST /webhooks/razorpay` (signature-verified; the ONLY payment truth) · `POST /orders/[id]/transition` (state machine, role-checked) · `POST /orders/[id]/documents` · `POST /reviews` · provider: `POST/PATCH /packages` · admin: `/admin/verifications/[id]/approve` etc.
Conventions: cursor pagination, `Idempotency-Key` honoured on all POSTs that create money-adjacent rows, Zod-validated, rate-limited (Upstash) on auth & search.

## 5.9 Background jobs (pg-boss)

`rfq.fanout` (match & notify) · `rfq.expire` (72h) · `order.auto_cancel_unaccepted` (24h) · `order.auto_accept_delivered` (72h, with 24/48h reminders) · `payout.schedule_and_transfer` (daily batch via Razorpay Route) · `provider.stats_nightly` (rating, response time, top-rated) · `notification.dispatch` (channel fan-out with per-channel retry) · `invoice.generate_pdf`.

---

# §6 — IMPLEMENTATION PLAN

Each phase has explicit **done-criteria**. Do not start a phase until the previous one's criteria pass. Estimated total to public V1: **14–18 weeks** with a 3–4 person team (or one founder + AI agents moving fast).

### Phase 0 — Foundations (Week 1)
Repo (Turborepo), Next.js 15 + TS strict + Tailwind + shadcn, Supabase project (ap-south-1), Drizzle setup, env validation, Sentry + PostHog wired, CI (lint, typecheck, build, drizzle-check), preview deployments, `packages/shared` with order/RFQ state machines and category constants, next-intl scaffold with `en.json`/`hi.json`.
**Done:** empty app deploys to Vercel; a sample migration runs; a test event appears in PostHog; locale switch works on a hello-world page.

### Phase 1 — Database & RLS (Week 2)
All §5 tables as Drizzle migrations; RLS policies + helper functions; public provider view; storage buckets + policies; seed script (8 categories with i18n + rfq_templates, 20 fake providers, 60 packages, 10 MSMEs).
**Done:** RLS test suite passes (msme can't read another's order; unverified provider invisible publicly; anonymous can read active packages only). Seeded data visible via SQL.

### Phase 2 — Auth & profiles (Week 3)
Phone OTP via MSG91 hook, signup wizards (MSME quick, Provider KYC multi-step with draft persistence), role middleware for route groups, profile pages, language preference, KYC API integration (GSTIN + penny drop) with admin verification queue (A1).
**Done:** end-to-end: new provider signs up → uploads credential → admin approves in `/admin/verifications` → status `active`. Both roles land on correct homes.

### Phase 3 — Catalog & discovery (Weeks 4–5)
Landing page, category pages (ISR), search API (Postgres FTS + filters + sort), provider public profile, package detail, provider listing CRUD (`/partner/listings`), saved providers, SEO (metadata, OG, sitemap, schema.org `LocalBusiness`/`Service` JSON-LD).
**Done:** Lighthouse ≥90 perf/SEO on category page over 4G throttle; search returns correct filtered results in <300ms p95 against seed data; provider can publish a package that appears publicly in <5s.

### Phase 4 — Payments & Buy-Now orders (Weeks 6–8) ← the riskiest phase; allow slack
Razorpay PG + Route onboarding (KYC links bank accounts to Route), checkout flow, webhook handler (signature verify, idempotent), order creation, GST math, order workspace (timeline from `order_events`, milestones, document exchange via signed URLs, conversation thread), state-machine transitions with role checks, auto-cancel/auto-accept jobs, refunds, invoice PDF job, payout batch job (test mode).
**Done:** full money loop in Razorpay test mode: buy → webhook creates order → provider accepts → delivers → buyer accepts → payout transfer object created → buyer invoice + commission invoice PDFs render. Kill-test: replayed webhook does NOT double-create; dropped webhook recovered by reconciliation cron.

### Phase 5 — RFQ engine (Weeks 9–10)
RFQ creation (dynamic forms from `rfq_templates`), fan-out matching job, provider RFQ inbox + quote composer, buyer quote-comparison screen, quote accept → checkout (reuses Phase 4 rail), expiry job, masked messaging on quote threads.
**Done:** RFQ posted in Tax/AP reaches only matching active providers; 7-quote cap enforced; accepting a quote produces a paid order identical in shape to a package order; contact-info regex masks phone/email in pre-payment messages.

### Phase 6 — Reviews, notifications, engagement (Week 11)
Post-completion review prompt + provider reply + moderation queue; notification dispatcher (in-app + SMS + WhatsApp templates + email) for the 12 canonical events (order placed/accepted/delivered, quote received, payout paid, etc.); coupons engine; CMS banners.
**Done:** completing a test order triggers review prompt; review updates denormalised rating; WhatsApp template messages delivered for order-accepted in sandbox; coupon applies correct discount and respects limits.

### Phase 7 — Admin & ops (Week 12)
KPI dashboard (GMV, take rate, funnel from PostHog API), provider/MSME management, dispute console with resolution actions (refund/release/partial wired to Razorpay), review moderation, payout monitor, category & commission editor, audit-log viewer.
**Done:** ops can resolve a seeded dispute end-to-end with money moving correctly in test mode; commission change affects only NEW orders.

### Phase 8 — Polish, PWA, hardening (Weeks 13–14)
Empty/error/loading states per §3.8, PWA manifest + offline shell, responsive audit, accessibility audit (axe + manual keyboard pass), Hindi copy review by native speaker, rate limiting, OWASP pass (authz on every route, SSRF on file URLs, upload type/size validation), load test (k6: 500 concurrent searches, 50 concurrent checkouts), backup/restore drill, runbook docs.
**Done:** axe zero criticals; k6 p95 <800ms; restore-from-backup rehearsed; security checklist signed off.

### Phase 8a — Gateway `/` (added 2026-07 via §8.1; design handoff `design_handoff_amclub_design_system/AMClub Gateway - *.html`)
**Mini-PRD.** Problem: the landing page asks skeptical first-time Tier-2/3 visitors to self-navigate a full marketplace; drop-off happens before intent is captured. Solution: replace `/` for anonymous visitors with a two-door gateway (MSME buyer / service provider) followed by a 4-step skippable wizard that captures `{business type, need, size band, state}` (buyer) or `{category, credential, experience, state}` (provider), persists it as a local draft profile, pre-fills signup, and reveals a matched-results page (real category+state search) or partner application review. Choreographed single-card morph per the handoff spec (entrance sequence, cursor tilt, selection color-flood, card-morph steps, progress dots, reveal cascade), all motion behind `prefers-reduced-motion`.
**RICE.** Reach: 100% of new anonymous visitors. Impact: high (intent capture + prefilled signup on the primary funnel entry). Confidence: 0.7 (pattern proven by consumer marketplaces; unproven for B2B Bharat). Effort: ~1 week. Score: high — approved by founder (scope authority) 2026-07-05.
**Constraints.** Logged-in users never see the gateway (role-redirect before first paint: admin/ops → `/admin/verifications`, provider profile → `/partner`, msme profile → `/app`). `/services/*` and `/p/*` remain the crawlable SEO surface; the gateway carries its own h1/meta. Locales en/hi/te/ta (te/ta strings shipped from the handoff bundle, **flagged for native review** per §4.4 before Phase 9). Trust copy must stay backable: provider counts from live search totals; quote expectations stated via the 7-quote cap, not invented response-time claims. Feature-flagged (`GATEWAY_ENABLED`); flag off serves the prior landing page unchanged.
**Done:** anonymous `/` renders gateway with full choreography on desktop + 390px mobile; wizard answers persist and pre-fill signup; results grid served by the real search API filtered by wizard answers; language chips switch locale in-place; Lighthouse ≥90 on `/` (4G, mobile); wizard funnel events live in PostHog (Appendix A).

### Phase 8b — Voice RFQ (added 2026-07 via §8.1)
**Mini-PRD.** Problem: typing a structured RFQ in English is the single highest-friction step for Tier-2/3 MSME owners — many can describe their need fluently in Telugu/Tamil/Hindi (often code-mixed) but stall at the form. Solution: a voice **input method** for the existing RFQ form. The owner speaks (≤60s); audio goes to `/api/v1/rfq/voice-parse` (authed, tightly rate-limited); the server transcribes-and-translates via Sarvam AI (`saaras:v3`, `mode=translate` — one call) behind a vendor interface in `lib/voice/` (stub logs "would transcribe" when `SARVAM_API_KEY` unset), then one temperature-0 OpenRouter LLM call maps the English text to `{category (8 slugs), specialization (curated vocabulary), state, description_english, original_language, uncertain}`. The client **never auto-submits**: the parse pre-fills the normal RFQ form, editable, under a "We heard … / We think you need …" banner. `uncertain=true` → nothing is guessed; the category is left for the user to choose. Submission goes through the unchanged `/api/v1/rfq` path; the transcript + parse JSON persist on the rfq row (`rfqs.voice_meta` jsonb) for quality review and future training signal.
**NOT-NOW guard.** This is speech→form-fill only. It does not advise, match, chat, or alter fan-out — the AI-matching/chatbot entry in the §8.3 register stays untouched.
**RICE.** Reach: every RFQ-creating MSME on web + Android. Impact: high (removes the top drop-off on the demand-side funnel). Confidence: 0.6 (STT quality on code-mixed field audio unproven). Effort: ~4 days. Score: high — approved by founder (scope authority) 2026-07-06.
**Constraints.** Paid APIs ⇒ auth required + dedicated limiter + server-side caps (≤30s declared duration — Sarvam's REST tier hard-rejects longer clips, verified 2026-07-08; the batch API is the upgrade path — ≤3MB audio). Audio format must be WAV/AAC/MP3-family: Sarvam rejects WebM (web records PCM→WAV via Web Audio) and M4A (mobile records AAC-ADTS on Android, LPCM WAV on iOS). Vendor calls server-only; keys never `NEXT_PUBLIC_`. Mic UX per platform: web MediaRecorder, mobile expo-audio (expo-av was removed in Expo SDK 55 — recorded deviation from the original ask). Gateway results screen shows the mic next to "Tell us what you need" but gates anonymous users to signup before any paid call. All failure modes (mic denied, transcription failed, uncertain parse) land the user on the manual form with a helpful message — never a dead end. Funnel events in Appendix A.
**Done:** spoken Telugu/Hindi requirement → editable pre-filled RFQ (category + state correct) → normal submission + fan-out; vague recording → `uncertain=true`, no guessed category; stub mode works keyless; rate limit + >60s rejection proven; `voice_meta` stored on the rfq row.

**v1.1 amendment (founder-ordered, 2026-07-06) — AI cost observability & audio retention.**
- **`ai_invocations`** (migration 0013): one append-only row per model call — `feature/step ('stt'|'parse')/vendor/status ('ok'|'error'|'stub')/latency_ms/cost_est_paise/input_bytes/output_chars/request_id/error/meta`. Written server-side via service role from `lib/voice/invocations.ts`; RLS enabled with **no policies** (never client-readable). Cost estimates are env-driven (`SARVAM_COST_PAISE_PER_MIN`; OpenRouter's returned `usage.cost` × `OPENROUTER_USD_INR_PAISE`, default ₹88/USD) with the raw vendor usage preserved in `meta` — so estimates can be recomputed exactly when pricing changes. Telemetry writes are best-effort and never block the user flow; error calls log too (that's when cost observability matters most).
- **Audio retention: none.** Raw audio is processed in memory (multipart → Sarvam → discarded); it is never written to Supabase Storage, disk, or logs. Only the English transcript + parse persist (`rfqs.voice_meta`). Mobile recordings exist transiently in the app's on-device cache (user's device, not our infrastructure). Consequently there is no server-side purge job to run; if audio retention is ever introduced (e.g. for STT quality audits), it requires a new mini-PRD here plus a 30-day purge job and explicit consent copy BEFORE the first byte is stored.
- **Consent:** the mic UI on both platforms shows, before recording, that the voice is sent to a transcription service to fill the form and that audio is not stored after processing (`voice.consent_note`, en/hi/te/ta — DPDP purpose-limitation line).

**v2 (S1.8, 2026-09-21; A1 pull-forward per §8.6) — one clarifying question + document / drawing intake, dark.**
- The parser is a registry prompt (`rfq_parse@v1` = the Phase 8b text; `@v2` for the prior round) through the
  bounded helper; behaviour preserved, `eval:golden` unchanged.
- ONE clarifying question when the parse is uncertain or a template-required field is missing (`needsClarification`,
  code): heard in the buyer's language (te / hi / ta / en), answered by voice or by typing, the merged parse prefills
  the form; a request carrying `prior` never gets another question. Optional TTS (`clarify_tts_enabled`).
- Document intake: a photo of a notice / invoice or a text PDF → one frontier call (`document_extract@v1`) returning
  facts (identity numbers masked to the last 4, contacts stripped); STEP / DXF drawings parsed deterministically
  (no model). Everything is prefill; the Create tap writes ONE `ai_decisions` row (feature `rfq_intake`).
- Spine: `rfq-attachments` bucket + `POST /api/v1/rfq/attachments`; detail pages list attachments (signed URLs).
- Schema: `rfq_intake_extractions` (0038). Flags: `agents_enabled.rfq_clarify`, `agents_enabled.document_intake`.

### Phase 9 — Pilot launch (Weeks 15–16)
Razorpay live keys + production webhooks, domain + SSL, legal pages live (§9), onboard **30–50 hand-recruited providers in 1–2 pilot clusters** (e.g., Hyderabad + Vijayawada per GTM Phase 1), invite ~500 MSMEs through associations, daily-metrics Slack digest, founder-led support via WhatsApp.
**Done criteria for "V1 launched":** 25 real completed paid orders, dispute flow exercised at least once for real, NPS survey sent, weekly growth review cadence established.

> **Sequencing rationale:** money rail (Phase 4) before RFQ (Phase 5) because RFQ terminates in the same checkout; discovery (Phase 3) before money because you cannot test checkout without listings; admin (Phase 7) late but before launch because verification queue (Phase 2) covers the only pre-launch ops need.

---

# §7 — SCALE-UP ARCHITECTURE (the future, designed-for but not built)

## 7.1 Scaling triggers & responses

| Trigger | Response (pre-planned exit ramp) |
|---------|----------------------------------|
| >5K active listings or search p95 >500ms | Lift search to **Meilisearch/Typesense**, CDC-synced from Postgres. Search API contract already isolates this. |
| >50K MAU | Move hot reads behind Redis cache (provider profiles, category pages); Postgres read replica for analytics. |
| Jobs >100K/day or multi-minute lag | pg-boss → **BullMQ + Redis**; job names/payloads already standardised so handlers port unchanged. |
| Vercel/Supabase cost or control ceiling | Next.js is portable to self-hosted (Fly/Railway/EKS); DB is plain Postgres → RDS/CloudSQL migration, RLS policies travel as SQL. **No proprietary lock-in in the data layer — this is why Drizzle migrations are the source of truth.** |
| Team >8 engineers | Extract first true services along existing seams: `payments-service` (webhooks, payouts, reconciliation) and `notification-service`. Order events table already gives an event log to publish from (→ outbox pattern → Kafka/SQS). |
| Multi-region / data residency demands | Already in ap-south-1; DPDP-compliant by default (§9). |

## 7.2 Roadmap features with schema landing zones already reserved

- **AI matching & recommendations (pitch-deck "AI Matching Engine"):** `rfq_matches` + `order_events` + PostHog events form the training corpus from day 1 — log everything now, model later. V2: embedding search over package scopes (pgvector extension — Postgres again).
- **AI chatbot / assisted RFQ writing:** Claude API drafting RFQ details from a voice/text description; slots into `/app/rfq/new` as an enhancement, no schema change. *Landed as Phase 8b voice RFQ; extended by §8.6 / ADR-008 (task-class router, `agent_runs`/`agent_events` in 0026).*
- **AMC Mart (procurement marketplace):** new vertical = new `product_listings` + logistics tables; reuses users, payments, payouts, reviews, disputes wholesale. Keep `orders.source` extensible (`'product'`).
- **Membership tiers:** `msme_profiles.membership_tier` + `member_extra_discount_bps` already exist; add `subscriptions` table + Razorpay Subscriptions when activated.
- **Compliance calendar engine:** consumes `msme_profiles.gstin/sector/state` + a `compliance_rules` table; notification dispatcher already multi-channel.
- **Native apps:** when PWA retention plateaus → React Native (Expo) consuming the same `/api/v1`; this is why the API is versioned and cookie-independent (bearer tokens supported).
- **Provider API / integrations (Tally, Zoho):** API-key table + scoped tokens; defer until providers ask.
- **More languages:** add `messages/{te,ta,mr,bn,gu}.json`; category/package i18n is jsonb already.

## 7.3 Data & analytics evolution

V1: PostHog + SQL on replica. V2 (>1M events/day): nightly ELT (Airbyte) → warehouse (BigQuery/ClickHouse) → Metabase for ops; marketplace-health metrics (liquidity per category-state cell, quote latency, provider utilisation) become the operating dashboard. The **category × state liquidity matrix** is the single most important growth instrument — build the query in Phase 7, promote to dashboard at scale.

---

# §8 — FEATURE-CREEP GOVERNANCE

This section exists because the pitch deck contains ~15 product lines and V1 must contain ~1.5 of them.

## 8.1 The rule

**Nothing enters a milestone without displacing something of equal size, and nothing enters the codebase without entering this document first.** Every proposal is written as a one-page mini-PRD and scored:

`RICE = (Reach × Impact × Confidence) / Effort`, where Impact is measured **only against the §1.9 metric set**. Features that don't move a V1 metric are V2-or-later by definition, regardless of excitement.

## 8.2 Version gates

| Gate | Unlocks | Entry criteria (ALL required) |
|------|---------|-------------------------------|
| **V1 → V1.5** | WhatsApp bot, membership tiers, featured placement, +4 languages, content hub | 25 completed orders/week · dispute rate <5% · ≥60% RFQ quote-rate |
| **V1.5 → V2** | AI matching, AI RFQ assistant, compliance calendar, native app | 150 orders/week · repeat rate ≥25% · provider NPS ≥40 · seed/bridge funding closed |
| **V2 → V3** | AMC Mart procurement, financing integrations (NBFC partnerships), provider APIs, multi-branch accounts | ₹1Cr+ monthly GMV · ops team ≥5 · category liquidity proven in ≥6 states |

## 8.3 The NOT-NOW register (pre-rejected ideas — re-propose only via §8.1)

Bidding wars/auctions on RFQs (race-to-bottom destroys provider quality) · provider chat before any RFQ/order (disintermediation highway) · cash/offline payments (kills escrow trust model) · custom per-buyer pricing negotiations in V1 (RFQ covers it) · social feed/community features · gamification points · video consultations · international providers or multi-currency · dynamic surge pricing · blockchain anything.

## 8.4 Engineering guardrails

- Feature flags (PostHog flags) for anything user-visible; ship dark, enable per-cohort.
- ADRs (`docs/adr/NNN-*.md`) for any decision touching money, auth, or the order state machine.
- The order state machine may only be EXTENDED (new states), never have transitions repurposed — downstream payout logic depends on it.
- Schema changes after launch require: migration + backfill plan + rollback note in the PR description.

## 8.5 Logged future enhancements (from MSME-buyer UX analysis — NOT V1)

Recorded here so they're not lost; each still needs an §8.1 mini-PRD + RICE before build.

- **Scope Revision protocol (Phase 5/6 — payment-implicated, scope carefully).** A formal mid-order top-up flow: provider requests a scope/price revision → **escrow is frozen and the delivery/SLA timer pauses** → buyer either **Approve & Top-up** (additional escrow captured, order resumes) or **Reject** (order continues at original scope or routes to dispute). Reuses the timer-pause primitive introduced for external/government wait (§3.7). Touches escrow, the order state machine, and refund math — must go through an ADR (§8.4).
- **Structured named-slot document vault (Phase 5/6).** Extends the existing `requirements_template` (jsonb) into specific *labelled* upload slots (e.g. "PAN card", "Board resolution", "Rent agreement") with per-slot status, so document collection is guided rather than a freeform dump. Builds on the order document store already in §5.
- **Document watermarking (Phase 8).** Watermark delivered documents (buyer identity + order ref) to deter leakage/reuse. Deferred — needs the delivery pipeline and real usage before it's worth the friction.

## 8.6 Agentic assistant programme — mini-PRD + RICE (founder-authorised, 2026-09-08)

**Proposal.** A model-agnostic agent layer for the three personas (buyer,
provider, ops) that *proposes* actions and calls the same `/api/v1` routes a
human does under the user's own session. Sequenced behind the live money loop.
Architecture and guarantees: `docs/adr/008-agent-runtime-and-delegated-identity.md`.
Contract: `packages/shared/src/agent.ts`. Flag: `AGENT_ENABLED` (default OFF).

**Problem.** MSME owners describe needs in speech, in Telugu/Hindi, and
abandon forms; providers respond slowly to RFQs because drafting a quote is
work. Both hit §1.9 directly (RFQ→quote response ≥70% in 48h; search→checkout
≥2.5%; repeat ≥25%).

**Phases and gates.**

| Phase | Scope | Gate to leave | Governance |
|---|---|---|---|
| **A1 (H1, Oct–Nov 2026)** | Conversational voice RFQ (one clarifying question, photographed document as input), provider quote-draft assistant, task-class router + ledger attribution | 30% of RFQs by voice; parse accuracy >90% on an audited sample | **Pull-forward authorised here.** Precedent: Phase 8b voice RFQ under §7.2 ("AI chatbot / assisted RFQ writing … no schema change"). |
| A2 (H3) | Buyer agent with typed tools (search, create/refine RFQ, compare quotes, track, draft dispute), proactive nudges, per-user budgets, metered via membership | Agent-assisted conversion ≥ manual; AI cost <5% of commission | Remains at the **V1.5→V2 gate** (§8.2 "AI matching") unless separately authorised via §8.1. |

*Status (2026-09-22): A1's provider quote-draft assistant landed as **S2.2 Digital Munshi v1** (dark; `docs/agents/MUNSHI.md`): the first proactive agent — reads under a scoped provider grant, drafts only inside a code-enforced price band from the provider's own price book, and submits only through the ordinary routes after the provider's tap (WhatsApp button, web, mobile, or an allow-listed voice "yes"). Phase 2 exit metric: ≥ 50 % of active providers with an accepted quote that came from a Munshi draft (`/admin/agents` tile). A2 is unchanged.*
*Status (2026-09-23): **A2 built dark (S3.1)** — the Buyer Procurement Agent (`docs/agents/PROCUREMENT.md`): drafts the request through the S1.8 pipeline and creates it only after the buyer's Yes, relays provider questions (answering only from the buyer's own words), summarises quotes by code, and on "go with B" sends the buyer a decision-bound link to the ORDINARY pay page — it never pays, never accepts, never negotiates price (§8.3), and money-adjacent steps confirm by button only. **Enablement stays at the V1.5→V2 gate**: switching it on for any cohort needs its own §8.1 mini-PRD + founder sign-off (the runbook lists what it must contain).*
| A3+ | Live multimodal tier, telephony, business twin, provider work-drafting, negotiation protocol | per roadmap | Each its own §8.1 entry + ADR; negotiation touches the §8.3 "bidding" exclusion and needs an explicit amendment. |

*Status (2026-09-23): **Fair price ranges built dark (S3.2)** (`docs/agents/BENCHMARKS.md`): both sides of a services request see the same line — "Similar jobs in <state> closed at ₹X–₹Y, typically in N–M days (based on n paid jobs from p providers)" — computed nightly by CODE from PAID orders only (never quotes), shown only past four privacy gates (≥ 30 jobs, ≥ 8 providers, ≥ 8 buyers, no provider > 25 %; settings can only tighten them) and rounded; the table has no id column. Not advice: fixed copy, no per-quote judgement; the optional explanatory sentence (`benchmark_explain@v1`) is policed for advice words and any number not in the row. Compute and display are separate switches (both OFF): compute on → review two weeks → display on.*

**RICE (A1 only, Impact measured against §1.9).** Reach 0.8 (every buyer
creating an RFQ; every provider quoting) · Impact 2 (high: RFQ→quote response
rate and search→checkout conversion) · Confidence 0.6 (voice RFQ already
shipped; parse accuracy measured by the golden set) · Effort 6 person-weeks
(runtime service + two features) → **RICE ≈ 0.16**. Displaces: nothing in H0 —
A1 does not start until the H0 money-loop gate passes (25 real paid orders).

**Invariants (non-negotiable, enforced in code).** Agents never hold
service-role privileges for user data; every money/status action requires an
explicit user confirmation recorded by the surface; admin actions are never
tools; the agent gives no tax/legal advice — it routes to a professional;
anything read from documents or threads is data, never instruction.

**Not in scope.** AI matching as a ranking replacement for search, automated
adjudication, agent-to-agent negotiation — all gated as above.

**Drift corrected.** CLAUDE.md summarised §8.3 as including "AI matching/
chatbot"; §8.3 never listed it (AI features are V2-gated by §8.2). CLAUDE.md
now matches this document.

---

## 8.7 Experience v3 "Precision" — approved bundle (founder, 2026-09-23)

**What.** `docs/prd/PRD_EXPERIENCE_V3.md` — the §8.1 bundle built from the
September 2026 market survey (19 portals): the 12 UX defects fixed first (E0),
a restrained, dense design language (E1), and every missing UI/UX element
paired with the feature that feeds it (P1–P67, N1–N45), in epics E0–E17 with
RICE, flags, acceptance and a wave plan (PRD §8).

**Approval.** Approved by the founder on 2026-09-23 ("continue the building
based on the V3 PRD … until it's completely done"), including D-PRD2
(buyers see "Requirements"; providers keep "RFQs").

**Displacement.** The agent programme (§8.6) pauses after S3.2 — see CLAUDE.md
and `BUILD_PROMPTS.md` for the resume rules.

**What approval does NOT change.**
- Every epic ships dark behind its own flag and is enabled per cohort.
- Items that wait on a decision in PRD §10 (D1 public stats, D2 buyer-verified
  badge, D3 PAN path, D9 tenders, D-PRD5 obligations/renewals, D-UX2 consent)
  are built dark and stay off until that decision. Renewal reminders are the
  "compliance calendar" of the V1.5 → V2 gate (§8.2): built dark, enabled only
  at that gate.
- Money items (add-ons, speed tiers, bundles, the PAN path) each need an ADR
  first (§8.4) and add money-rig criteria.
- The NOT-NOW register (§8.3) is unchanged.

# §9 — RISKS, COMPLIANCE & TRUST

## 9.1 Legal & regulatory (India)

- **Entity & invoicing:** Platform raises (a) buyer invoice on behalf of provider or provider invoices buyer directly with platform commission invoice to provider — get CA sign-off on the GST structure for marketplace commission (SAC 9985/9997) **before** Phase 4; TCS under GST Sec 52 applies to e-commerce operators collecting consideration — build `tcs_paise` column readiness into payments.
- **DPDP Act 2023:** consent capture at signup, purpose limitation, data-principal rights (export + delete endpoints — soft-delete + 30-day purge job), breach-notification runbook. **Stored** data stays in ap-south-1 (Supabase Mumbai, incl. the private `wa-media` bucket for WhatsApp voice notes/photos sent to the assistant). **AI inference is a disclosed cross-border processor:** agent features send only the content a request needs to AI model providers that may process it outside India, under no-training / zero-retention terms (privacy policy §5/§6, v `2026-09-23`; `docs/agents/SECURITY.md` "Model-provider data terms"). An opt-in residency guard (`AGENT_RESIDENCY_ENFORCE`, `TASK_CLASS_RESIDENCY` in `packages/shared/src/agent.ts`) can pin in-India task classes to allow-listed hosts; a signed DPA per model provider is a blocker for enabling any agent cohort (`docs/COMPLIANCE.md`).
- **IT Rules 2021 (intermediary):** grievance officer named on `/legal/grievance`, 24h acknowledgement / 15-day resolution SLA, takedown process.
- **Terms:** marketplace is an intermediary, not the service performer; provider agreement covers commission, payout terms, quality SLAs, and professional-liability disclaimer (legal/CA advice is the provider's responsibility).

## 9.2 Payments & money risks

- Webhook as single source of truth + daily reconciliation cron (Razorpay settlements API vs `payments`) — mismatches page the founder.
- Escrow semantics via Route deferred transfers; refund policy matrix (pre-accept 100%, in-progress per-policy, disputed per-resolution) encoded in one function, unit-tested.
- Payout holds: auto-hold if dispute open, provider suspended, or bank verification stale.

## 9.3 Marketplace integrity

- **Disintermediation** (the #1 services-marketplace killer): pre-payment contact masking (§5.5 `messages.redacted`), value-after-payment (escrow protection, invoices, milestone tracking, review building), provider incentive (completed-order count drives rank), detection heuristics (phone-pattern regex hits logged).
- **Review fraud:** verified-purchase-only, one per order, provider-reply allowed, anomaly flag (burst of 5★ from new accounts) to moderation queue.
- **Ranking fairness:** default sort = composite (rating, completion rate, response time, recency) — documented internally; "Promoted" always labelled.
- **Cold-start liquidity:** seed supply-first per cluster (pilot recruits 30–50 providers before MSME marketing); RFQ rescue funnel on empty search results; founder-mediated fulfilment for first orders is acceptable and instrumented.

## 9.4 Security checklist (enforced in Phase 8)

RLS-by-default, service-role key server-only · signed URLs for all private files (15 min) · OTP rate-limit + device fingerprint · webhook signature verification · Zod on every input · upload scanning (type sniff + size + extension allowlist) · secrets in Vercel/Supabase vaults, never in repo · admin actions 2FA + audit-logged · dependency audit in CI · backups: PITR enabled, weekly restore drill.

---

## Appendix A — Canonical event names (analytics, PostHog)

`search_performed · listing_viewed · provider_viewed · package_viewed · checkout_started · payment_succeeded/failed · rfq_created · quote_submitted/viewed/accepted · order_accepted/delivered/completed/disputed · review_submitted · provider_signup_started/kyc_submitted/approved · language_switched`
Gateway funnel (Phase 8a): `gateway_viewed · gateway_door_chosen · gateway_wizard_step_viewed · gateway_wizard_step_answered · gateway_wizard_step_skipped · gateway_wizard_completed · gateway_results_viewed · gateway_browse_clicked · gateway_rfq_opened · gateway_rfq_submitted · gateway_provider_wizard_completed · gateway_provider_application_submitted` (props: `door, step, field, value, prefilled, category, state`).

Voice RFQ v2 (S1.8): `voice_rfq_clarify_shown { gap, tts, locale } · voice_rfq_clarify_answered { by: voice|text|skipped, gap } · rfq_intake_document { kind, doc_type, mode, stub, facts } · rfq_intake_document_failed { reason } · rfq_intake_document_added · rfq_intake_chip_edited { k }`.

Voice RFQ funnel (Phase 8b): `voice_rfq_started · voice_rfq_transcribed · voice_rfq_parsed · voice_rfq_edited · voice_rfq_submitted · voice_rfq_failed` (props: `surface ('rfq_form'|'gateway'), original_language, uncertain, duration_ms, field` — `voice_rfq_edited` fires once per corrected field; `voice_rfq_submitted` marks an RFQ created with voice_meta attached).
Buyer Procurement Agent (S3.1, dark): `procurement_enabled { whatsapp_widened }` · `procurement_disabled` · `procurement_message { surface, kind, enqueued }` (server) · `procurement_turn { surface, outcome, tool, reply_keys }` · `procurement_proposed { tool, surface }` · `procurement_step_decided { tool, outcome, via|status, surface }` · `procurement_yes_needs_button { tool }` · `procurement_quotes_summarised { rfq_id }` · `procurement_checkout_link_sent { rfq_id }` · `procurement_session_closed { state, reason }` (runtime) · `procurement_checkout_opened { rfq_id, device }` · `procurement_card_tapped { action, device }` (client).

Fair price ranges (S3.2): `benchmark_shown { role: buyer|provider, scope: state|national, category }` (client, web + mobile; fires once per render of the line).

AMC Score (S2.4): `score_card_viewed { computed, gated, has_note }` (server) · `compare_ordering { rfq_id, mode: price|reliability, quote_count, reordered }` (server) · `compare_sort_changed { from, to }` (client) · `munshi_growth_sent { kind: profile_field|category_demand|score_tip|score_rise, whatsapp, in_app }` (runtime).

Support agent (S2.3): `support_turn { channel: web|mobile|whatsapp, intent, escalated, reply_key, role, ticket_open? }` (server + runtime) · `nudge_sent { subject_kind: order|rfq, via: web|mobile|whatsapp|agent, recipients? }` (server; spine, flag-independent) · `support_nudge_decided { outcome: sent|capped|declined }` (runtime) · `support_ticket_opened { channel, role, reason, has_summary }` · `support_ticket_resolved { ticket_id, channel, minutes_open }` (server).

Digital Munshi (agent S2.2): `munshi_enabled · munshi_paused · munshi_disabled` (server) · `munshi_draft_proposed { kind, action, confidence, has_basis }` (runtime) · `munshi_draft_decided { via: whatsapp_button|voice_yes|whatsapp_text|web|mobile|run|composer|system, outcome, kind }` (server + runtime) · `munshi_reminder_sent { rfq_id, whatsapp }` · `munshi_reply_proposed { quote_id, needs_provider_input }` · `munshi_price_book_row_added / _deleted`.

Quote extraction (agent S1.1): `agent_quote_extract_requested` (server; props `rfq_id, kind, source, stub, uncertain_count`) · `quote_extract_filled` · `quote_extract_cleared` (client; props `rfq_id, uncertain_count, stub`). The confirmation itself rides the existing `quote_submitted` / `quote_events.submitted` payload (`extraction_id`, `edited_fields`).
Buyer compare + decline (agent S1.2): `compare_viewed` (server; props `rfq_id, quote_count, flags_total, pointers ('cached'|'fresh'|'off'|'error')`) · `quote_declined` (server; props `rfq_id, quote_id, reason, has_note, message_source ('agent'|'template'), locale`).
Clarifications + revision (S1.3): `rfq_question_asked` (server; props `rfq_id, kind, redacted, open_count`) · `rfq_question_answered` (server; props `rfq_id, hours_to_answer, redacted, notified`) · `quote_revised` (server; props `rfq_id, quote_id, revision, price_delta_sign ('up'|'down'|'same')`) · `quote_revised_client` (client; props `rfq_id, revision`).
RFQ Quality (agent S1.5): `rfq_quality_checked` (server; props `rfq_id, complete, missing_count, rule_count, model_count, risk_flags, stub, model_used, deferred`) · `rfq_quality_answered` (server; props `rfq_id, answered_count, missing_count, seconds_since_check, redacted, matched`) · `rfq_quality_sent_as_is` (server; props `rfq_id, missing_count, matched`) · `rfq_quality_auto_released` (server, cron; props `rfq_id, matched, hold_minutes`) · `rfq_quality_answer_dictated` (client; props `rfq_id, field`).
Dispute triage (S1.7): `dispute_statement_submitted` (server; props `order_id, dispute_id, role, has_docs, redacted, edited`) · `dispute_triage_written` (runtime; props `dispute_id, kind, recommendation, confidence, checks_failed, stub`) · `dispute_resolved_with_triage` (server; props `dispute_id, triage_id, agreed, recommendation, resolution`).
Onboarding agent (S1.6): `onboarding_wa_started` (server; props `session_id, surface, enqueued|sent`) · `onboarding_wa_step` (runtime; props `session_id, step, kind, outcome, redacted`) · `onboarding_wa_drafted` (runtime; props `session_id, categories, packages, uncertain_count, stub, draft_count`) · `onboarding_wa_confirmed` (runtime; props `session_id, decision_id, facts, draft_count`) · `onboarding_wa_revised` (runtime; props `session_id, draft_count`) · `onboarding_wa_abandoned` (runtime; props `session_id, step, sent`) · `onboarding_wa_failed` (runtime; props `session_id, failure`) · `onboarding_wa_handed_off` (runtime; props `session_id, confirmed, cap?`) · `onboarding_prefill_used` (server; props `session_id, provider_id`).
Quote withdraw (PR #15): `quote_withdrawn` (server; props `rfq_id, quote_id, has_reason, role`).
Experience v3 (`docs/prd/PRD_EXPERIENCE_V3.md`; each epic's Events table is canonical, listed here as it lands). E4 packages: `package_viewed { tiers }` · `tier_selected { tier }` · `compare_matrix_viewed` · `buy_now_clicked { tier, total_bucket, surface? }` · `refund_policy_opened` (client) · `package_group_saved { tiers, rows, created }` · `package_group_deleted` (server). E2 discovery: `search_performed { q_len, filters, sort, results, view }` · `search_filter_changed { filter, value }` · `search_feedback_given { helpful, reason }` · `search_zero_results` · `search_to_requirement_clicked { zero }` (client) · `search_feedback_stored { helpful, reason, results }` (server). E2b: `service_page_viewed { service }` · `shortlist_added { count }` · `compare_opened { n }` · `recent_view_opened { kind }` · `search_voice_used { lang, ok }` (client). E5 checkout: `checkout_viewed { logged_in }` · `checkout_inline_auth_started` · `checkout_inline_auth_completed { new_profile }` · `checkout_itc_shown` · `payment_initiated { coupon, gst_invoice }` (client; payment success stays the webhook's server event). E6 requirements: `requirement_form_started { entry }` · `requirement_voice_used { lang, ok }` · `requirement_strength_changed { bucket }` · `requirement_document_toggled { key, on }` · `requirement_must_have_set { kind, value?, on }` · `requirement_submitted { score, required_filled, entry }` · `requirement_entry_clicked { entry }` (client). E9 homes: `home_viewed { actions }` · `home_action_clicked { kind }` · `home_pickup_clicked { kind }` · `buy_again_clicked { price_changed }` · `requirement_repeated` (client; web + mobile). E9b (dark, D-PRD5): `licence_added { source }` (client + server) · `obligation_checklist_viewed { rules }` (client) · `renewal_reminder_sent { threshold }` (server). E10 provider onboarding: `onboarding_step_viewed { step, category }` · `onboarding_step_completed { step, ms }` · `onboarding_gstin_autofilled { fields }` · `onboarding_submitted { category, path }` (client) · `onboarding_abandoned { step }` · `onboarding_nudge_sent { step }` (server). E11a provider workspace: `partner_home_viewed { actions }` · `partner_action_clicked { kind }` · `inbox_filter_changed { key }` · `inbox_sorted { key }` (client). E11b quote form: `quote_form_started { entry }` · `quote_preview_shown { gst_mode }` · `quote_submitted { from_draft }` (client). E11c: `insights_viewed { range }` · `tender_alert_opened` · `tender_alert_feedback { useful }` · `gem_checklist_viewed` (client). E7 compare v3: `compare_viewed { quotes }` (client, the page view; the S1.2 server `compare_viewed` still fires from the pointers route) · `compare_sorted { key }` · `quote_shortlisted` · `quote_accepted` (client; the confirm tap — payment truth stays the webhook) · `quote_declined` (the existing S1.2 server event) · `quote_lost_labelled { rfq_id, n }` (server, from finalize). E8 order workspace: `order_viewed { status, role }` · `order_next_action_clicked { action }` · `order_tab_viewed { tab }` (client). E8b order messaging: `order_message_sent { redacted, docs }` · `order_message_read` (client).
Every event carries: `role, state, category_id, locale, device`. These power the §1.9 funnel — instrument in the same PR as the feature, not after.

## Appendix B — Glossary

**RFQ** request for quote · **Take rate** commission % of GMV · **Route** Razorpay split-settlement product · **Liquidity** probability a request gets fulfilled in a category-state cell · **Fan-out** notifying matched providers of an RFQ · **Disintermediation** parties transacting off-platform.

---

*End of document. Changes follow §8.1: mini-PRD → RICE score → update this doc → then code.*
