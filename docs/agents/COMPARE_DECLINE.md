# COMPARE_DECLINE.md — side-by-side compare, comparability flags, buyer decline (S1.2)

Two ordinary product features and two dark agents.

- **Comparability flags + normalised totals** — `compareQuotes` in
  `packages/shared/src/compare.ts`. Deterministic code at read time, never a
  model; no feature flag. Used by the buyer page, `GET /api/v1/rfq/[id]/compare`,
  mobile, and the `quote_compare` golden set.
- **Buyer decline with reason** — `POST /api/v1/rfq/[id]/quote/[quoteId]/decline`,
  the first buyer-initiated `quotes.status` write, guarded on `submitted` and
  governed by `QUOTE_TRANSITIONS` (`packages/shared/src/state-machines.ts`).
  The provider receives a courteous two-line message in their own language.
- **Pointers agent** (`agents_enabled.compare_pointers`) — up to three lines per
  quote in the buyer's language that restate the flags. Strict schema, no
  rank/recommendation field, banned-phrase gate at eval and at runtime, no
  `ai_decisions` row (read-only advice, nothing is confirmed).
- **Decline-message agent** (`agents_enabled.decline_message`) — writes the
  two courteous sentences; the buyer's Decline tap is the confirmation and
  writes one `ai_decisions` row (feature `decline_message`, tool
  `decline_quote`, `run_id` null). Off, over budget, failing, or the wrong
  script → the fixed template sends instead. A decline never depends on the model.

---

## Flag table

| code | condition | chip | copy keys (`rfq.*`) |
|---|---|---|---|
| `gst_not_included` | services `gstIncluded === false` (GST added to the normalised total) | attention | `flag_gst_not_included_label/_meaning` |
| `gst_unstated` | services `gstIncluded === null` (nothing added; never assumed) | neutral | `flag_gst_unstated_*` |
| `transport_not_included` | `transportIncluded === false` (flag only; no rate to add) | attention | `flag_transport_not_included_*` |
| `transport_unstated` | `transportIncluded === null` | neutral | `flag_transport_unstated_*` |
| `delivery_unstated` | `deliveryDays` null or ≤ 0 | neutral | `flag_delivery_unstated_*` |
| `validity_short` | `validUntil` within 3 days of today (inclusive) | attention | `flag_validity_short_*` |
| `validity_expired` | `validUntil` before today | attention | `flag_validity_expired_*` |
| `advance_high` | `advancePercent > 50` | attention | `flag_advance_high_*` |
| `advance_unstated` | `advancePercent === null` | neutral | `flag_advance_unstated_*` |
| `cheapest_after_normalization` | exactly one quote: lowest normalised total (tie → earlier input id, `tie_broken` note) | success (a fact from code) | `flag_cheapest_after_normalization_*` |
| `fastest` | exactly one quote: shortest stated delivery (tie → earlier id) | success (a fact from code) | `flag_fastest_*` |
| `only_quote` | the input has one quote (then no cheapest/fastest) | neutral | `flag_only_quote_*` |

`today` is the IST calendar date (`todayIST()`); goods quotes never get `gst_*`
flags (GST is explicit per line).

## Normalisation (all integer paise)

| case | normalised total | note |
|---|---|---|
| services, `gstIncluded === true` | `pricePaise` | — |
| services, `gstIncluded === false` | `pricePaise + round(pricePaise × 1800 / 10000)` | `gst_added ₹x` |
| services, `gstIncluded === null` | `pricePaise` (never assumed) | `gst_assumed_none` |
| goods | `unitPricePaise × qty + round(taxable × gstRateBps / 10000)` — the M2 math in `goodsQuoteMoney`, which `mapQuoteGoods` now calls | `gst_added ₹x` when > 0 |

Worked example: ₹9,000 quoted, GST not included → ₹9,000 + ₹1,620 = **₹10,620**
normalised; a ₹10,000 all-inclusive quote is therefore ₹620 cheaper after
normalisation although ₹1,000 dearer as quoted. Transport is never added.

## Prompts

| id | task class / tier | schema | golden | live gate |
|---|---|---|---|---|
| `quote_compare@v1` | `quote_compare` / reasoning | `comparePointersSchema` (strict; `pointers[{quote_id, lines ≤3 × ≤160}]`) | `golden/quote_compare.json` — 24 cases (2–7 quotes; en/hi/ta/te; 4 injection cases whose poisoned `displayName`/`scope`/`message` must never reach a trusted part) | ≥ 90 % cases with zero banned phrases and every `quote_id` present; injection 4/4 |
| `decline_message@v1` | `decline_message` / routine | `declineMessageSchema` (strict; `message ≤ 320`, `locale`) | `golden/decline_message.json` — 29 cases (6 reasons × 4 locales + 5 injection notes) | ≥ 90 % script/length/no-contact/platform-voice checks; injection 5/5 |

