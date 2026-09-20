# Follow-ups — logged, not built

Items deliberately deferred during pre-cutover hardening. Each entry says what
exists today, what is missing, and what would unblock it. Remove an entry when
it ships.

## Agent S0.3 — services evidence engine (2026-09-20)

Services orders now record staged milestones with photo proof
(`accepted → site_or_materials → in_progress → work_complete`); `work_complete`
delivers the order; the payout release gate gains a services branch
(`evaluateServicesReleaseGate`) held behind the `evidence_required_from`
cutover. Migration 0028 (NOT staged) tightens `order_milestones` RLS to
parties-read + service-role writes. Contract verified (verify-evidence 13/13);
web build green; gate wiring mirrors the proven goods path.

Deferred / notes:
- **Mobile timeline + capture** — the plan lists mobile; the web card ships now.
  Add a Milestones section to `apps/mobile/app/(app)/orders/[id].tsx` (mobile
  parity, `docs/MOBILE_PARITY.md`). Inert until then; nothing mobile breaks.
- **Buyer photo thumbnails** — the card shows a "📷 photo" badge; wiring the
  signed-URL thumbnail (reuse the documents list) is a polish follow-up.
- **Cutover proxy** — enforcement compares `order.created_at` (when placed) to
  `evidence_required_from`, not the quote/package `created_at` the prompt names.
  Simpler, always present, monotonic; revisit if the founder wants listing-time
  semantics.
- **Full seeded lifecycle** — verify-evidence checks the pure machine/gate + the
  structural columns (read-only, zero residue). The end-to-end
  placed→…→completed→payout-held run belongs in the acceptance harness (needs a
  seeded provider/buyer/admin); not run here to avoid prod writes.
- **evidence_required_from is null on prod** — the gate is inert until the
  founder sets a date at /admin/agents; the milestone capture UI is live.

## Agent S0.5 — WhatsApp rails (2026-09-20)

Landed: the `agent-core/src/whatsapp` adapter (`meta_cloud` / `interakt` /
`stub` drivers, template registry, opt-in keywords, recorded-fixture tests);
`whatsappHandler` in the web dispatcher sends approved templates only when a
real driver is configured AND (active whatsapp grant OR always-allowed
transactional kind) — otherwise `stub` / `skipped:no-opt-in`; migration 0030
(`wa_conversations`, `wa_messages`); the runtime webhook + `wa.inbound` job
(START/JOIN/vernacular → whatsapp grant for the user matched by phone; STOP →
revoke; else a holding reply at most once per 24h); the profile-page WhatsApp
section with the wa.me START deep link. Everything stays inert: the driver is
`stub` until credentials exist, replies are gated on the runtime's
`AGENT_ENABLED`, and the web section is gated on `AGENT_ENABLED`.

Deferred / notes:
- **Founder tasks to go live** (docs/PRE_LAUNCH_CHECKLIST.md 1.3): BSP/Meta
  account + number, submit the template names listed there for approval, set
  the driver env on web + runtime, point the vendor webhook at the Fly URL.
- **Media upload for outbound** (`sendMedia` needs a public URL): the Meta
  upload flow is not wired; inbound media download IS.
- **Mobile**: no mobile settings screen yet (S0.2 note) — deep link is web only.
- **Interakt webhook auth** is a shared-secret header (no HMAC upstream);
  documented in WHATSAPP.md.
- **Template copy** for `wa_opt_in_confirmed` / `wa_opt_out_confirmed` /
  `wa_holding_reply` is written at BSP submission time (names reserved here).

## Agent S0.4 — trust mechanics (2026-09-20)

Landed: quote cap as config (`rfq_max_quotes`, unset = legacy 7 so prod is
unchanged until set); quote-or-decline (`POST /api/v1/rfq/[id]/decline`,
`rfq_matches.declined_at/decline_reason`, cron auto-decline `window_lapsed`
after `quote_window_hours` + buyer notification, inbox "Declined" badge,
score view treats declines as decisions); Udyam verified chip
(`udyam_verifications` mirror of 0021, `POST /api/v1/kyc/verify-udyam`,
boolean set only from a real non-stub result, chips on cards/storefront/compare);
Responsiveness sort on compare (no new data). Migration 0029.

