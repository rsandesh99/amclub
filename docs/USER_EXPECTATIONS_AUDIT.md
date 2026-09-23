# User-expectations audit — history, memory, and everything a real user will reach for

**Date:** 2026-09-22 · **Scope:** web (`apps/web`), mobile (`apps/mobile`), schema/RLS (`packages/db`), agent layer.
**Method:** four read-only sweeps (buyer journey, provider journey, account/data rights/AI transparency,
ops/data lifecycle), then spot-verification of the highest-severity claims against the code.
Items marked **✔ verified** were re-read line by line; everything else carries the sweep's file:line
evidence and should be re-confirmed by the PR that fixes it.

This is an audit, not a design change. Anything below that adds scope goes through DESIGN.md §8.1
(mini-PRD + RICE) before code; P0 items are defects against existing rules (§2.5, §9) and do not.

---

## Headline

The platform *stores* almost everything a user produces, but it rarely lets them **read it back**,
**act on it again**, or **know what happens next**. Three structural patterns explain most gaps:

1. **Write-only history.** Data exists with no owner read path: `wa_messages`, `rfqs.voice_meta`,
   `quote_events` (provider side), `order_events.payload` (requirements, hold reasons, transporter
   details), `ai_decisions`, `refunds`, `payments`, Munshi draft history.
2. **Silent clocks.** Every lifecycle timer (24 h accept, 72 h RFQ expiry, 72 h auto-accept, quote
   validity, due date, revisions left) is enforced server-side but invisible, and most fire with no
   warning and no notification.
3. **Lists, not records.** Every list (RFQs, orders, quote threads, notifications, reviews) is
   unfiltered, unpaginated or hard-capped, with no search and no export.

On top of that the sweeps found a set of **P0 defects** — security, money and legal — that must be
fixed before any real user touches production, regardless of the feature work.

---

## P0 — fix before real users (security · money · legal)

