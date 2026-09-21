# RFQ_QUALITY.md — pre-fan-out completeness check (S1.5)

**What it is.** Before a services RFQ is sent to providers, the platform checks
it against its category template and asks the buyer at most **three** questions
in their own language. The buyer answers or taps **Send as is**; either way the
request goes out. Nothing is held hostage: a cron guard releases any deferred
request after `agent_settings.rfq_quality_hold_minutes` (default 30), and a
model failure or budget breach yields rule-only questions or an inline fan-out.

**Shape.** Deterministic gaps and risks are code (`packages/shared/src/rfq-quality.ts`,
tested). ONE bounded model call (`apps/web/lib/agent/bounded.ts`, `run_id = null`,
one `ai_invocations` row) judges whether the free text is specific enough and
writes the questions. `mergeQualityReport` enforces the **union rule**: every
rule gap is in the final list (rule items first); the model can only add, never
remove; cap three. The buyer's decision is the confirmation and writes ONE
`ai_decisions` row (feature `rfq_quality`, tool `check_rfq_quality`, `run_id`
null); auto-release records none (no human).

**Deferred is derived, never a status.** A deferred RFQ is `status='open'` with
`fanout_at IS NULL`. No `rfq_matches` row exists, so no provider can see it.
`rfqIsActive`, `QUOTE_TRANSITIONS`, the 72-hour `expires_at` and the quote-window
sweep (keyed on `rfq_matches.notified_at`, written at fan-out) are untouched. The
72-hour clock does **not** pause during the hold (FOLLOWUPS S1.5).

---

## Enablement (dark by default)

`AGENT_ENABLED=true` on web **and** `agents_enabled.rfq_quality = true` **and**
the buyer's user id in `cohort_user_ids` (`/admin/agents`). Goods RFQs
(`kind='goods'`) are always single phase. With any of the three off, `POST
/api/v1/rfq` is byte-identical to before apart from `fanout_at = now()` on the
insert, and the cron guard's select finds nothing.

**Live gate before any cohort:** `pnpm --filter @amclub/agent-core eval --set
rfq_quality` with an LLM key must clear **≥ 90 %** agreement (specific_enough +
gap-field set match) with **5/5 injection** cases passing (no "complete" flip,
no contact request). As of the S1.5 PR this has run in **stub mode only**
(33/33, 5/5); the live score is **not yet recorded** — do not enable a cohort
until it is.

## Precheck rules (`rfqQualityPrecheck`)

| item | fires when | note |
|---|---|---|
| `missingRequired` (template field names) | a `required` template field is empty/whitespace in `details` | asked as "Please fill in: {label}" in the buyer's locale |
| gap `quantity` | no digit in title+details AND no filled quantity-like field (`/qty|quantity|count|units|pages|pieces/`) AND the template has such a field (or there is no template) | template-aware: six of the eight seeded categories are professional services where "how many?" is noise |
| gap `location` | no filled location-like field (`/state|city|location|site|address|pincode|district/`), the template has one (or none exists) AND no Indian state/code/major city in the text | a REQUIRED location field left empty is reported once, as `missingRequired` |
| gap `timeline` | `needed_by` null AND no filled timeline-like field (`/urgency|timeline|deadline|needed_by|when/`) AND no time words (`days|weeks|month|by |before|urgent|asap|…`) | a REQUIRED urgency/timeline field left empty is reported once |
| gap `budget` | both budget paise fields null AND no filled budget-like field (`/budget|loan_amount|amount/`) | a gap, never a risk |
| gap `specs` | the template's first `textarea` has < 80 characters (and is not already a missing required field) | |
| risk `contact_info_in_text` | `redactContactInfo` masks anything in the title or any string detail | the answer route masks again before storage |
| risk `title_too_vague` | < 3 content words after English + Hinglish stop-words | |
| risk `description_too_short` | title + string details < 40 characters | |
| risk `budget_below_floor` | **skipped** — `CATEGORIES` has no `minBudgetPaise` on this tree (`notes: ['budget_floor_unavailable']`) | FOLLOWUPS S1.5 |
| risk `duplicate_recent` | passed in: same buyer, same category, open/quoted, last 24 h, other id | |

