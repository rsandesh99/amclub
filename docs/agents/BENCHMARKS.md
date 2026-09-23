# BENCHMARKS.md — fair price ranges (S3.2)

> Built dark. Compute and display are two separate switches, both OFF by default. The optional explanatory sentence is
> a third lock (`AGENT_ENABLED` + `agents_enabled.benchmark` + the cohort). With everything off the pages, the API and
> the WhatsApp paths are byte-identical to before.

## What it is

On a services request, the buyer and every matched provider see the same line:

> Similar jobs in Telangana closed at ₹18,000–₹26,000, typically in 5–9 days (based on 34 paid jobs from 11 providers).

A small **How is this calculated?** disclosure sits under it. When a row doesn't exist, **nothing renders**: no empty
state, no "not enough data" message.

| Surface | Where |
|---|---|
| Buyer, web | `(msme)/app/rfq/[id]`: inside the compare section, above the table. It also shows before any quote arrives. |
| Provider, web | `(provider)/partner/rfqs/[id]`: in the request summary card |
| API | `GET /api/v1/rfq/[id]` carries `benchmark` **only when there is one** (strict `benchmarkViewSchema`, no ids). The optional note follows `x-amc-locale`. |
| Mobile | `rfq/[id]` and `partner-rfq/[id]` (`BenchmarkBlock`, the same shared `benchmarkLine`) |
| Not in v1 | The S3.1 WhatsApp three-line summary, Munshi's drafting band, and any per-quote "above / below range" chip |

**The model never produces or changes a number.** The line is fixed copy (`benchmarkLine` in `@amclub/shared`, in
en / hi / te / ta) with numbers that code computes nightly from paid orders.

## What counts as a closed job

"Closed" means **paid**. The function `benchmark_inputs(p_since)` returns one row per eligible order. An order is
eligible when:

- it is a services order: `orders.kind = 'service'`, and goods are excluded in v1
- it has a **captured** payment, which is the webhook's truth
- it was not cancelled, refunded or refund-resolved: status not in `auto_cancelled`, `cancelled_by_buyer`, `refunded`,
  `resolved_refund` or `resolved_partial`
- it was paid within the last **180 days** (`BENCHMARK_WINDOW_DAYS`)

How each fact is taken:

- **Price:** `orders.price_paise`, ex-GST, on the same basis for every row.
- **Category:** from the quote's RFQ, or from the package.
- **State:** the buyer's `msme_profiles.state`.
- **Delivery days:** the first `deliver` event minus the payment time, in whole days rounded up.

**Submitted quotes are never inputs.** They are asks, not prices, and a provider could move the range just by quoting.
The rig checks this on every run: quotes-only activity, and unpaid, cancelled, refunded, goods and out-of-window
orders, all contribute nothing.

## The gates, and why each exists

A row exists only when **all four** gates pass for its key:

| Gate | Setting (default) | Why |
|---|---|---|
| Jobs in the key | `benchmark_min_sample` (30) | A range over a handful of jobs is noise, and close to showing one job's price |
| Distinct providers | `benchmark_min_providers` (8) | No provider's own pricing can be read off the range |
| Distinct buyers | `benchmark_min_buyers` (8) | No buyer's own spend can be read off the range |
| Largest single provider's share | `benchmark_max_provider_share_bps` (2500 = 25 %) | One busy provider can't *be* the range |

The settings can only be **tightened**: the floor is 30 / 8 / 8 and the share cap can't exceed 25 %. The disclosure copy
states that floor, and so does the table's CHECK constraint (`price_benchmarks_gate_floor_check`). The gates are
checked in the order sample → providers → buyers → share. The nightly heartbeat records `gated_by_reason`.

The **delivery range** (the "typically in … days" clause) comes from the delivered subset **only when that subset
passes the same four gates by itself**. Otherwise the clause is left out, so a few deliveries can never be read off the
line.

## The formula (v1; `BENCHMARK_VERSION = 'v1'`)

- **Percentiles:** nearest-rank p25 / p50 / p75 on integer paise.
- **Rounding** (on the unrounded value; halves round up; never below one step):
  - to the nearest ₹100 below ₹10,000
  - to the nearest ₹500 below ₹1,00,000
  - to the nearest ₹1,000 above that
- **Monotonic:** `p25 ≤ p50 ≤ p75` is guaranteed. Rounding preserves order, because each step boundary is a multiple of
  both neighbouring steps, and it is also forced afterwards. A CHECK constraint restates it.