| # | Defect | Evidence | Status |
|---|---|---|---|
| P0-1 | **Self-promotion to admin.** `users: owner all` is `FOR ALL … WITH CHECK (id = auth_user_id())`; no column privilege or trigger protects `users.roles`. Any signed-in user can `update users set roles='{admin}'` with the anon key + own JWT, and can DELETE their own `users` row (cascades). `has_role()`, middleware and the admin layout all trust `users.roles`. | `packages/db/src/rls/policies.sql:81-82`; no `REVOKE … users` in any migration; `verify-authz.ts` never tests it | ✔ **confirmed on the live DB 2026-09-22** (`has_column_privilege('authenticated','public.users','roles','UPDATE') = true`, policy `owner all:*`, only trigger `set_updated_at`). Fix: migration `0042_users_privilege_guard.sql` + `policies.sql` + `verify-authz.ts` §7b — **apply to prod** |
| P0-2 | **Messages are mutable by either party.** `messages: parties all` is `FOR ALL` → a party can UPDATE/DELETE the other side's messages (incl. un-redacting) from the client SDK. | `policies.sql:807` | ✔ verified |
| P0-3 | **Forgeable order events.** `order_events: parties insert` lets either party insert any event type with any `actor_id` via the client SDK (e.g. a fake `payout_paid` / `manual_refund` row in their own timeline). | `policies.sql:670-678` | ✔ verified |
| P0-4 | **Accepting an RFQ quote never opens Razorpay in live mode.** `QuoteCompare.accept()` handles only `d.simulated`; otherwise it routes to `/app/orders?processing=1` with no payment. Every RFQ→order breaks the day the `rzp_live_` guard is removed. | `apps/web/components/rfq/QuoteCompare.tsx:140-158` vs `CheckoutClient.tsx:107-123` | ✔ verified |
| P0-5 | **Two paid orders on one RFQ are possible.** Each accept click mints a fresh idempotency key; checkout only checks RFQ is `open`/`quoted`; `finalizeQuoteAcceptance` claims the RFQ once and silently returns for the second paid order — no refund path. | `QuoteCompare.tsx:144`; `api/v1/checkout/route.ts:149-151`; `lib/rfq/finalize.ts:33-40` | plausible (not executed) |
| P0-6 | **Shared-device data leak.** The service worker caches every navigation (authenticated pages) and `/api/v1/orders*`, `/api/v1/notifications*`; sign-out never clears `caches`. The next person on the device can read the previous user's orders offline. | `apps/web/public/sw.js:70-92`; no `caches.` call in app code | ✔ verified |
| P0-7 | **Privacy policy contradicts the system.** (a) Inbound WhatsApp voice notes/photos are stored indefinitely in `wa-media`, but Privacy §4 says recordings are "not stored" and DESIGN:728 requires a purge before any audio is stored. (b) §5/§6 omit the LLM processors (OpenRouter → Google/Anthropic/OpenAI) — see the queued "Disclose AI processors" task. (c) §7 promises export/delete "within 30 days" with no mechanism. | `apps/agent-runtime/src/whatsapp/inbound.ts:143-150`; `messages/en.json:1775-1781` | sweep |
| P0-8 | **MSME suspension is not enforced.** "Suspend" sets `msme_profiles.deleted_at`; nothing (`resolveActor`, `getMsmeProfile`, auth) checks it. A suspended buyer keeps full access. | `api/v1/admin/msmes/[id]/route.ts:79`; `lib/orders/actor.ts:10-13` | sweep |
| P0-9 | **KYC credential links die after 7 days.** A 7-day signed URL is persisted as `provider_verifications.document_url` and linked from the admin queue. | `api/v1/profile/provider/credential-upload/route.ts:93-95`; `profile/provider/route.ts:240` | sweep |
| P0-10 | **Audit log is mutable and incomplete.** `audit_logs` has no append-only trigger/REVOKE; KYC approve/reject, coupons, CMS, Mart pools/documents, voice-parse-text write no audit row. Silent insert failures (supabase-js returns `{error}`, code only catches throws) in `lib/audit/log.ts` and `lib/notifications/create.ts`. | `policies.sql:873`; `lib/audit/log.ts:33-45` | sweep |
| P0-11 | **Grievance channel is broken.** `/help` grievance link is `href="mailto:"` (empty); the grievance page promises a reference number but there is no grievance table, form or SLA tracking (IT Rules 24 h ack / 15 day resolve). | `app/[locale]/(public)/help/page.tsx:75` ✔; `lib/legal/grievance.ts:31-34` | partly ✔ |
| P0-12 | **Agent event payloads leak detector internals.** Users can read their own `agent_events`; `injection_suspected` carries detector `hits`/`score` — a tuning oracle for injection attempts. | `0026` RLS `:114`; `agent-core/src/runner/index.ts:222` | sweep |

---

## P1 — core flows that are broken or dead-ended

### Buyer
| Gap | Evidence |
|---|---|
| Cannot **raise a dispute** from any UI (API allows `raise_dispute`; buyer `actionsFor` never offers it; mobile same). Dispute statement card only appears once already disputed. | `components/orders/OrderWorkspace.tsx:35-42`; `apps/mobile/app/(app)/orders/[id].tsx:18-22` |
| Cannot **cancel once `accepted`** — the `accepted` branch returns before the cancel branch (server allows it). Mobile same. | `OrderWorkspace.tsx:36,41` ✔ |
| **Requirements are never collected.** Package page lists "what we'll need"; the "Submit requirements" button sends only `{action}`; nothing sends `requirementsData`. Providers never see requirements either. | `OrderWorkspace.tsx:148-152`; `api/v1/orders/[id]/transition/route.ts:24,49-56` |
| **No chat after payment.** Quote threads end at acceptance; package-sourced orders never had one; `conversations.context_type='order'` has no route. | `schema/engagement.ts:28` |
| **Invoice ignores the GSTIN entered at checkout** (reads profile GSTIN); the RFQ-accept path has no GSTIN field; cancelled/refunded orders get no receipt. | `lib/invoices/generate.ts:64,91,109`; `api/v1/checkout/route.ts:225` |
| **Refund amount/status/timeline invisible**; buyer is not notified on cancel or refund. | `OrderWorkspace.tsx:63,283`; `lib/notifications/events.ts:90-93` |
| **"Repost with edits" opens a blank form** and the local draft is deleted on submit. | `QuoteCompare.tsx:123`; `RfqForm.tsx:292` |
| RFQ `cancelled` status styled but unreachable (no cancel route); RFQ header "Sent to {n} providers" shows the *quote* count. | `app/(msme)/app/rfq/page.tsx:11`; `rfq/[id]/page.tsx:65` |
| Payment failure is not recorded (`payment.failed` ignored); abandoned checkouts cannot resume (fresh UUID per attempt). | `api/v1/webhooks/razorpay/route.ts:63-65`; `CheckoutClient.tsx:86` |