When the rules alone exceed the cap of three, required fields win, then generic
gaps in the order above; the model adds nothing.

## Prompt

`rfq_quality@v1` — `packages/agent-core/src/prompts/rfq_quality/v1.md`, task
class `rfq_quality` (routine tier), output schema `rfqQualityModelOutputSchema`
(`{ specific_enough, gaps[≤3]{field, question, why?} }`, strict). The server
merges it; the model never sees or writes the report.

**Trusted / untrusted** (`buildRfqQualityParts`, taint test in agent-core):
trusted = `today`, `locale`, `category`, the template field list (names, labels,
required, type — never option values), `rule_gaps` (so the model does not repeat
them), `rule_risks`. Untrusted = the title, the string details as JSON and, when
present, the voice transcript — three Envelopes (`rfq_title`, `rfq_details`,
`voice_transcript`). A model question that asks for contact details is dropped
by the merge whatever the prompt said.

**Golden set** `packages/agent-core/golden/rfq_quality.json`: 33 cases across
the 8 seeded categories (12 complete, 16 incomplete, 5 injection; 6 hi, 3 ta,
3 te). Per case the eval also checks taint (no buyer string in a trusted line),
the union rule after the merge, schema validity and that expected rule risks
fired. Stub echoes `expect`; the live gate is above.

## Data (migration 0035)

`rfqs.fanout_at` (backfilled to `created_at` for every pre-0035 row),
`quality_report` (the report the buyer saw), `quality_checked_at`,
`quality_decision` (`answered | sent_as_is | auto_released | skipped`),
`quality_decision_at`, `quality_decision_id → ai_decisions`. Partial index
`rfqs_deferred_idx (created_at) WHERE fanout_at IS NULL AND status='open'`.
RLS unchanged.

## Routes

- `POST /api/v1/rfq` — two-phase when enabled: insert with `fanout_at NULL` →
  `runRfqQualityCheck` → complete ⇒ `releaseDeferredRfq(…, 'skipped')` and
  reply `{ rfqId, matched, quality }`; else reply `{ rfqId, matched: 0, quality,
  quality_meta: { stub, model_used }, deferred: true, deadline_at }`.
- `POST /api/v1/rfq/[id]/quality/answer` — keys ⊆ `quality_report.missing[].field`
  (422 `unknown_field`), answers contact-masked into `details`, one
  `ai_decisions` row, release `'answered'`. 409 `already_sent` if released meanwhile.
- `POST /api/v1/rfq/[id]/quality/send` — one `ai_decisions` row, release `'sent_as_is'`.
- Cron guard (`cron/rfq-expire`, after the expiry sweep): `fanout_at IS NULL AND
  status='open' AND created_at <= now() - hold` → `releaseDeferredRfq(…,
  'auto_released')`, in-app `rfq_sent_as_is` to the buyer, `qualityReleased` in
  the heartbeat.

`releaseDeferredRfq` (`apps/web/lib/rfq/release.ts`) is the **only** writer of
`fanout_at`: a guarded `UPDATE … WHERE fanout_at IS NULL RETURNING id`, so the
buyer and the cron racing produce exactly one fan-out.

## Finding stuck RFQs

```sql
select id, title, created_at, quality_checked_at
from rfqs
where fanout_at is null and status = 'open'
  and created_at < now() - make_interval(mins => 30);
```

Rows here older than the hold mean the rfq-expire cron is **not running** (check
`job_heartbeats` for `rfq-expire`). Releasing by hand: never `UPDATE fanout_at`
directly; call the send route as the buyer, or run the cron.

## Rollback

Flag off → every create is single phase again (`fanout_at = now()` on insert).
The 0035 columns are inert (`quality_*` stay null, `fanout_at` stays populated).
No status, no money, no auth was touched.

## Success metrics (PostHog)

`rfq_quality_checked` (complete, missing_count, rule/model counts, risk_flags,
stub, deferred) · `rfq_quality_answered` (answered_count, seconds_since_check)
· `rfq_quality_sent_as_is` · `rfq_quality_auto_released` ·
`rfq_quality_answer_dictated`. Watch: share of deferred RFQs answered vs sent as
is vs auto-released; quotes per RFQ deferred vs not; median seconds to answer.
