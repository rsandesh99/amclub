# SCORE.md — AMC Score v1: a private, two-sided reliability score (S2.4)

**Status:** built 2026-09-23, dark. Decision record: **ADR-010** (`docs/adr/010-amc-score-v1.md`) — read it first;
it holds the addendum check. Every surface is behind a registered `agent_settings` switch that defaults **off**:
`score_compute_enabled`, `score_card_enabled`, `reliability_rank_enabled`, `growth_nudge_enabled`. Flag off: no
score rows are computed, no card, and compare orders by price exactly as before. Migration **0044** (NOT staged;
applied to prod before the writer deploys).

## What it is — and is not

A **deterministic, explainable 0–100 score** per provider and per buyer, computed nightly from verified transaction
events only. **Pure code** (`packages/shared/src/score.ts`, `SCORE_VERSION = 'v1'`): no model, no reviews, no free
text. The provider sees their own score with its components and "how to raise it" tips; **buyers never see any
number**; admins see both sides.

**Never an input:** review stars or text, message or statement text, model output, demographics, location or state,
price level or quote amounts, category, company size, language, badges, time on the platform.

## Components, curves, weights (v1)

90-day rolling window, services only (`orders.kind = 'service'`, RFQs with a `category_id`).

| side | component | weight | definition | curve |
|---|---|---|---|---|
| provider | `responsiveness` | 25 | median hours, match notification → quote | ≤ 2 h → 100 · 24 h → 50 · ≥ 72 h → 0 |
| provider | `on_time` | 25 | first `deliver` ≤ `due_at` | on-time ÷ delivered |
| provider | `buyer_confirmation` | 20 | `accept_delivery` vs auto-accepted | (confirmed + ½ auto) ÷ completed |
| provider | `dispute_record` | 20 | disputes resolved `refund_full` / `refund_partial` | 100 − min(100, at-fault ÷ closed × 400) |
| provider | `decision_rate` | 10 | quoted or declined with a reason | ÷ decided-or-closed matches (`window_lapsed` = not decided) |
| buyer | `confirmation_speed` | 30 | median hours `deliver` → `accept_delivery` (auto = 72 h) | ≤ 24 h → 100 · ≥ 72 h → 0 |
| buyer | `follow_through` | 30 | closed RFQs with quotes that ended accepted or had quotes explicitly declined by the buyer | ÷ closed RFQs with quotes |
| buyer | `dispute_record` | 20 | disputes the buyer raised resolved `release` | 100 − min(100, unfounded ÷ closed × 400) |
| buyer | `payment_follow_through` | 20 | checkout **subjects** paid (a session `materialized`) | ÷ subjects paid or all-expired |

A component with no sample is `null`; its weight redistributes proportionally. **Sample gates:** provider ≥ 3 closed
orders **and** ≥ 3 response samples; buyer ≥ 2 closed RFQs with quotes **and** ≥ 1 closed order. Below the gate the
score is `null` (the components still accrue). *Closed* = completed / reviewed + `resolved_*`.

## The version rule

Component definitions, curves, weights and gates are **code**. Any change is `v2`: a parallel compute
(`provider_scores` is keyed by `(subject, score_version)`), a comparison on the admin tile, a founder switch. Only the
exposure switches and the ranking constants are settings. (Until `score_compute_enabled` has first been on in
production, a correction is a v1 amendment — ADR-010 §5.)

## Exposure matrix

| who | provider score | buyer score |
|---|---|---|
| the provider | own only — `GET /api/v1/partner/score` + the dashboard card (mobile parity) | never |
| a buyer | never a number or component; at most an order + one fixed line | never (not their own) |
| admin / ops | admin provider page, `/api/v1/admin/score/provider/[id]`, the stats tile | admin MSME page, `/api/v1/admin/score/buyer/[id]` |
| public | never (a public score is S4.2, provider opt-in) | never |

RLS: a provider reads their own `provider_scores` / provider rows of `score_history` / `score_events`; buyer rows are
admin / ops only; no client writes anywhere. `score_events` is **append-only** (the `raise_append_only` trigger).
`verify-score.ts` sweeps every buyer-reachable route and `public_providers` for any score field (`scoreFieldPaths`).

## Reliability-adjusted ordering (compare)

Only with `reliability_rank_enabled`, ≥ 2 quotes and the largest normalised total ≥
`reliability_rank_threshold_paise` (₹25,000), services only. Server-side, in `lib/score/ordering.ts`:

    adjusted = total × (1 000 000 + k × (100 − s)) ÷ 1 000 000      s = score ?? score_null_prior (60), k = reliability_rank_k_bps (1500)