### Provider
| Gap | Evidence |
|---|---|
| **Every payout shows "Held"** (default `approval_gate`) with no reason or expected date; reasons live only in admin-rendered event payloads. | `lib/orders/transitions.ts:87-96` ✔ |
| **Cannot read or answer buyer quote messages on web**; the notification deep-links to the buyer route `/app/rfq/…` → 404 for providers. | `api/v1/quotes/[quoteId]/messages/route.ts:~116` |
| **Lost / awarded / expired RFQs vanish** from the inbox (filter keeps only `open`/`quoted`); the "awarded to another provider" alert links to that list. | `lib/rfq/queries.ts:298` ✔; `lib/rfq/finalize.ts:106-113` |
| **No withdraw quote** although the decline API tells providers to withdraw; no re-quote after decline. | `api/v1/rfq/[id]/decline/route.ts:49`; `queries.ts:374` |
| **"Pause capacity" does not stop package orders** (copy says it does); honoured only by RFQ fan-out. | `lib/rfq/fanout.ts:50`; no `capacity_paused` in checkout ✔; `en.json:551` |
| **Provider cannot cancel/decline an order** they can't take; only exit is the 24 h auto-cancel (and they're not told when it fires). | `transitions.ts:50,361-366` |
| **`pending_kyc` dead loop** — dashboard CTA → `/partner/onboarding` → redirected back. | `app/(provider)/partner/page.tsx:84-88`; `onboarding/page.tsx:19` |
| **Telugu silently dropped** on profile save (form allows en/hi only). | `ProviderProfileForm.tsx:11,97` |
| Bank account change is "contact support" only; commission GST invoice generated but never exposed; services TDS never computed; no statements. | `en.json:552`; `lib/invoices/queries.ts:19-21`; `schema/orders.ts:180-184` |

### Notifications (both sides)
- SMS is a hard stub even with a key (`lib/notifications/channels.ts:205-210`); web push stubbed; **no mobile push token anywhere**.
- New-RFQ alerts: no email; WhatsApp only with an opt-in grant → most providers see leads only in-app.
- **Silent clocks:** no pre-warning or notice for auto-accept (buyer), auto-cancel (provider), RFQ expiry, quote expiry, payout failure, suspension holds, new review, admin decisions (dispute resolution, KYC approve/reject, refund).
- Telugu/Tamil users get English notifications (`components/shell/NotificationCenter.tsx:21`; `lib/notifications/create.ts:12-14,100-101`).
- No delivery status, no retry, failures only in console (`create.ts:121`).

---

## P2 — History & memory (the gap that started this audit)

**Principle to adopt:** *every record a user creates or receives is readable by them, findable,
reusable, and exportable — and the AI only ever "remembers" by reading those same records under the
user's own session.* No inferred profiles; user-confirmed preferences only (see §P2.4).

### P2.1 Record read-back — what each user should be able to reopen