- **Keys:**
  - `(category, state)` for buyers with a state, plus `(category, national)` over everything.
  - `specialization` is part of the key but always null in v1, because RFQs don't carry it yet.
- **Scope fallback:** a request shows the buyer's state row; else the national row labelled "across India"; else
  nothing. Matched providers are in-state because of the services fan-out, so the state name tells them nothing new.
- **A formula change is a new version.** A new version's rows sit beside the old ones and are read only once the code
  asks for them.

## What is never shown

- No provider, buyer, order or quote id, name, contact or link. `price_benchmarks` has **no id column of any kind**,
  not even a surrogate key; its identity is the unique key (category, specialization, scope, state, version).
- No individual price, and no minimum or maximum. Only p25–p75 is shown; the median feeds only the optional sentence
  and the admin tile.
- No advice. There's no per-quote judgement. The optional sentence is policed:
  - every number in it must be one of the row's
  - an advice / judgement word in any locale rejects it (should, fair price, overpriced, cheap, negotiate, and their
    translations; `BENCHMARK_NOTE_BANNED`)
  - on top of that, the customer-facing contract rejects ranking, approval, payment, contact and URL language

## The optional sentence (`benchmark_explain@v1`)

- **Input:** trusted numbers only. There's **no untrusted slot**, and the red-team gate runs it on every `score_note`
  pair, 36 pairs, for its output policy.
- **When:** only for a viewer with `AGENT_ENABLED` + `agents_enabled.benchmark` + the cohort. The line itself never
  depends on the viewer.
- **Caching:** on the row, in `notes = { computed_at, by_locale }`. A recompute that changes the numbers clears it.
- **Failure:** on any failure or policy violation (budget, parse, the contract, the numbers rule) the fixed line
  renders alone.
- **No `ai_decisions` row**, because it's informational.
- **Golden set:** `golden/benchmark_explain.json`, 17 cases including 10 planted adversarial outputs. The live gate is
  ≥ 90 % and 0 policy violations, and it has to pass before `agents_enabled.benchmark` goes on for anyone.

## Compute

- **Cron:** `cron/benchmark-compute` at `15 4 * * *`, calling `apps/web/lib/benchmarks/compute.ts`.
- **No model:** the inputs, then `computeBenchmark` for each key, then `replace_price_benchmarks(version, rows)`.
- **One transaction:** a key that fell below a gate disappears **the same night**. Changed rows get a new
  `computed_at` and their cached note is cleared. Unchanged rows aren't touched, so a second run on the same day
  changes nothing.
- **Switch off:** a no-op unless `benchmark_compute_enabled` is on. The heartbeat still records the no-op, so `/admin`
  sees the cron alive.
- **Privacy:** the ids in the inputs never leave the function, and `benchmark_inputs` is executable by `service_role`
  only.
- **Admin review:** the agents-console tile (`GET /api/v1/agent/admin/benchmarks/stats`) shows the switches, the last
  run (keys, rows written, gated) and the table itself.

## Enablement order

1. Apply migration 0046. The rig and the manifest must be green.
2. **Compute on** (`benchmark_compute_enabled`). Review the table in the admin tile for **two weeks**. Check:
   - that the rows look like real prices
   - that no key is dominated by one provider (the share gate should be doing its job)
   - the gated counts
3. **Display on** (`benchmark_display_enabled`).
4. Optional: the sentence (`agents_enabled.benchmark` + cohort), after the live `eval --set benchmark_explain` gate
   passes.

With zero paid orders on prod today, no range will appear for a long while after launch. That is the intended
behaviour.

## Rollback

| To stop | Do this |
|---|---|
| Showing it | `benchmark_display_enabled` off: every surface stops rendering at once, and the API drops the field |
| Computing it | `benchmark_compute_enabled` off: the cron becomes a no-op; existing rows stay but nobody sees them |
| The sentence only | `agents_enabled.benchmark` off, or the kill switch |
| The code | revert. The table and functions are additive, so drop `price_benchmarks`, `benchmark_inputs` and `replace_price_benchmarks` only after the code is gone. |

## Verification

`pnpm --filter @amclub/web trust:verify:benchmarks` (`scripts/verify-benchmarks.ts`) runs offline, against a flag-off
server, and against a flag-on server. Fixtures live in the rig's own inactive test category. The compute is driven
in-process and restricted to that category. The cron route is never called with the switch on, because it would compute
every real category. Nothing is left behind.