k is the penalty in basis points **at a score of 0**: score 90 → +1.5 %, 60 → +6 %, 40 → +9 %, 0 → +15 %. Prices shown
are unchanged. The response carries `ordering: { mode, ids }`, never a score; the screen shows "Ordered by price,
adjusted for each provider's delivery and dispute record on AMClub. Sort by price instead" and price is one tap away.
S1.2 pointers never talk about ordering (`COMPARE_ORDERING_PHRASES`, pointer-only). ADR-010 §9 (e) is confirmed with
conditions (see the enablement order). **A provider with no history ranks as the neutral prior, never as 0.**

## The coaching note (the one model call)

`score_note@v1` (routine): only for a Munshi-enabled provider (`AGENT_ENABLED` + `agents_enabled.munshi` + cohort).
Input = the score, component values and weights, the weakest keys — numbers only, **no untrusted slot**. Output ≤ 280
characters, wrapped by `customerFacingText` (contact / payment / ranking / approval / urls) + the promise list, and
checked by `scoreNoteProblems` (no number that was not in the input). Cached per provider per IST day on
`provider_scores.note`; any failure → `note: null` and the deterministic tips alone. No `ai_decisions` row.

## The Munshi growth nudge (weekly; no model)

`cron/agent-munshi-growth` (`0 5 * * 1` UTC) → runtime `munshi.growth`: for Munshi providers (grant + cohort) with
`growth_nudge_enabled`, at most one a week (`munshi_provider_state.last_growth_at`), one nudge in priority order —
(1) an incomplete profile field (read from `/profile/me` under the provider's token), (2) a category with ≥ 3 unmatched
requests in their state in 30 days that they do not list (an aggregate count; no buyer identity), (3) the weakest
component's tip **when that component is below 70**, (4) a score rise of ≥ 5 this month. Fixed copy
(`munshi-growth.ts`), WhatsApp template `munshi_growth` (only with the WhatsApp grant — STOP halts it) + in-app
`munshi_growth` via `POST /api/v1/agent/munshi/growth` (runtime credential). No confirm, no `ai_decisions`.

## Appeal path

A provider raises a support ticket (S2.3) citing a component. Ops opens the admin provider page: the snapshot, every
component's raw counts, and the last score events show exactly what moved. A wrong underlying event (for example a
mis-recorded dispute resolution) is corrected through the existing admin paths; the score is never hand-edited — the
next nightly run recomputes it.

## Enablement order

1. Migration 0044 applied; `verify-migrations` shows it present.
2. `score_compute_enabled = true` for **two weeks**; review the distribution, the gated share and the movers on the
   agents-console tile. Adjusting anything now is a v1 amendment only if no v1 score has been shown to anyone.
3. `score_card_enabled = true` — providers see their own.
4. `reliability_rank_enabled = true` — ADR-010 §9 (e) is **confirmed with conditions** (2026-09-23): the provider card's
   ranking line (shown from day one), the buyer's track-record line + re-sort by price / delivery, the public statement
   of the ranking parameters on `/help` (**counsel confirms the E-Commerce Rules clause and wording first**).
5. `growth_nudge_enabled = true` — with Munshi live for a cohort; the `amc_munshi_growth_*` templates approved.

## Rollback

Switch the settings off. The snapshots are inert rows that no route shows while the switches are off; compare returns
to price ordering immediately. 0044 is additive; dropping it needs the code reverted first (the card, compare and
growth code read its tables).

## Metrics

PostHog: `score_card_viewed { computed, gated, has_note }` · `compare_ordering { rfq_id, mode, quote_count, reordered }`
· `compare_sort_changed { from, to }` · `munshi_growth_sent { kind, whatsapp, in_app }`. Admin tile: distribution per
side (10-point buckets), gated share, median, this week's biggest movers.

## Verify

`BASE_URL=http://localhost:3100 VERIFY_CRON_SECRET=<server CRON_SECRET> [AGENT_RUNTIME_SECRET=<throwaway, same as the server>] pnpm --filter @amclub/web trust:verify:score`

## Live evals

```
pnpm --filter @amclub/agent-core eval --set score_note --live    # ≥ 90 % and 0 policy violations
pnpm --filter @amclub/agent-core eval --set injection --live     # score_note pairs check the output policy only
```