| Record | Stored in | Owner can read today? | Needed |
|---|---|---|---|
| Past RFQs (all statuses) | `rfqs` | Buyer: list only, no filter/search/pagination. Provider: closed ones hidden. | Tabs (open / awarded / expired / lost), search, pagination; provider "won/lost" history with the order link |
| Voice transcript & parse | `rfqs.voice_meta` | ✗ | Show "what we heard" on the RFQ detail (editable into a clarification) |
| Uploaded RFQ documents & extractions | `rfq-attachments`, `rfq_intake_extractions` | partial | Attachments list + extracted facts, add-after-posting |
| Quotes + every revision | `quotes`, `quote_events` | Buyer: price/days only. Provider: ✗ | Full diff (scope, terms, price) per revision, both sides |
| Pre-order Q&A | `rfq_clarifications`, quote `messages` | per RFQ; provider web ✗ | Provider thread UI; attachments; read state |
| In-order conversation | — | ✗ (no route) | Order chat (reuse `conversations` with `context_type='order'`), attachments, unread counts |
| Requirements & scope snapshot | `order_events.payload`, `orders.scope_snapshot` | ✗ | Render in the workspace for both parties; versioned if changed |
| Documents & deliverables | `order_documents` | ✔ (15-min links) | Buyer upload (evidence), per-slot vault (§8.5 logged) |
| Money: payments, refunds, invoices, payouts, TDS | `payments`, `refunds`, `invoices`, `payouts` | invoices/payouts only | Buyer payment & refund history; provider statements, commission invoices, TDS |
| Reviews written / received | `reviews` | per order only | "My reviews" list; provider flag button; edit window |
| WhatsApp conversations | `wa_conversations`, `wa_messages` | ✗ (admin RLS only, no route) | User thread view; ops view in the support timeline |
| What the AI did for / about me | `ai_decisions`, `agent_runs`, `munshi_drafts`, `quotes.munshi_draft_id` | ✗ (APIs exist, no UI) | "AI activity" page: every draft, what was sent in my name, every confirmation; labels on AI text |
| Notifications | `notifications` | last 50, no cursor | Cursor pagination, type filter, retention |
| Consents & grants | `terms_acceptances`, `agent_grants` | partial, web only, flag-gated | Full list incl. revoked; mobile |

### P2.2 Find — search across *my own* data
- One search box over my RFQs, quotes, orders, messages, documents (titles), invoices. Postgres FTS
  per-table `tsvector` + an owner-scoped RPC is enough at this scale (catalog FTS already exists,
  `search_packages`).
- Filters everywhere: status, date range, category, provider/buyer, kind (service/goods).
- Recently viewed (buyer: providers/packages; provider: RFQs).

### P2.3 Reuse — act on history
- **Buyer:** duplicate/repost an RFQ *with* its fields and attachments; server-side RFQ drafts
  (today one localStorage draft per device); "hire again" / "request a quote from this provider"
  from saved providers, past orders and provider pages; reorder a services package.
- **Provider:** quote templates and saved line items; "reuse the scope from quote X"; a client list
  (past buyers, repeat rate) — within contact-masking rules (no pre-payment contact exposure).
- **Both:** export — scope-of-work PDF, order summary PDF, chat transcript, CSV of orders/payouts
  (accountants and approvers are the real audience for B2B).

### P2.4 AI memory — how agents should use history (design constraints)
1. **Memory = retrieval of the user's own records**, fetched via `/api/v1` under the user's
   delegated token (RLS/app-code ownership), summarised into the **trusted** part of the prompt.
   Never a vendor-side memory, never a model-side profile.
2. **Preferences memory is explicit.** A `user_agent_memory` table (items like "prefer Telugu",
   "usual delivery 7 days", "GSTIN for invoices X") written **only on user confirmation**
   (`ai_decisions` row), viewable/editable/deletable by the user, with a retention window and
   included in DPDP export/erasure.
3. **Never store inferences** ("price-sensitive", "small unit") without confirmation — purpose
   limitation and the §9.3 ranking-fairness rule.
4. **Bounded context:** top-k relevant records + summaries, stable prefix first (prompt caching),
   per-prompt `max_tokens`; embeddings (pgvector, ARCHITECTURE §10) only over platform-owned text.
5. Needs an §8.1 entry + ADR-008/009 amendment; keep dark and post-25-orders. The read-back pages in
   P2.1–P2.3 do **not** depend on this and should come first.

---

## P3 — Account, identity & data rights

