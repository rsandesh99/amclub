# MUNSHI.md — Digital Munshi v1, the provider's sales clerk (S2.2)

**Status:** built 2026-09-22, dark. Ships behind `AGENT_ENABLED` (web + runtime) **and**
`agent_settings.agents_enabled.munshi` **and** `cohort_user_ids` **and** a per-provider grant the provider
creates by tapping Enable. Flag off: no cron work, no scan, no partner tab (404), the quote routes are
byte-identical. Migration **0040** (NOT staged; applied to prod before the writer deploys).

## What Munshi does — and never does

Every 15 minutes (`cron/agent-munshi-scan` → runtime `munshi.scan`) Munshi opens one run per enabled
provider, reads their newly matched requests **under the provider's own delegated token** (the matched list,
each RFQ with its clarifications, the provider's price book), and for each new match drives ONE child run
(`munshiDraftAgent` in `@amclub/agent-core`) that drafts **a quote with its price basis, ONE clarifying
question, or a skip with a reason**, persists the proposal in `munshi_drafts`, and PARKS on `submit_quote` /
`ask_clarification` (both `confirm:true`). The draft is delivered as WhatsApp buttons inside the 24 h window
(a template outside it) and as an in-app notification (`/partner/munshi`, the mobile screen).

The provider approves on WhatsApp (button), on the web, in the app, or with a voice note that matches the
allow-list. Approve = the surface posts the run's proposed payload **unchanged** to
`POST /api/v1/agent/runs/[id]/decision` (ONE `ai_decisions` row, feature `munshi_draft` / `munshi_reply`);
the runner resumes and the **ordinary** quote / clarification / message route runs under the delegated
token — the same route the provider would call by hand. Edit = the provider's own composer, prefilled
(`/partner/rfqs/[id]?munshi=<draftId>`); the submit carries `munshi_draft_id`, the draft becomes `edited`
and the parked run is declined. Skip declines the run.

Hourly (`cron/agent-munshi-followup` → `munshi.followup`): stale drafts expire (24 h TTL), approvals whose
runtime ping did not land are resumed, a **window warning** goes out once per match when the
quote-or-decline window (`quote_window_hours`) lapses within `munshi_followup_hours_before_lapse`, a
**reply draft** is proposed when a buyer's message on the provider's quote thread has waited ≥ 2 h
(`munshiReplyAgent`, `reply_thread`, feature `munshi_reply`), and an open `ask` whose clarification was
answered expires so the next scan re-drafts.

**Never:** invents a price (see the band), sends anything without the provider's tap, writes
`provider_profiles` / `quotes` / `orders` (the writes audit fails the build), talks to a buyer on its own,
reads user data through the service role (only `munshi_*`, `provider_capability_facts`, `wa_*`, grants and
the ledgers), or approves through a model.

## The three laws (code, not prompt)

1. **No price history, no price.** `clampMunshiDraft` (shared): a `quote` needs ≥ 1 `provider_price_book`
   row in the RFQ's category (`services`); its price must lie in `munshiPriceBand()` = `[min, max]` of the
   basis rows (accepted first, then newest, ≤ 5) widened by `munshi_price_tolerance_bps` (default 2500 =
   25 %). Outside → the draft becomes an `ask` with a fixed per-locale question, never an adjusted number.
   Goods RFQ → skip. Already quoted / window lapsed → skip without a model call. A provider with no history
   seeds the book with one manual row (`POST /api/v1/partner/price-book`, source `manual`) or quotes once by
   hand (`recordPriceBookEntry`); `finalizeQuoteAcceptance` marks the winner `accepted_at`.
2. **Every read and write goes through `/api/v1` under a scoped provider grant.** `MUNSHI_SCOPES` =
   `extract_requirements` (GET /rfq/matched, GET /rfq/[id]) · `read_price_book` (GET /partner/price-book) ·
   `draft_quote` · `submit_quote` · `ask_clarification` · `reply_thread` · `list_deadlines`. The token
   carries the union of the provider's active grants' scopes; the routes gate with `requireToolScope`; the
   runner refuses a tool outside the grant in-process (`tool_out_of_scope` → the draft is `failed`, the
   provider is told).