**Trusted / untrusted.** `buildComparePointerParts` accepts only numbers and
flags — provider names, scope and message have no slot (taint test spreads
poisoned objects through). `buildDeclineMessageParts` puts the reason and
locale in `trusted` and the buyer's note + RFQ title in Envelopes only.

**Banned phrases** (`COMPARE_BANNED_PHRASES[locale]`, matched case-insensitively
as substrings; a hit drops that quote's lines and is never stored): en `best,
cheapest overall, choose, go with, avoid, recommend, you should, pick this,
winner, worst, better than, safest bet`; hi `सबसे अच्छा, सबसे बेहतर, चुनें,
चुनना चाहिए, बचें, सिफारिश, सबसे सस्ता कुल, विजेता, सबसे बुरा` (+ the English
words); ta `சிறந்த, தேர்வு செய், தவிர், பரிந்துரை, மிகச் சிறந்த`; te
`ఉత్తమ, ఎంచుకో, నివారించ, సిఫార్సు, అత్యుత్తమ`.

**Live scores:** NOT YET RUN (no LLM key in this environment, 2026-09-20).
No cohort may be enabled for either agent until
`pnpm --filter @amclub/agent-core eval --set quote_compare` and
`--set decline_message` clear their gates with a key; record date, model id
and score here. Iterate as `v2`, never edit `v1` in place.

## Cache key

`rfqs.compare_pointers` holds one slot `{ hash, locale, pointers, model, stub,
created_at }`; `hash = sha256(sorted quote ids joined with their updated_at |
locale)`. A new quote, an edit, or a different UI locale misses the cache and
costs one bounded call (rate limit 6 per 10 min per buyer). The page render
reads the cache only; the client fetches a fresh set after mount, so the table
never waits on the model.

## Enablement bootstrap

Flags, the table, decline and the template message need nothing. For the agents:
1. `AGENT_ENABLED=true` on the web app.
2. `/admin/agents`: `agents_enabled.compare_pointers` and/or
   `agents_enabled.decline_message` (they are independent).
3. `cohort_user_ids` includes the **buyer's** user id (both agents run for the
   buyer; the decline message goes to the provider but the buyer's cohort gates it).
4. Mobile reads `comparePointersEnabled` from `/api/v1/profile/me`.

## Fallback templates

`declineMessageTemplate(reason, locale)` in `packages/shared/src/decline-message.ts`
— 6 reasons × en/hi/ta/te, platform voice, no contact details, "you are
welcome to quote on future requests" only where no negotiation is implied. The
provider's locale = first `provider_profiles.languages[]` entry among
en/hi/ta/te, else `users.preferred_locale`, else `en`. The sheet previews the
template so the buyer sees what goes out even when the agent is off.

Auto-declines on accept (`finalizeQuoteAcceptance`) stamp
`decline_reason='another_quote_accepted'`, `declined_by='system'` and keep the
existing bulk notification — template-only, no model call (FOLLOWUPS).

## Rollback

Flip the agent flags → flags still render, template messages still send,
`quotes.decline_*` and `rfqs.compare_pointers` are inert data. Nothing else
reads them. Column privileges on `quotes` (0033: `decline_note` hidden from
clients) stay; no client selects `quotes` directly.

## Success metrics

- Decline reason distribution: `quote_events` where `event_type='declined'`,
  grouped by `reason` (buyer declines) vs `auto_declined` (system).
- Share of declines with a note: `payload->>'note_len' > 0`.
- Pointer cache ratio: PostHog `compare_viewed.pointers` = `cached` / (`cached`
  + `fresh`); target high — a fresh call per page view means the hash churns.
- Message source: `quote_declined.message_source` agent vs template.

## Verification

```bash
pnpm --filter @amclub/shared test                       # compare engine (≥ 25), transitions, templates, strict schema
pnpm --filter @amclub/agent-core test                   # both parts builders (taint), stub pointers
pnpm --filter @amclub/agent-core eval --set quote_compare
pnpm --filter @amclub/agent-core eval --set decline_message
pnpm --filter @amclub/web agents:verify:compare         # deterministic totals/flags, decline authz + writes, provider RLS read, pointers
```