| Gap | Evidence / note |
|---|---|
| **DPDP export & erasure** not built (F7/F8). Erasure must be **anonymisation**, not delete: `ON DELETE NO ACTION` FKs (`verified_by`, `raised_by`, `uploaded_by`, `actor_id`, `sender_id`) and append-only triggers (`order_events`, `agent_events`, `quote_events`, `terms_acceptances`) block naive deletes; `payments`/`refunds` currently *cascade* on order delete (financial records must be retained, not deleted). Needs an ADR: per-table action (retain-for-law / anonymise / delete), privileged purge path for append-only tables. | `packages/db/src/migrations/0000_*.sql:439-476`; `schema/orders.ts:101,158` |
| **No retention/purge** for any table or bucket; `users` has no `deleted_at`. Needs a retention matrix (below) + a purge cron with heartbeat. | `apps/web/vercel.json` crons |
| Change phone / add-verify email; active sessions; account linking (phone vs Google creates two accounts); deactivate vs delete. | no `auth.updateUser` anywhere |
| Consent withdrawal UI (privacy §3 says "via support"). | `en.json:1773` |
| **Notification preferences** (per event × channel, quiet hours, marketing vs transactional, email unsubscribe); STOP doesn't stop order-kind WhatsApp. | `lib/notifications/events.ts`; `agent-core/src/whatsapp/templates.ts:71-75` |
| **Language preference incoherent:** header switch not persisted; te/ta not saveable on profiles; ta notifications fall back to en; mobile locale device-only; WhatsApp locale copied once. | `LanguageSwitcher.tsx:37-39`; `MsmeProfileForm.tsx:61`; `mobile/lib/i18n.tsx:46-55` |
| AI labels on AI-written outbound text (decline messages, Munshi-drafted quotes seen by buyers, WhatsApp). Likely required by the IT Rules synthetic-content labelling amendment — confirm with counsel. | `app/(provider)/partner/rfqs/[id]/page.tsx:152-153` |

**Retention matrix to decide (founder + counsel):**

| Data | Suggested |
|---|---|
| Invoices, payments, refunds, payouts, orders, order_events | Retain ≥ 8 years (GST/Income-tax); anonymise the person, keep the transaction |
| Messages, clarifications, documents | Order life + 3 years, then purge (dispute limitation) |
| WhatsApp text | 180 days; **audio/photos 30 days** (DESIGN:728) |
| Voice transcripts (`voice_meta`) | With the RFQ |
| agent_events / ai_invocations | 1 year (refs only) |
| ai_decisions | With the object it confirmed |
| Notifications | 180 days |
| Onboarding sessions | TTL already (`onboarding_session_ttl_hours`) + purge |
| KYC documents | Life of provider account + statutory period |

---

## P4 — Provider practice & money

- Payout transparency: hold reason in plain language, expected release date, per-order commission
  breakdown (the "5 %" copy is hard-coded while `commission_bps` varies — `en.json:1089`).
- Monthly/annual statements (earnings, commission, GST on commission, TDS) as PDF/CSV;
  commission GST invoices downloadable; 194-O TDS on services (CA sign-off item in COMPLIANCE.md).
- Bank account change flow with re-verification and payout hold during change.
- Availability: vacation dates, capacity limits, working hours; pause honoured by checkout.
- Team/associate logins for CA/CS firms — the RLS refactor noted earlier; decide the account model
  in an ADR now, build later.
- Reputation: flag review button (API exists), new-review notification, "how your rank works"
  (response time, completion rate, rating — the composite from §9.3), provider-visible metrics.
- Countdown chips on every clock: quote window, RFQ expiry, 24 h accept, due date, 72 h auto-accept,
  revisions left.
