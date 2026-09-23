# ADR 010 — AMC Score v1: a deterministic, private, two-sided reliability score

**Status:** Accepted, 2026-09-23 (BUILD_PROMPTS S2.4). Touches ranking (the compare
screen's order) and the provider addendum §2 (counsel-owned copy). Written before
any code. Everything it enables ships dark behind registered `agent_settings`
switches that default off; the ranking switch additionally waits for the
founder's confirmation of §9 (e) below.

## Context

Moat 3 is trust you can measure. The provider addendum already promises it, in
counsel-owned words (`legal.provider_addendum_s2_p`, `LEGAL_VERSIONS.provider_addendum
= '2026-08-28'`):

> "The platform computes a public reliability score for every provider from verified
> transaction events: how quickly you respond to requests, on-time delivery, completion
> confirmations by buyers, and dispute outcomes. These are the factors; the formula
> itself is not published. Your score accrues from your first order. You can see your
> own score before it is shown to buyers."

and §3 (`provider_addendum_s3_p`): "Buyers are rated too, on objective service levels
such as confirming delivery on time and payment behaviour, so that reliability is
measured on both sides of every order."

The raw counts already exist: `provider_score_inputs_v1` (0016 → 0020 → 0029; all-time,
services only; consumed by `cron/provider-stats` for `median_response_minutes`). Reviews
exist too (`reviews.rating` → `avg_rating` on the public profile). What does not exist is
a score, a place to keep it, a rule for who may see it, and a rule for how it may affect
what a buyer sees.

## Decision

### 1. Pure code over verified events — nothing else is an input

The score is a function in `packages/shared/src/score.ts` over counts computed in SQL
from rows the platform itself wrote when something verifiably happened: a match
notification, a quote row, an order event (`deliver`, `accept_delivery`,
`auto_accepted`), an order status, a dispute resolution, a checkout session becoming
`materialized` (the payment webhook). **No model, no reviews, no free text.**

**Never an input:** review stars or text (subjective; they stay exactly as they are on
the public profile), any message or statement text, any model output, demographics,
location or state, price level or quote amounts, category, company size, language,
verification badges, time on the platform. A provider is not scored for being cheap
or expensive, only for doing what they said they would.

### 2. Window, services only, one row per subject

A **90-day rolling window** (`SCORE_WINDOW_DAYS`): each count is anchored on the event
that closes it (a quote's `created_at`, the first `deliver` event, `completed_at`, a
dispute's `resolved_at`, a match's `notified_at`, a session's `created_at`). Old
behaviour ages out; one bad quarter does not follow a provider for ever.

**Services only** (`orders.kind = 'service'`, RFQs with a `category_id`, checkout
sessions of kind `service`). Goods scoring waits for the Mart Launch Gate (FOLLOWUPS).

Two new `SECURITY INVOKER` SQL functions, `score_inputs_provider(p_since)` and
`score_inputs_buyer(p_since)`, return the windowed counts; `EXECUTE` is granted to
`service_role` only. `provider_score_inputs_v1` and `cron/provider-stats` stay
byte-identical.

### 3. Components, curves and weights (v1)

All values are 0..100. A component with zero sample is `null`, and its weight
redistributes proportionally over the non-null components. Arithmetic is integer where
it can be and rounded once, at the end.

**Provider** (`PROVIDER_WEIGHTS_V1`, sum 100):

| component | weight | definition (window) | curve |
|---|---|---|---|
| `responsiveness` | 25 | median hours from match notification to the quote | ≤ 2 h → 100 · 24 h → 50 · ≥ 72 h → 0, linear between the knots |
| `on_time` | 25 | first `deliver` event ≤ `due_at` (no `due_at` counts as on time, as the v1 view does) | on-time ÷ delivered × 100 |
| `buyer_confirmation` | 20 | completed orders confirmed by the buyer (`accept_delivery`) vs auto-accepted after 72 h | (confirmed + ½ × auto-accepted) ÷ completed × 100 |
| `dispute_record` | 20 | disputes resolved against the provider (`refund_full` / `refund_partial`) | 100 − min(100, at-fault ÷ closed × 400) — one fault in four closed orders = 0 |
| `decision_rate` | 10 | matches the provider decided: quoted, or declined with a reason | (quoted + declined-with-reason) ÷ decided-or-closed matches × 100; a `window_lapsed` auto-decline counts as not decided |

*Closed orders* = completed / reviewed + `resolved_refund` / `resolved_release` /
`resolved_partial`. The prompt wrote "completed"; a refunded dispute never reaches
`completed`, so dividing by completed alone would over-weight faults. *Decided-or-closed
matches* excludes a match that is still inside its open window, so a provider is not
marked down for a request they may still answer.

**Buyer** (`BUYER_WEIGHTS_V1`, sum 100):

| component | weight | definition (window) | curve |
|---|---|---|---|
| `confirmation_speed` | 30 | median hours from the first `deliver` event to `accept_delivery`; an auto-accepted order counts as 72 h | ≤ 24 h → 100 · ≥ 72 h → 0, linear |
| `follow_through` | 30 | closed RFQs that received ≥ 1 quote and ended `accepted`, or where the buyer explicitly declined quotes (`declined_by = 'buyer'`) | ÷ closed RFQs with ≥ 1 quote × 100 |
| `dispute_record` | 20 | disputes the buyer raised that were resolved `release` (unfounded) | 100 − min(100, unfounded ÷ closed orders × 400) |
| `payment_follow_through` | 20 | checkout subjects (a package or a quote) where some session `materialized`, vs subjects whose sessions all expired unpaid | paid ÷ decided × 100 |

Payment is counted **per subject, not per session**: a buyer whose first UPI attempt
failed and whose retry paid is not penalised for the retry. Sessions still inside
`expires_at` are undecided and excluded.

**Sample gates** (`SAMPLE_GATES_V1`): provider needs ≥ 3 closed orders **and** ≥ 3
response samples; buyer needs ≥ 2 closed RFQs with quotes **and** ≥ 1 closed order.
Below the gate the whole score is `null` (`gated = true`); the components are still
computed and stored, so the provider can see what is accruing.

### 4. Null is neutral, not zero

A `null` score ranks as `score_null_prior` (setting, default 60): a new provider is
neither buried below an established one nor boosted above them. The provider's own card
shows "not enough orders yet: N of 3 completed", never a number.

### 5. The version rule

`SCORE_VERSION = 'v1'`. Component definitions, curves, weights and gates live in code.
**Any change to inputs, curves, weights or gates is `v2`**: computed in parallel
(`provider_scores` is keyed by `(subject, score_version)`), compared by the founder on
the admin tile, and switched by a founder decision. Only exposure switches, sample
thresholds for ranking and the ranking constants are settings. A settings-editable
formula would change scores without a version bump, which is exactly what this rule
exists to prevent.

*One exception, stated so it is not abused:* until `score_compute_enabled` has been
switched on in production for the first time, no v1 score exists anywhere, and a
correction to v1 (for example the founder or counsel overruling §9 (b)) is an
amendment to v1, not a v2.

### 6. Exposure: private first, never a number to a buyer

| who | provider score | buyer score |
|---|---|---|
| the provider | **own** only: score, components, weights, raw counts, tips, 30-day trend (`score_card_enabled`) | never |
| a buyer | **never a number or a component**; at most an ordering of quotes and one fixed explanation line (§7) | never, not even their own in v1 |
| admin / ops | all | all |
| public (profiles, search, `public_providers`) | never in v1 (a public score is S4.2, provider opt-in) | never |

Enforced three ways: RLS (the provider reads own rows; buyer scores are admin / ops
only; no client writes), the routes (the card 404s unless `score_card_enabled`), and a
verify-script assertion (`assertNoScoreFields`) over every buyer-reachable route.

### 7. Reliability-adjusted ordering

Only when `reliability_rank_enabled` is on, the largest normalised total is ≥
`reliability_rank_threshold_paise` (default ₹25,000), and there are ≥ 2 quotes. The
compare loader reads `provider_scores` server-side and orders by

    adjusted = normalizedTotal × (1 000 000 + k × (100 − s)) ÷ 1 000 000     (integer paise, rounded once)

with `s = score ?? score_null_prior` and `k = reliability_rank_k_bps` (default 1500): **k is
the penalty in basis points at a score of 0**, scaling linearly with the shortfall from
100. With k = 1500, a score of 90 adds 1.5 %, 60 (the neutral prior) adds 6 %, 40 adds
9 %, and 0 adds the full 15 %. Ties break by the normalised total, then by id (stable).

*Why not the prompt's `(10000 + k × (100 − s)) ÷ 10000`:* with the default k that adds
150 % at a score of 90 and 900 % at 40, so a ten-point score gap would outweigh almost
any price gap. That contradicts a bounded `k_bps` setting. The reading above keeps k in
basis points of price, which is what the setting's name and range say.

*Worked example:* A quotes ₹1,00,000 with score 90 → adjusted ₹1,01,500. B quotes
₹95,000 (5 % cheaper) with score 40 → ₹1,03,550. B is listed below A. The buyer still
sees both prices, unchanged. The response carries `ordering: { mode, ids }`, never a
score; the screen shows one fixed line, "Ordered by price, adjusted for each provider's
delivery and dispute record on AMClub. Sort by price instead", and the price sort is one
tap away. Below the threshold, with the switch off, or with fewer than two quotes, the
order is byte-identical to price ordering.

### 8. Appeal, retention, ledger

- **Appeal:** a provider raises a support ticket (S2.3) citing a component; ops sees the
  score events and the raw counts behind it on the admin provider page and can correct
  the underlying event (for example a mis-recorded dispute resolution) through the
  existing admin paths. The score itself is never hand-edited; the next nightly run
  recomputes it.
- **Retention:** `provider_scores` / `buyer_scores` hold the latest snapshot per
  `(subject, version)`; `score_history` holds one row per subject per day (pruning past
  13 months is a FOLLOWUPS job); `score_events` is **append-only** (no UPDATE / DELETE
  grants) and written only when a score moves by ≥ 1.
- **No `ai_decisions` rows:** nothing here is a human confirming an AI proposal. Scores
  are computed, and the coaching note is informational (the S1.2 pointers precedent).

### 9. Addendum check

**(a) "You can see your own score before it is shown to buyers" — holds.** In v1, no
buyer sees any provider's score at any time; the provider sees their own as soon as
`score_card_enabled` is on.

**(b) The four named factor families — holds, with one reading stated.** Responsiveness
maps to "how quickly you respond to requests", `on_time` to "on-time delivery",
`buyer_confirmation` to "completion confirmations by buyers", and `dispute_record` to
"dispute outcomes". `decision_rate` counts under **"how quickly you respond to
requests"**. The same addendum's §4 ("Responding to requests") defines responding as
answering within the response window (a quote or a decline), and says the platform
auto-declines for a provider who does not. A provider who lets a request lapse has, in
the addendum's own terms, not responded; a decline with a reason is a response. So the
copy needs no new word, and `decision_rate` keeps its weight of 10. If the founder or
counsel reads it differently, the fix before first enablement is `decision_rate = 0` as
a v1 amendment (§5), and the counsel question goes to FOLLOWUPS. The counsel-owned copy
is not edited in this stage either way.

**(c) "Your score accrues from your first order" — holds.** Components are computed and
stored from the first order in the window. The number is shown only past the sample
gate; until then, the card shows accrual progress ("N of 3").

**(d) "A public reliability score" — v1 is stricter than the promise, not in conflict
with it.** The addendum describes the eventual public score (S4.2, provider opt-in); v1
shows it to nobody but the provider and ops.

**(e) Is ordering quotes by an adjusted price "showing" the score to buyers? — decision:
no.** The buyer sees no number, no component and no label per provider; they see an
order and one generic sentence naming the factor families, with price one tap away.
That is using the score, which the addendum already contemplates ("public reliability
score"), not displaying it. **This is a reading, not a certainty:** the
`reliability_rank_enabled` switch stays off until the founder confirms it. If the reading
is rejected, the compute and the card still ship, and ranking waits for an addendum
revision through counsel.

**(e) — founder decision, 2026-09-23: CONFIRMED, with conditions.** Ordering quotes by a documented composite is
already in DESIGN.md §9.3 ("default sort = composite (rating, completion rate, response time, recency)"); showing the
score would be new ground, and v1 does not. The ranking switch may be turned on only when all of these hold:

1. **Provider side:** the provider's own score card says, from the day it is shown and before the switch is ever
   turned on, that on requests at or above the threshold their score can change where their quote appears (the
   `ranking_line` copy, with the threshold formatted from the setting — never a constant).
2. **Buyer side:** the fixed "ordered using track record" line stays visible while the reliability order is shown,
   and buyers can still re-sort by price or by delivery time (the compare sort control stays).
3. **Public statement:** the main parameters are named, without weights, on the public help page (`help.faq_ranking`)
   — the Consumer Protection (E-Commerce) Rules 2020 disclosure of the main parameters that determine ranking. Counsel
   confirms the exact clause and the wording before the switch (FOLLOWUPS S2.4).
4. **Sequence unchanged:** compute on for two weeks → review the distribution → the card → ranking.

**New providers are neutral, not bottom.** A provider with no history (no score row, or a gated `null` score) ranks
exactly as `score_null_prior` — never as 0 — so a brand-new provider in a thin cluster does not start at the bottom
(tested in shared and proven live in the rig with a provider that has no score row at all).

**(f) §3, buyers rated on objective service levels — holds.** `confirmation_speed`
("confirming delivery on time") and `payment_follow_through` ("payment behaviour") are
named there; `follow_through` and `dispute_record` fall under "such as". Buyer scores are
admin-only in v1.

## Consequences

- One nightly cron (`cron/score-compute`, `45 3 * * *` UTC, 15 minutes after provider-stats)
  writes snapshots, history and events; it is a no-op unless `score_compute_enabled`,
  and idempotent per day.
- The enablement order is fixed: compute on for two weeks and review the distribution
  on the admin tile → card on → ranking on, only after the founder confirms §9 (e).
- A formula change always costs a version, a parallel compute and a founder decision.
  That is deliberate friction.
- The one model call in the stage is the optional coaching note (`score_note@v1`), fed
  only numbers and component keys (no untrusted text) and output-policed. The Munshi
  growth nudge is fixed copy: no model, no confirm, no `ai_decisions` row.
- Rollback: switch the settings off. Snapshots are inert rows that no route shows while
  the switches are off; compare returns to price ordering immediately.

## Amendment A1 — individual measured stats may be public (PROPOSED, awaiting decision D1)

**Status:** Proposed, 2026-09-23 (Experience v3 E3, `docs/prd/PRD_EXPERIENCE_V3.md`
§6 E3 and §10 D1). Built dark; nothing changes for buyers until the founder decides
D1 and flips `agent_settings.public_stats_enabled`.

**Change.** §6 ("buyers never see a number") is narrowed, not dropped:
- Buyers MAY see a provider's **individual measured stats**, each with its own sample:
  on-time delivery % (first delivery ≤ `due_at`, 180 days), repeat-buyer % (buyers with
  ≥ 2 paid orders ÷ distinct buyers, 365 days), response rate (quoted or declined with a
  reason within 48 h, 90 days) and orders completed.
- Each stat shows only when **its own** sample reaches `public_stats_min_n` (default 10,
  floor 5 in code — settings can only tighten).
- Buyers still **never** see the composite AMC Score, its component weights, ranks or
  the reliability adjustment. `SCORE_FIELD_NAMES` stays out of every buyer payload; the
  public field names are a separate allow-list (`PUBLIC_STAT_FIELD_NAMES` in
  `@amclub/shared` `public-stats.ts`) and a shared test proves the two never overlap.

**Where.** The stats are stored nightly in `provider_public_stats` (migration 0049;
service role only, no client grant). Buyer payloads carry only `publicStatsView()` —
the gated projection — on result cards (one headline stat) and the profile (stat tiles).

**Why.** The survey (§4 of `docs/market/SURVEY_2026-09.md`) found every comparable
portal shows measured outcome stats, and our loop already computes them. A single
number invites gaming and hides its sample; separate stats with their samples don't.

**Rollback.** `public_stats_enabled = false` removes every stat from every surface on
the next request; the nightly rows stay inert.