3. **Voice approves only by allow-list.** `isUnambiguousYes(transcript, locale)` — an exact match after
   normalisation against `MUNSHI_YES_PHRASES` (≤ 6 words; en / hi / te / ta, Latin and native script). The
   `approval_intent` classifier (a child run, no tools) can only **re-ask, treat the note as edit
   instructions, or reject**; a model `approve` is treated as unclear and the buttons are re-sent.

## Enablement bootstrap (nothing runs until all are true)

1. `AGENT_ENABLED=true` on the web deploy and the runtime.
2. `agents_enabled.munshi = true` and the provider's user id in `cohort_user_ids` (`/admin/agents`).
3. `budget_run_paise_by_agent.munshi` (launch 1000 = ₹10); the three settings
   `munshi_price_tolerance_bps` (2500), `munshi_max_drafts_per_day` (20), `munshi_followup_hours_before_lapse`
   (6); `quote_window_hours` set for warnings (null = no warnings).
4. The provider taps **Enable** on `/partner/munshi` (or the app): a web grant with `MUNSHI_SCOPES` and a
   consent snapshot (`text_version = munshi-v1-2026-09-22`); an existing WhatsApp grant (S0.5 START) is
   widened to the same scopes — one consent screen, two channels. STOP on WhatsApp revokes the WhatsApp
   grant (delivery stops; web drafts continue); Disable revokes the web grant and returns the WhatsApp grant
   to `[]`.
5. The runtime is deployed with the four templates approved (`docs/PRE_LAUNCH_CHECKLIST.md` §1.3):
   `munshi_draft`, `munshi_window_warning`, `munshi_reply_draft`, `munshi_result` (en / hi / te).

## Tables (0040)

`munshi_drafts` (`kind` quote | ask | skip | reply; `status` proposed → approved | edited | skipped |
expired | failed; `draft`, `basis`, `run_id`, `decision_id`, `result_ref`, `delivered`, `expires_at`; one
OPEN draft per (rfq, provider)), `munshi_provider_state` (scan cursor, IST daily counter, pause, locale,
`munshi_reminders`), `provider_price_book.accepted_at / deleted_at / source` (+ `source_quote_id` nullable
for manual rows; `accepted_at` backfilled from accepted quotes), `quotes.munshi_draft_id`,
`ai_decisions_feature_check` += `munshi_reply`. RLS: provider reads own, admin reads, no client writes.

## Phase 2 exit metric

`GET /api/v1/agent/admin/munshi/stats` (console tile): among providers with an accepted quote in the last
30 days, the % whose accepted quote carries `munshi_draft_id` — target ≥ 50 % — plus this week's counts
(proposed / approved / edited / skipped / expired / failed / quotes accepted), providers enabled, and cost
per approved draft (`munshi_drafts.model_cost_paise`).

## Metrics (PostHog)

`munshi_enabled / munshi_paused / munshi_disabled` · `munshi_draft_proposed { kind, action, confidence,
has_basis }` · `munshi_draft_decided { via: whatsapp_button | voice_yes | whatsapp_text | web | mobile |
run | composer | system, outcome, kind }` · `munshi_reminder_sent` · `munshi_reply_proposed` ·
`munshi_price_book_row_added / _deleted`.

## Live evals (gate before any cohort)

`pnpm --filter @amclub/agent-core eval -- --set quote_draft` (≥ 85 % + every injection case; every case
drives the agent definition through the harness), `--set approval_intent` (≥ 85 % + injections; the
allow-list law is asserted in both modes), `--set thread_reply` (≥ 85 % + injections), and
`--set injection` must stay green (the three prompts are targets: 202 case × prompt pairs).

## Rollback

Disable for one provider: Disable on the tab (grants revoked; drafts stay readable). Disable for everyone:
`agents_enabled.munshi = false` (the scan enumerates nothing; the crons keep heart-beating). Kill switch:
`AGENT_ENABLED=false` (every surface 404s; the runtime refuses every job). Migration 0040 is additive;
no row is written while the agent is off.

## Known limits (FOLLOWUPS S2.2)

Provider-set price hints, revise-quote drafts after a clarification answer, skip notices, reading
capability facts through a route, Interakt buttons, the mobile composer prefill, and the items the tree
forced — see `docs/FOLLOWUPS.md` "Agent S2.2".