- Deliver gated on a deliverable document (the comment at `OrderWorkspace.tsx:147` says so; code
  doesn't).

---

## P5 — Ops & support tooling

- Find a user by **phone / email / GSTIN / order no. / RFQ id** (today: business name only).
- **One support timeline per user**: profile + users row, RFQs, quotes, orders, messages,
  payments/refunds, notifications sent (with delivery outcome), WhatsApp thread, agent runs,
  grievances, admin actions. No admin RFQ page exists at all.
- **Case model**: grievances/support tickets with reference number, 24 h ack / 15 d resolve SLA
  clocks, overdue view, notes. (Also closes P0-11.)
- Notify users on every admin decision (dispute resolution, KYC, refund, suspension).
- Manual refund: support top-up/second refunds correctly (today returns the old amount and logs a
  misleading event — `api/v1/admin/orders/[id]/route.ts:70-75`); notify buyer.
- Provider reactivation should release suspension holds.
- Observability: `onRequestError` + `captureException` in `serverError()`, `global-error.tsx`,
  mobile Sentry; heartbeat panel missing `pool-close` and the three agent crons; heartbeats on failure.
- Pagination on admin lists (hard 200 caps); PostgREST filter-string injection in
  `api/v1/admin/providers/route.ts:41` (admin-only, still fix).

---

## P6 — Mobile parity (functional, not design)

`MOBILE_PARITY.md` tracks design-system items only. Functional gaps:
- **Buyer:** profile edit, invoices, help/grievance/privacy, grants & WhatsApp opt-in, real Razorpay
  checkout (`apps/mobile/app/(app)/checkout/[packageId].tsx:39`), dispute raise, cancel-after-accept.
- **Provider:** order list (hard-coded `'msme'`, `orders/index.tsx:19`), deliverable upload,
  milestones, decline RFQ, earnings, listings, reviews, profile, onboarding wizard.
- **Broken:** dashboard stats hard-coded `0`/`₹0` (`partner.tsx:105-107`); dead
  `/(auth)/partner-signup` route; no push notifications.

---

## Edge-case matrix — what each party should see and be told

| Event | Buyer should | Provider should | Today |
|---|---|---|---|
| RFQ posted, 0 quotes at 24 h | Nudge: widen category / add detail / extend | — | static card only |
| RFQ expiring in 24 h | Reminder + extend option | Reminder if matched and not quoted | nothing |
| RFQ expired | Notified; can reopen with same content | Notified if quoted | silent |
| Quote expiring | Warned | Warned; can extend validity | silent |
| Quote declined / lost | — | Reason + link to the (now closed) RFQ in history | link to list that hides it |
| Order placed, provider silent 12 h | "Waiting on provider" | Warning: auto-cancel in 12 h | nothing |
| Auto-cancel at 24 h | Refund amount + timeline | Told they lost it and why | buyer only, no amount |
| Buyer silent after delivery | Countdown + 24 h warning before auto-accept | "Buyer has N h" | provider notified after the fact |
| Revision requested | Revisions left shown | Note shown, revisions left | neither |
| Payment dismissed / failed | Retry resumes same session | — | new session each time |
| Double-click accept on two quotes | Blocked with message | — | two paid orders possible (P0-5) |
| Dispute opened | Status, next step, SLA | Same | raise not reachable (buyer) |
| Dispute resolved | Outcome + refund amount | Outcome + payout effect | no notice |
| Payout held | — | Reason + expected date | bare "Held" |
| Payout failed | — | Notified + fix bank CTA | silent |
| Provider suspended | Active orders: status explained | Reason + appeal path | silent |
| KYC approved/rejected | — | Notified with reasons | silent |
| Account deletion requested | Export offered; what is retained & why | Same + open orders/payouts block | not possible |
| Phone number changed | Re-verify; sessions revoked | Same; payouts re-checked | not possible |
| Shared device sign-out | All cached data cleared | Same | cache persists (P0-6) |

---

## Suggested sequencing (one PR each, in order)

1. **Security hotfix** — P0-1/2/3/6/10/12: column guard on `users.roles` (REVOKE UPDATE (roles) +
   trigger), `messages` split into insert/select only, `order_events` party insert restricted to
   allowed event types with `actor_id = auth_user_id()`, `audit_logs` append-only, SW cache purge on
   sign-out + stop caching authenticated navigations, redact detector internals from user-readable
   payloads; add every case to `verify-authz.ts`.
2. **Money correctness** — P0-4/5: Razorpay open on quote accept; one checkout session per RFQ
   (idempotency key per RFQ, server-side guard), refund path for a losing paid order; payment.failed
   recorded; checkout resume.
3. **Legal truthfulness** — P0-7/8/9/11: privacy copy (AI processors, WhatsApp media, rights
   mechanism), WA media purge, suspension enforcement, KYC stored as path + sign on read, grievance
   form + table + SLA.
4. **Dead-ends** — P1 buyer/provider list (dispute raise, cancel-after-accept, requirements capture,
   provider quote thread, inbox history tabs, withdraw quote, capacity pause, KYC loop, Telugu save).
5. **Clocks & notifications** — countdown chips + the edge-case matrix notices; SMS live; mobile push.
6. **Read-back & reuse** — P2.1–P2.3 (order chat, AI activity page, WhatsApp thread, repost/duplicate,
   history tabs, search, exports).
7. **Data rights** — ADR for anonymisation + retention matrix, export/erasure endpoints, purge cron.
8. **Provider money & practice** — statements, hold reasons, bank change, availability.
9. **Ops tooling** — user lookup, support timeline, case model, admin-decision notices, observability.
10. **Mobile functional parity**.
11. **Agent memory** (P2.4) — §8.1 + ADR, dark, after the 25-order gate.

---

## Status after PR #15 (2026-09-23)

**Fixed in this PR** (code + regression checks where a harness exists; nothing run against the live DB):
P0-1 (0042 users guard) · P0-2, P0-3, P0-10 mutability (0043: messages read-only, no client order_events
inserts, append-only audit_logs, msme_profiles owner read-only) · P0-4 (quote accept opens Razorpay behind a
confirm) · P0-5 (stable idempotency key per quote + server one-checkout-per-RFQ guard; a racing duplicate is
flagged for an ops refund, never auto-refunded on a repurposed transition) · P0-6 (no caching of pages/API
data, cache purge on sign-out) · P0-7 (privacy copy discloses AI processors + WhatsApp media, version bump) ·
P0-8 (suspension enforced, `/account-suspended` screen) · P0-9 (KYC stored as paths, signed on read) · P0-10
audit insert errors logged · P0-11 grievance `mailto:` · P0-12 (injection event payload redacted).
Buyer P1: cancel after accept · raise dispute · requirements form + both parties see them · invoice uses the
checkout GSTIN · refund amount/status shown · repost with edits (`?from=`) · payment-held first view.
Provider P1: payout hold reasons · quote thread on web + role-aware links · RFQ inbox history tabs (won/lost/
expired) · withdraw quote · revisions-left · capacity pause refuses package checkout · pending_kyc loop ·
Telugu kept on save. Notifications: te/ta copy with en fallback, RFQ/quote expiry, auto-cancel (provider),
auto-accept (buyer), insert errors logged. Ops: buyer lookup by phone/email/GSTIN, provider search sanitised,
heartbeat panel covers agent crons, handled 500s reach Sentry.

**Still open** (each needs its own PR; several need an §8.1 entry or ADR first):
- In-order chat after payment; unified inbox; message attachments/read state.
- "AI activity" page (ai_decisions / munshi drafts / agent runs for the user); WhatsApp thread view.
- DPDP export + erasure (anonymisation ADR — NO ACTION FKs + append-only tables), retention matrix + purge cron,
  WhatsApp media retention schedule (FOUNDER_FILL).
- Grievance case model with 24 h / 15 d SLA clocks (S2.3 `support_tickets` covers support escalation, not
  statutory grievances); admin one-page user timeline; admin-decision notifications to users.
- Notification preferences, live SMS, mobile push; payout-failed / suspension notices.
- Change phone / email, sessions list, account linking, account deletion.
- Provider statements (monthly/annual, commission GST invoices, 194-O TDS), bank-account change flow,
  availability/vacation, team logins (account-model ADR), review flag button + new-review notice.
- Search over own records, pagination on buyer/provider lists, exports (scope PDF, CSV).
- `DISPUTABLE_STATUSES` lists accepted/requirements_submitted but `ORDER_TRANSITIONS` has no edge to
  `disputed` from them (§3.7 says "any-pre-completed → disputed") — reconcile via ADR.
- ~~GST on "GST-included" services quotes: checkout adds 18 % on top — money decision, ADR.~~ **Fixed 2026-09-23 (ADR-015):** an included quote is charged exactly its price; excluded and unstated are unchanged.
- Automatic refund of a duplicate RFQ order needs a dedicated state (ADR) — today it is flagged for ops.
- Suspended buyers currently also lose READ access to past orders/invoices (fails safe; decide if they keep it).