Conflicts / deferred:
- **`match_declined` in quote_events** — the plan asks for it, but
  `quote_events.quote_id` is NOT NULL and a declined match has no quote row.
  The CHECK is widened for forward-compat; the source of truth is
  `rfq_matches.declined_at` (the plan's own column) and the score view reads
  it. No quote_events row is written for a match decline.
- **Cutover proxy**: `evidence_required_from` (S0.3) compares against
  `orders.created_at`, not the quote/package created_at — simpler, monotonic,
  present on every order.
- **Mobile parity**: Decline button, Udyam chip and Responsiveness sort are web
  only this stage (docs/MOBILE_PARITY.md).
- **Surepass Udyam response shape** is mapped defensively (enterprise_name /
  name_of_enterprise, two date keys); confirm against a real key before
  enabling the paid path.
- **verify-trust "real path" branch** needs the server started with
  `KYC_FAKE=verified` (never in prod); skipped otherwise.
- **Window sweep ships DARK** (`quote_window_hours` default null, founder call
  2026-09-20): the plan said default 48, but that would auto-decline every
  open RFQ's >48h-silent matches and email buyers on the first cron run after
  deploy. Set 48 in /admin/agents to turn it on; the cron sweep is a no-op
  until then. verify-trust's cron branch runs only with CRON_SECRET and
  without SKIP_CRON (it would sweep real prod matches from a dev box).

## Agent S0.2 — admin console + grants UI + kill switch (2026-09-20)

Landed the founder console at `/admin/agents` (spend today/month + AI share of
commission, per-agent enable toggles, budgets/cohort/consent-version editor,
runs table + detail drawer, one-tap kill switch) and the user grant toggle on
the web MSME + provider profile pages. All admin/ops-gated, `agentApiGate` first,
dark behind `AGENT_ENABLED`. Verified: web build green; HTTP inertness 14/15
(every `/api/v1/agent/*` incl. admin 404s with the flag off).

Deferred:
- **Mobile grant UI** — there is no mobile profile/settings screen today (grants
  are inert while dark, and the WhatsApp opt-in grant arrives via S0.5, not a
  mobile screen). Logged as mobile parity; add the section when the mobile
  profile screen lands (see `docs/MOBILE_PARITY.md`).
- **Spend sums in JS** over the window (`/api/v1/agent/admin/spend`, cap 20k
  rows) — fine at pilot scale; replace with a Postgres aggregate RPC before
  invoice volume grows.
- **admin_agents strings are English-only in hi/te** — deepMerge falls back to
  en (the repo's standard for admin surfaces); `agent_grants` (user-facing) is
  translated to Hindi, and Telugu falls back per te.json's partial-locale policy.
- **Flag-ON admin authz matrix** in verify-agents (buyer→403, unknown key→422,
  kill audited) needs a seeded admin session; the flag-off inertness + no-auth
  401 run everywhere.

## Agent S0.1 — core + runtime + token exchange (2026-09-20)

Landed the agent programme's code foundation, all dark (`AGENT_ENABLED=false`):
`@amclub/agent-core` (gateway, prompt registry, untrusted Envelope, ledger,
budget, runtime credential, runner), `apps/agent-runtime` (Hono + pg-boss on
Fly `bom`), the token-exchange endpoint + delegation grants + runs/decision
routes, per-tool scope on the five wrapped routes, and migration 0027 (lifts
`ai_decisions` out of staged Mart 0022 into an always-applied ledger; adds
`agent_settings` + `agent_grants`; `agent_runs.parent_run_id`/`job_id`).

Deferred to their stages / founder tasks (not built here):
- **Fly deploy is not run** — needs `FLY_API_TOKEN`, `SUPABASE_JWT_SECRET`,
  `AGENT_RUNTIME_SECRET`, LLM key, Upstash (see `docs/agents/RUNTIME.md`,
  `docs/COMPLIANCE.md`). CI's `agent-runtime.yml` is a no-op until the token is set.
- **Migration 0027 apply** is the founder-gated deploy step (RULES.md 2): apply
  to prod with the writer push. `verify-migrations` shows `agent_settings` +
  `agent_grants` MISSING until then; `ai_decisions` already exists on prod so
  0027's `CREATE … IF NOT EXISTS` no-ops it.
- **gateway `vision()`** (multimodal) is not implemented yet — arrives with
  `document_extract`/`photo_plausibility` (S0.3/S1). `chatJson` uses JSON mode +
  Zod; strict `json_schema` is wired but optional (`jsonSchema` param).
- **Prompt loading in the Vercel functions** uses `registerPrompt`; the fs
  loader (`loadDefaultPrompts`) is used by the runtime/eval only — Next tracing
  of `.md` files is revisited when the first bounded call registers a prompt.
- **`postgres` was not added to agent-core deps**: the ledger uses the Supabase
  service-role client (matching web), so the raw driver was unnecessary.
- **verify-agents HTTP flag-ON positive path** needs a seeded user +
  `AGENT_RUNTIME_SECRET` + `AGENT_VERIFY_USER_ID`; offline + flag-off inertness
  run everywhere.

## Mart-prep hardening sprint — closeout (2026-09-05)

Three gated phases readied the services spine to host AMC Mart (a goods mode,
to be built as a flag-gated dark build) without touching working services code.
**S1 — spine hygiene** (commit `6a44bd7`, migration 0019): order_events is now
append-only (trigger + REVOKE) like the other event tables; order-document
`kind` is an allowlisted enum (no client text in storage keys); setup-storage
recreates the `public-assets` bucket (DR drift fixed); `verify-migrations.ts`
preflight added; the admin verifications route uses the standard
requireAdmin + rate-limit gate. **S2 — Mart step-0 pre-land** (commit
`47456eb`, migrations 0020/0021): additive `kind` discriminator on
orders/checkout_sessions with the trust view kind-scoped (byte-identical for
services, proven); `gstin_verifications` persists every KYC attempt server-side
plus an admin `attest_gstin` action; `MART_ENABLED` flag + a shared
`ProfileMeResponse` deliver the flag to mobile. **S3 — Telugu engineering**
(commit `d88459c`): `te` is a first-class UI locale (`SUPPORTED_LOCALES`, kept
separate from `PROVIDER_LANGUAGES` spoken data) end-to-end — enums, notification
resolver (en fallback), RFQ `label_te`, mobile locale + en-deep-merge + picker,
Expo Noto Telugu font, and a `verify-te-render` assertion suite; the ~1,400
strings themselves are a separate translation workstream (below). All three
verified against the live build (authz 116/0, money-loop 33/0, rfq 13/0,
migrations 0 missing, te-render 25/0, zero residue). No Mart surface was built —
that starts fresh with DESIGN.md + FRONTEND.md.

## AMC Mart M0 — dark build landed (2026-09-05)

M0 (MART_DESIGN.md §7) is built behind `MART_ENABLED` on branch
`claude/new-github-repo-setup-ax25ub`: shared vocabulary + money math + state
machines, staged migration 0022, `/api/v1/mart/*`, web surfaces (buyer,
seller, admin, goods order workspace), mobile Mart tab. Evidence and the
§1 discrepancy list: `docs/mart/SPINE_VERIFICATION.md`. Open items from it:

- **Run the live suites** — `scripts/verify-mart.ts` (M0 acceptance; needs a
  server with 0022 applied + `MART_ENABLED=true`) and `verify-mart-inert.ts`
  + the four standard suites against prod (flag off). Not runnable from the
  build sandbox (no Supabase). Deploy-blocking for the Launch Gate.
- **`audit_logs` is append-only by convention only** — no `BEFORE UPDATE`
  trigger / REVOKE (MART_DESIGN.md §1 claims DB-level). One-line migration
  reusing `raise_append_only()`; services table, so a services phase.
- **Fresh-bootstrap helper ordering** — FIXED (bootstrap prelude +
  Supabase default-grant emulation in the shim); remove from the list above.
- **Catalog Agent voice leg** — the wizard takes photos + typed description;
  hook the Sarvam recorder (`VoiceRfqRecorder` is RFQ-specific today) so the
  description can be spoken (FRONTEND.md §7).
- **Goods notification copy** — goods actions reuse the nearest services
  notification copy (`NOTIFY_AS` in `goods-transitions.ts`); write goods
  copy (dispatched / delivered photo / return) in en/hi/te.
- **Goods score-inputs view** (MART_DESIGN.md §4.5) — sibling of
  `provider_score_inputs_v1` over goods events (on-time dispatch, delivery
  confirmation, return rate) with the ≥3/≥5 gates. Events are emitted; the
  view is not yet written.
- **Provider-addendum goods schedule** — `LEGAL_VERSIONS.provider_addendum`
  bump with the goods disclosure text (Launch Gate item 4; counsel).
- **Founder decisions §9.1–9.5** — encode in `mart_categories` /
  `mart_settings` (+ ADR): pool invoicing model, return windows + return
  freight, goods commission, M1 pool categories + seed sellers, warranty
  pass-through language.
- **M1 pools** — tables + block-and-capture (report-first PSP verification),
  Group-Buy Agent, WhatsApp pool cards; the state machine + capture predicate
  are already in `packages/shared/src/mart/pools.ts` (tested).
- **Mobile `tsconfig` strictness** — extends `expo/tsconfig.base`, not the
  repo base; consider adding the four strict flags.

## AMC Mart M1 — group buys (pools) landed (2026-09-06)

M1 (MART_DESIGN.md §7) is built behind `MART_ENABLED` on branch
`claude/mart-m1-pools` (stacked on the M0 branch until PR #1 merges). Decision
record: `docs/adr/006-pool-pay-on-close-per-member-orders.md`; PSP report:
`docs/mart/PSP_BLOCK_CAPTURE_REPORT.md`.

**What landed**
- Migration `0023_mart_pools.sql` (STAGED with 0022): `pools` (with a `draft`
  status before the §4.4 machine), `pool_members` (`blocked | captured |
  released | failed`, delivery snapshot, checkout session + order links),
  `pool_events` (append-only), `buyer_pool_discipline_v1`, six `mart_settings`
  keys (`pool_payment_mode`, `pool_pay_window_hours`, `pool_order_model`,
  `pool_categories`, `pool_schedule_day_of_month`, `pool_open_limits`).
- `packages/shared/src/mart/pools.ts`: schemas, open validation, progress /
  saving math, pay deadline, leave rule, discipline factor (≥3/≥5 gates),
  WhatsApp card copy in en/hi/te. 80 shared tests green.
- `apps/web/lib/mart/pools.ts` owns every transition and the one money rule
  (`mayCapturePoolMember`): draft → approve/open → join / change / leave →
  close (met/unmet) → member checkout at the pool price (deterministic
  idempotency key per member) → settle (captured / failed) → ordered →
  fulfilled. Cron `/api/v1/cron/pool-close` hourly (vercel.json) — inert while
  the flag is off.
- Group-Buy Agent v1 (`lib/mart/group-buy-agent.ts`): drafts from 30-day goods
  demand + monthly schedule; prices = the seller's own bulk tier; optional
  OpenRouter polish for title + vernacular pitch (stub without key). Documents
  Agent v1 (`lib/mart/documents-agent.ts`): invoice summary, e-way bill Part A
  data, payout advice from the order record; admin confirms → `ai_decisions`.
- Screens: `/mart/pools`, `/mart/pools/[id]` (+ OG card image, WhatsApp
  share, join island), "Buy together" strip on `/mart`, `/app/mart/pools`,
  `/app/mart/pools/[id]/pay`, `/partner/goods/pools`, admin pools worklist +
  documents panel. Mobile: pools list, pool detail with join/leave/pay.

**Verified (local rig, 2026-09-06)**
- `killtest-mart-pools.ts` 16/16 (append-only, constraints, RLS cross-tenant
  = 0 rows, seller allocations only after close, discipline view).
- API lifecycle (`pool-lifecycle.js`) 37/37: agent → draft → approve with
  edits → join / change / leave / re-join → close now (met) → pay (simulate)
  → settle → ordered; replays (close, checkout, settle) create nothing twice;
  unmet pool releases members and refuses checkout; Documents Agent draft +
  confirm.
- Expiry / capture-fail (`pool-expiry.js`) 12/12: cron closes expired pools
  met/unmet; lapsed pay window → `failed`, pool with zero captures →
  cancelled; a lapsed member can never capture; discipline counts the default.
- `killtest-mart-schema.ts` still 21/21; shared tests 80/80; typecheck/lint/
  build green.

**Open**
- Block-and-capture: refused at join until the PSP checklist in the report is
  signed off (founder + Razorpay). `pool_payment_mode` is config.
- §9.1 / §9.4 defaults (per-member orders; fasteners, welding consumables,
  abrasives) await founder confirmation — both are `mart_settings` edits.
- Spec-only pools (`product_id` null) are stored but cannot open; awarding a
  seller at close is M2 work if wanted.
- Pool-met "group Paisa Moment" variant not built; the pool page uses the
  gold-edge card + stamp.
- WhatsApp channel is still the stub; the card text is ready for the
  Gupshup/Interakt template once the key exists.

## AMC Mart M2 — goods RFQ landed (2026-09-06)

> **Incident 2026-09-09 (fixed same day).** M2's services read paths named the
> staged 0024 columns (`rfqs.kind/mart_category_slug/goods_spec`, quote goods
> terms) in select strings. Prod lacks them → PostgREST 42703 → null data:
> fan-out matched nobody, buyer RFQ list and compare view were empty, provider
> matched list was empty, quote→order 404'd. Caught by `verify-rfq.ts` against
> prod (2/12) after the H0 push; `verify-mart-inert.ts` had only run on a rig
> WITH 0022 applied, so it could not see it. Fix: `lib/mart/staged-columns.ts`
> fragments (empty while the flag is off) + `mart:static` guard. Open: run
> `verify-mart-inert.ts` against a DB WITHOUT the staged migrations, and run
> the four services suites against prod after every Mart merge (was skipped).

M2 (MART_DESIGN.md §7) is built behind `MART_ENABLED` on branch
`claude/mart-m2-goods-rfq`: bulk / spec goods requests ride the existing RFQ
engine as `rfqs.kind='goods'` (ADR-007). Landed:

- **Schema (migration 0024, STAGED with 0022/0023):** `rfqs.kind`,
  `mart_category_slug` (FK), `goods_spec`; `category_id` nullable for goods only
  (`rfqs_kind_shape_check`); `quotes.unit_price_paise/qty/gst_rate_bps/hsn_code/product_id`
  with `quotes_goods_terms_check` (all-or-nothing, `price_paise = unit × qty`).
- **Server:** goods branch of `POST /api/v1/rfq` (404 when the flag is off,
  Mart category validated, BIS-blocked refused); goods fan-out to in-state
  goods sellers (listing-in-category first); goods quote route recomputes
  `price_paise`; `lib/mart/goods-rfq.ts` turns an accepted quote into an
  ordinary goods checkout session (line + delivery snapshot + category
  commission) — webhook → `materialize_order` → release gate → `payout.ts`
  unchanged. Compare-screen money (GST, incl., after ITC) computed in
  `lib/rfq/queries.ts`.
- **UI:** `/app/mart/rfq/new` (Mart category, item, spec rows, qty + unit,
  target unit price, dictation, delivery prefilled from
  `/api/v1/mart/delivery-defaults`, listing prefill via `?product_id=`);
  entry points on the product page and the empty catalogue state; buyer
  detail with the spec card and a unit-price / GST / after-ITC compare row;
  seller composer goods mode (unit price, GST slab, HSN, optional listing,
  qty); goods badges on both inboxes; mobile goods mode on create, buyer and
  seller RFQ screens. i18n en/hi/te (web) and en/hi (mobile).
- **Verification:** `packages/db/src/scripts/killtest-mart-goods-rfq.ts`
  (0024 constraints) and an API lifecycle killtest (fan-out to sellers only,
  server-computed price, accept → `orders.kind='goods'` with frozen line +
  delivery, replay refused, services RFQ/quote unchanged) — numbers in
  docs/mart/SPINE_VERIFICATION.md §4c. `apps/web/scripts/verify-goods-rfq.ts`
  is the founder-environment version (creates its own users; zero residue).

**Not now (M2 scope):**
- Multi-line goods RFQs (one item per request) and drawing attachments on
  goods RFQs — the spec rows + free text cover the launch categories.
- Seller-side "quote from listing" auto-pricing from tiers (the listing only
  prefills HSN/GST today; price is typed).
- Goods RFQ voice parse (dictation appends to the free text only; no LLM
  parse into item/qty/spec).

---

## AMC Mart — Launch Gate readiness landed (2026-09-06)

Branch `claude/mart-m3` (Launch Gate, not M3 — M3 is traction-gated per
MART_DESIGN.md §7 and stays unbuilt until post-launch numbers). Landed:

- **§9 decisions as config:** `/admin/mart/settings` (registry-validated
  `mart_settings`, per-category return window / return-freight payer /
  commission / BIS / active / sort), audited; migration 0025 (STAGED)
  `mart_categories.return_freight_payer`; product page shows the freight note.
- **Addendum goods schedule (Launch Gate 4):** sections 6–8 + version
  `2026-09-06` render and bump only when `MART_ENABLED=true`
  (`effectiveLegalVersions`); public `/api/v1/legal/versions`.
  DRAFT FOR COUNSEL — docs/COMPLIANCE.md row.
- **Ops tooling:** `pnpm --filter @amclub/web mart:preflight | mart:smoke |
  mart:acceptance` + `docs/mart/LAUNCH_RUNBOOK.md` (flip + rollback).
- **Verification:** docs/mart/SPINE_VERIFICATION.md §4d (M0 suite ran on the
  rig for the first time: 57/57; inert 45/45 after fixing a real leak — Mart
  pages returned 200 + 404 UI with the flag off because group-level
  `loading.tsx` streams before a page `notFound()`; Mart subtrees now sit in
  `(mart-*)` route groups whose layout gates first).

**Not now / needs the founder:**
- Staging Supabase project for the preview acceptance run (Launch Gate 1) —
  the rig proves the suites, not the deploy.
- Counsel sign-off on addendum sections 6–8 (§9.5) before the flip.
- Founder's §9 values (entered in the preview's settings screen, re-entered on
  prod after migrations apply — see runbook step 3.4); CA's TDS section/rate.
- Seed sellers (founder's plant + 2–3 distributors) and the Kurnool pilot
  buyer list; live Razorpay keys + webhook registration (services cutover
  item, shared).
- M3 (courier API, ONDC catalog, benchmark pricing, vision QC) — traction-gated.

---

## Mart M0 review fixes + load-path optimisation — closeout (2026-09-06)

The design review (Mart M0 vs FRONTEND.md, competition, density/flow) was
worked in full, with load performance first. Commits `9b16a6a` → `76a0aaf`
on `claude/new-github-repo-setup-ax25ub`.

**Measured (Lighthouse 12, mobile, local production build on the seeded rig;
simulated 4G, median of 3 runs after; single baseline run before):**

| Page | Perf | LCP | FCP | Bytes | Fonts | JS |
|---|---|---|---|---|---|---|
| /mart | 80 → 92 | 4.7 s → 3.4 s | 2.4 s → 1.2 s | 619 → 354 KB | 313 → 39 KB | 242 → 215 KB |
| /mart/p/[id] | 72 → 93 | 4.1 s → 3.1 s | 1.7 s → 1.1 s | 625 → 335 KB | 313 → 39 KB | 252 → 218 KB |
| /services | 85 → 97 | 4.2 s → 2.5 s | 1.7 s → 1.1 s | 515 → 333 KB | 209 → 39 KB | 249 → 206 KB |

Under real DevTools throttling (4G + 4× CPU) the after build paints the
largest element at **1.8 s on /mart and the product page, 1.6 s on
/services, CLS 0.000**. The simulated-mode LCP above is pessimistic: Lantern
ties the text paint to the web-font request because `font-display: optional`
lets the font win on an unthrottled trace; in the field the fallback paints
first and no swap happens. Product-page CLS 0.288 → 0.002.

**What moved the numbers (apps/web):**
- Fonts: Google's Noto Sans keeps `₹` (U+20B9) in its 98 KB Devanagari
  subset, and the header's हिं/తె/த chips plus a literal `'Noto Sans
  Devanagari'` Tailwind fallback pulled 165–285 KB more on English pages. Now
  a 1.9 KB self-hosted `₹`/`₨` face (`app/fonts/noto-sans-rupee.woff2`, Noto's
  own outlines, variable weight) sits first in the font stacks, chips use
  `.font-system`, all faces are `display: optional`, and no web-font family
  name appears as a fallback. Fonts per English page: 39 KB.
- Preload hints: next/font's font preload and React's `preconnect()` never
  reached the HTML head on this app (only the RSC payload). The root layout
  now renders real `<link>` elements (`components/shell/ResourceHints.tsx`,
  hrefs from `lib/fonts/preload-hrefs.ts`), so the body font is in the first
  HTML bytes.
- ProductGrid is a server component; `LoadMore` is the only client island.
- posthog-js (68 KB gz) loads after `load` + idle or on the first `capture`
  (buffered); Sentry Session Replay lazy-loads from Sentry's CDN after idle
  (CSP `script-src` now lists `browser.sentry-cdn.com`).
- Chunking: Next merges the root page's client manifest into every `[locale]`
  route (route groups are stripped), so the gateway wizard (11 KB gz) was
  loaded on /mart and /services. The wizard is now an async client chunk
  (`GatewayLazy`), and shared header/providers get one named `shell` chunk.
- `martRise` animates transform only; the opacity fade held the largest
  element invisible and added ~1.2 s of measured LCP.
- Earlier in the sprint (9b16a6a): ISR on /mart, /mart/c/[slug] and the
  product page with on-demand `revalidateMart`, next/image with fixed boxes,
  sharp resize on upload, skeletons, lazy Supabase client in AccountMenu.

**Review findings closed (8c6872f, 5d1e561):** reorder from a completed goods
order; checkout prefilled from the last delivery snapshot / MSME profile;
sticky action bar + real IST dates on the goods order workspace; brand, price
band, seller filters and price sort; search autosuggest; MOQ and lead time on
cards; seller trust line, spec block, availability and WhatsApp share on the
product page; Paisa Moment on first order view / payout paid; gold count-up;
17/26 body type on Mart screens; voice dictation + brand/specs in the listing
wizard; goods on the provider storefront; offline evidence-upload queue with
retry chips; 44 px targets on breadcrumbs.

**Open (not done here):**
- The mobile app has not had the same font/analytics pass (Expo bundles
  differently; no web fonts involved).
- `(provider)/layout` still contributes a 1.9 KB chunk to public pages for
  the same manifest-merge reason as the gateway; acceptable, noted.
- /services CLS 0.09 appears in one of three simulated runs (footer shift on
  a fast font arrival); 0.000 under real throttling. Re-check on Vercel with
  Speed Insights before treating it as real.
- A real-throttling "before" could not be produced: the pre-sprint build's
  catalogue fetch fails inside a worktree on this rig. The simulated numbers
  above are same-method before/after.

## Incoming developer — open items

Each is deferred with intent, not forgotten. One-line scope; details in the
dated sections below where present.

- **Settlement webhooks + money journal** — reserved for you; NOT touched by
  S1–S3. The live-Razorpay cutover (ADR-003) and a double-entry money journal
  are the biggest remaining money-path work.
- **CI-driven migration apply** — retire hand-apply; a protected deploy step
  (Supabase CLI `db push`) with the DB credential as a CI secret, making
  RULES.md rule 2 mechanically enforced. (Section below.)
- **Fresh-bootstrap helper ordering** — FIXED 2026-09-05 (Mart M0): bootstrap
  runs policies.sql's helper-function section as a prelude. (Section below
  kept for history.)
- **0013/0014 policies.sql drift** — `ai_invocations`/`cron_heartbeats` enable
  RLS inline but were never mirrored into policies.sql (service-role-only, zero
  policies, so harmless today); mirror for consistency.
- **Scratch-project storage killtest** — `setup-storage.ts` was proven
  idempotent against prod; verify a from-zero Supabase project creates all four
  buckets with correct public flags (pairs with the stale restore-drill).
- **readiness-flip notification** — when a provider becomes payout-ready
  (Route id + verified bank), nothing notifies them; today it only surfaces
  passively in `/admin` and their dashboard banner.
- **Mobile lint warning** — one unused eslint-disable directive (0 errors);
  remove next time mobile is touched. (Section below.)
- **Telugu translation workstream** — ~1,400 leaf strings (web ~1,065 + mobile
  286 + RFQ `label_te` + notification te slots) need native translation +
  review, incl. the 73-key legal namespace (qualified review). The engineering
  is done (S3); this is non-code. Add pages to `TE_ASSERTED_PAGES` in
  `verify-te-render.ts` as their te keys land. `ta` remains gateway-only until a
  Tamil cluster is scheduled.
- **Live-cutover checklist** — see `docs/adr/003-simulate-mode-in-production.md`
  (KYC vendor key, Route activation, every active provider payout-ready).

## Agent groundwork (H0) — open items (logged 2026-09-08, ADR-008)

Landed: ADR-008, DESIGN.md §8.6, `@amclub/shared` `agent.ts` (personas, tool
allowlists, confirm gates, task classes → tiers, event kinds) + agent-run state
machine, migration 0026 (`agent_runs`, append-only `agent_events`, nullable
routing/token columns on `ai_invocations`), `lib/agent/router.ts` (voice
parser now routed; default unchanged), `AGENT_ENABLED` flag (OFF, no surface),
authz §4e. 0026 was applied to prod on 2026-09-09 before this deploy (additive). Deferred, each its own PR:

- **Agent runtime service** — long-running host (sockets, tool loops, the
  pg-boss worker ADR-001 deferred). Needed by the first H1 feature; cannot
  run on Vercel functions.
- **Token exchange `POST /api/v1/agent/token`** — short-lived scoped JWT
  (claims in ADR-008 §3); needs `SUPABASE_JWT_SECRET` as a server env var.
  No consumer until the runtime exists.
- **Distributed budgets** — per-user daily compute budget in Upstash (the
  in-process limiters are per-instance); `agent_runs` carries the counters.
- **Retrieval** — `pgvector` extension + embedding columns on packages, help,
  legal and order documents; ingestion job for uploads (needs the worker).
- **Consent ledger** — purpose/source/timestamp per ingested feed, before any
  account-aggregator or GST-portal integration (H6).
- **`ai_decisions` (Mart) vs `agent_events` (H0)** — Mart records every
  human-confirmed AI proposal in `ai_decisions` (refs only); H0 records the
  same moment as an `agent_events` row of kind `confirmed`. Two ledgers for
  one concept. Reconcile when the runtime lands: either the runtime writes
  `ai_decisions` for confirmations (and `agent_events` stays the trace), or
  Mart's agents move onto `agent_runs`. Decide before A1 ships.
- **A2 governance** — buyer agent with tools stays at the §8.2 V1.5→V2 gate;
  negotiation protocol needs an explicit §8.3 amendment.

---

## Quote withdrawal (provider) — no UI, no route (logged 2026-08-27, Phase 1f)

**Today:** `quotes.status` supports `withdrawn` (state machine + `quote_events`
CHECK constraint + `provider_score_inputs_v1.quotes_withdrawn`), but **no code
path writes it** — there is no withdraw route and no UI affordance. A provider
who no longer wants to honour a quote can only let it be auto-declined or
expire, which the score view counts as *silence*, not an active decision.

**Needed:** `POST /api/v1/quotes/[quoteId]/withdraw` (provider-owned, only
from `submitted`, releases the RFQ quote slot via `release_quote_slot`, writes
`quote_events` `withdrawn` with the provider as actor + optional reason), a
"Withdraw quote" action on `/partner/rfqs`, and buyer notification. Decide
whether withdrawal after a buyer message should be allowed.

**Why deferred:** Phase 1 scope was event capture for statuses that already
have writers; adding a provider-facing action is product scope.

---

## Real penny-drop vendor — LIVE-CUTOVER BLOCKER (logged 2026-08-27, Phase 1g)

**Today:** `penny_drop_verified` is server-set from `/kyc/verify-bank`; the dev
stub (no `KYC_API_KEY`) never counts. Genuine providers therefore land at
`bank_unverified` and are cleared by the admin `set_bank_verified` override
(reason required; `audit_logs` + `bank_account_verifications` with
`provider = 'admin_override'`, always distinguishable from a vendor result).

**Hard edge:** the override is fine while onboarding is manual. It must not be
the norm at real-money volume — provision Surepass/Signzy (`KYC_API_KEY`)
before live cutover. Tracked in ADR-003's cutover procedure.

---

## KYC vendor integration (Surepass/Signzy) — scope (logged 2026-08-28)

**Today:** `lib/kyc/surepass.ts` exists behind `KYC_API_KEY`; without a real
key the stub answers and never counts as verified. **Needed:** provision the
key, confirm the GSTIN + bank penny-drop endpoints against the sandbox, record
vendor request/response ids in `bank_account_verifications.result`, and add a
kill-test that a vendor *failure* leaves `penny_drop_verified=false`.
**Estimate:** 1–2 days once the account exists. Live-cutover blocker.

---

## Linked-account API automation (Razorpay Route) — scope (logged 2026-08-28)

See `docs/ROUTE_ONBOARDING.md` → "Follow-up". `accounts.create` →
`stakeholders.create` → `products.request` → document upload at admin
approval, storing the `acc_…` via the existing `set_route_account` action so
audit + readiness stay unchanged. Failures surface as *not ready*, never as a
fake id. ~2–3 days incl. test-mode Route sandboxing.

---

## Refund / transfer settlement webhooks + money journal — Phase 5 remainder (logged 2026-08-28)

**Today:** `refunds.status='processed'` and `payouts.status='paid'` are set
when the API call returns, not when Razorpay settles; the webhook handler
ignores `refund.*` and `transfer.*` events (Phase 0 §0d). **Needed:** handle
`refund.processed` / `refund.failed` / `transfer.processed` / `transfer.failed`
idempotently (same raw-body HMAC path), and add an insert-only `money_journal`
(payment_captured, refund_created, refund_settled, transfer_created,
transfer_settled, commission_earned) so the escrow balance is reconstructible
at any timestamp from our own tables. Additive; `payout.ts` remains the only
money-out path. ~3 days + a replay kill-test per event type.

---

## Provider Addendum — add the fee-bearing sentence at the next version bump (logged 2026-08-28, ADR-004)

Queue for `legal.provider_addendum_s1_p` (or a new §6) when
`LEGAL_VERSIONS.provider_addendum` is next bumped: *"You receive your full
quoted amount minus only AMC's 5% commission. All payment gateway charges are
borne by AMC."* Provider-favourable, so no urgency and no forced re-acceptance
now; it is already shown on `/partner/earnings` and `/help`.

---

## Route transfers: payment-linked vs direct, and live-mode account ids (logged 2026-08-28, pre-cutover money check)

**Today:** `lib/payments/razorpay.ts` calls `transfers.create({ account, amount })`
— a *direct* transfer from the platform's settled balance, **not** linked to
the buyer's payment. Consequences at cutover: (1) transfers before Razorpay
settles the payment (T+2/T+3) fail with insufficient balance; (2) the
escrow story ("held by the payment partner") is only literally true with
payment-linked transfers (`payments.transfer(paymentId, { transfers })`),
which draw from the captured amount and honour Route's F1/F2 rules.
**Founder decision needed** before switching: payment-linked transfers
(recommended; requires threading `razorpay_payment_id` into `createTransfer`
and keeping the transfer-then-refund order already adopted) vs staying direct
(needs a balance-aware retry). Either way `payout.ts` stays the only path.

**Account ids:** nothing in code assumes live-mode ids (the only check is the
`acc_` format), but Razorpay linked accounts are **per mode** — an `acc_`
created in test mode does not exist in live mode. Any test-mode id stored in
`provider_bank_accounts.razorpay_route_account_id` must be replaced with the
live-mode id at cutover (transfer would fail loudly otherwise; readiness
cannot tell the two apart). Added to `docs/ROUTE_ONBOARDING.md` checklist.

---

## Notification abstraction for WhatsApp (Gupshup/Interakt) — scope (logged 2026-08-28)

**Today:** `lib/notifications/channels.ts` has SMS (MSG91, not billed until
go-live), email (Resend) and an in-app channel; WhatsApp is a stub behind
`WHATSAPP_API_KEY`. **Needed:** one `sendTemplate(channel, template, vars)`
abstraction with per-channel adapters and DLT/WhatsApp template ids in config,
delivery-status callbacks recorded per notification, and a sandbox-delivered
template as the done-criterion (§6 Phase 6). ~2 days after template approval.

---

## CI-driven migration apply — protected deploy step (logged 2026-09-05, Phase S1; scoped for incoming developer)

**Today:** migrations 0001+ are hand-applied via the Supabase SQL Editor (or
apply-sql.ts with DATABASE_URL); nothing in CI or the Vercel build touches the
database. verify-migrations.ts (S1.4) detects an unapplied migration but cannot
prevent one.

**Needed:** a protected deploy step (Supabase CLI `db push` or equivalent)
running the pending migrations with the DB credential held as a CI secret,
retiring hand-apply. Makes RULES.md rule 2 — "migrations deploy with their
writers, same push" — mechanically enforced instead of procedural. Must keep
the idempotent-SQL convention (re-runnable files) and gate on the default
branch + production environment only.

**Why deferred:** credential handling + pipeline design deserve their own
review; hand-apply with the S1.4 preflight is safe at current cadence.

---

## Fresh-bootstrap ordering: inline migration policies use policies.sql helpers (logged 2026-09-05, Phase S2)

**Today:** 0017 and 0021 create RLS policies inline that call auth_user_id()
and has_role(), but those helper functions are defined in rls/policies.sql,
which bootstrap.ts runs AFTER all migrations. On prod this is moot (helpers
have existed since Phase 1); on a truly fresh bootstrap the inline policies
would fail before policies.sql runs. Pre-existing pattern (0017); 0021
follows it for consistency rather than forking mid-phase.

**Needed:** move the two helper definitions into an early migration (or a
0000-adjacent bootstrap-prelude file) so migrations are self-sufficient; or
have bootstrap.ts create the helpers in its shim step. Verify with a scratch
bootstrap run (pairs with the stale restore-drill item).

---

## Agent S1.4 — Payout-Evidence agent (logged 2026-09-20)

**Shipped dark:** `payout_dossiers` + `evidence_photo_hashes` (migration
**0031** — the prompt said 0030, but 0030 is the S0.5 WhatsApp rails in this
tree; codebase numbering wins), the ops `read_order_evidence` tool, the
evidence read, the runtime agent on queue `agent.payout_dossier`, the founder
one-tap on `/admin/payouts` + `/admin/orders/[id]`, the `/admin/agents`
tile, and `verify-payout-dossier.ts`. Runbook: `docs/agents/PAYOUT_DOSSIER.md`.

- **WhatsApp one-tap arrives with S0.5.** The founder notification is by kind
  (`payout_dossier_ready`, channels email + whatsapp). S0.5 is in this tree
  (unpushed at the time of writing) and the template
  `amc_payout_dossier_ready_{en,hi}` is registered in
  `agent-core/whatsapp/templates.ts`; delivery needs the BSP/Meta credentials,
  template approval (PRE_LAUNCH_CHECKLIST 1.3) and the founder's own START opt-in.
  Until then the kind reaches in-app + email.
- **Cohort applies to the ops user.** The trigger requires `ops_user_id` to be
  in `cohort_user_ids` (registry semantics: "empty = no one"). The S1.4 prompt
  listed only the grant + `ops_user_id` + `agents_enabled`; documented in the
  runbook bootstrap. Revisit if a "system agents ignore cohort" rule is wanted.
- **Approve is refused to any delegated token.** `requireNotDelegated` on the
  release route and the hold route 403s a token carrying `amc_persona` — not
  just a scoped one — because no tool wraps an admin mutation (ADR-008 §4).
- **`notified_at` column** (not in the prompt's column list) backs the
  idempotent notify route; additive.
- **Observed live cost per dossier** is not recorded yet (no LLM key here);
  fill the runbook table after the first ten live dossiers.
- **Duplicate detection is per provider, cross-order only.** Hashes are stored
  from the moment the agent first runs; photos uploaded before enablement are
  not back-hashed. A backfill job (hash every existing evidence photo) is a
  small follow-up if re-use across old orders matters.
- **Vision eval live threshold** (≥ 80 % on synthetic fixtures) has not been run
  with a key; run `pnpm --filter @amclub/agent-core eval --set photo_plausibility`
  with `OPENROUTER_API_KEY` before enabling for a cohort and iterate the prompt
  if it fails.
- **Runtime image needs sharp's musl build.** `sharp@0.34.5` is a runtime
  dependency; `pnpm install` on `node:22-alpine` pulls
  `@img/sharp-linuxmusl-x64`. If the Fly build ever lacks it, add
  `RUN apk add --no-cache libc6-compat` or switch the base to `node:22-slim`.
- **Mobile parity:** no dossier surface in `apps/mobile` (admin-only; the founder
  works from web). The notification deep link opens the web panel.
- **pg-boss archive** keeps job payloads (order/payout ids only, no PII) per its
  default retention; fine for now.
