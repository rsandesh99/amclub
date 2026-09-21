# DISPUTE_TRIAGE.md — the Dispute-Triage agent (S1.7)

**What it is.** When a dispute opens, the ops user sees the order, its timeline,
payment, payout and documents, and the raiser's one-line reason. S1.7 adds
**one statement per party** (spine — not flag-gated), then a runtime agent
that assembles the order evidence (the S1.4 read), the two statements and the
pre-payment quote thread, and writes a **triage card**: a neutral timeline,
each party's claims with the evidence refs that support or contradict them,
the gaps, and a recommended resolution **class** with rationale and confidence.
The card sits above the resolution controls in `/admin/disputes/[id]`.

**What it never does.** It never pre-selects a resolution, never prefills a
rupee amount (partial refunds are a percent band), never moves money and
never calls the resolve route: no tool wraps it and the route refuses any
delegated token (`requireNotDelegated`). `resolveDispute` remains the only
money path. The founder's click on the existing resolve route, carrying the
`triage_id` the card was opened with, is the decision — linked to
`ai_decisions` (feature `dispute_triage`, tool `summarize_dispute`, run id)
**after** settlement; a failed link never fails the resolution.

Persona **ops**, read-only. Two tools, both `confirm:false` GETs under the
founder's delegated ops token: `read_order_evidence`
(`GET /api/v1/admin/orders/[id]/evidence`) and `summarize_dispute`
(`GET /api/v1/admin/disputes/[id]`, wired in S1.7, `requireToolScope` on the
route). The service role writes only `dispute_triages`, `disputes.triage_id`
and the ledgers.

---

## Enablement bootstrap (nothing runs until all four are true)

1. Runtime deployed with `AGENT_ENABLED=true` (`RUNTIME.md`); web
   `AGENT_ENABLED=true` with `AGENT_RUNTIME_URL` + `AGENT_RUNTIME_SECRET`.
2. The founder's **ops grant** (persona ops, channel web) with scopes
   `read_order_evidence` + `summarize_dispute` (+ `recommend_payout_release`
   for S1.4).
3. `/admin/agents`: `ops_user_id` = the founder's user id; `agents_enabled
   .dispute_triage = true`; `cohort_user_ids` includes the founder's user id
   (the S1.4 rule for ops agents).
4. **Live eval gate:** `pnpm --filter @amclub/agent-core eval --set dispute_triage`
   with an LLM key must clear **≥ 85 %** recommendation-class agreement with
   **5/5 injection** cases. As of the S1.7 PR it has run in **stub mode only**
   (17/17, 5/5); the live score is **not yet recorded** — do not enable until it is.

**Turning it off:** `agents_enabled.dispute_triage=false`, the kill switch, or
`AGENT_ENABLED=false`. Statements stay (spine); no new cards; existing cards
stay readable; the resolve route is unchanged either way.

## Party statements (spine; `POST/PATCH/GET /api/v1/orders/[id]/dispute/statement`)

- Parties only (the documents route's party check); the order must be
  `disputed` and the dispute `open` (else 409 `dispute_not_open`).
- Body 20..2000 chars, up to five of **this order's** `order_documents`
  (422 `document_not_on_order` otherwise); `redactContactInfo` runs before
  storage (`redacted` flag; the parties are told).
- **One per party** (unique `(dispute_id, role)`; a second POST → 409
  `statement_exists`); `PATCH` edits the body while the dispute is open and
  **no triage exists** (409 `triage_exists` after — the card and the
  statements never diverge). Versioning is a FOLLOWUP.
- Side effects: `order_events.dispute_statement { statement_id, role, edited }`,
  a `dispute_statement` notification to the counter-party (in-app + email) and
  to the ops user in-app, PostHog `dispute_statement_submitted`, and after the
  **second** party's first statement a re-triage request (gated; no-op while dark).
- Surfaces: the web order workspace ("Your statement" card while disputed),
  the mobile order screen (text only), the admin console (verbatim, redacted).

## The card (`disputeTriageSchema`, strict)

| field | meaning |
|---|---|
| `timeline[≤20] { at, what, ref }` | neutral entries from **trusted** events/milestones only |
| `claims[≤10] { party, claim, evidence[≤6] { ref, supports }, assessment }` | one per assertion; `assessment` against the record only |
| `gaps[≤6]` | what evidence would settle it |
| `recommendation` | `refund_full` · `refund_partial` · `release` · `needs_more_info` — a CLASS |
| `partial_band` | only with `refund_partial`; the buyer's refund share `10_30 … 70_90`; never paise |
| `rationale[1..5]`, `confidence` | plain lines; `high` only when the record decides it |

No `amount_*`, `resolution` or `tool` key can exist (strict at every level).

**Evidence refs** are an allow-list the runtime passes as a trusted part:
`event:<id>` (dispute detail events), `milestone:<kind>`, `doc:<id>`,
`statement:<id>`, `message:<id>`; `clampTriage` drops anything else.

## Deterministic checks (`triageDeterministicChecks`, code)

| check | `ok` when |
|---|---|
| `statement_missing_buyer` / `_provider` | that party has a statement |
| `no_work_complete_photo` | services: a `work_complete` milestone photo; goods: a `delivery_photo` |
| `delivered_before_dispute` | the `deliver` event (services) or `delivered_photo_at` (goods) precedes the dispute |
| `dispute_after_auto_accept` | NOT opened after the 72 h auto-accept |
| `payout_already_paid` | the payout is not `paid` |
| `refund_already_exists` | no refund row on the payment |
| `goods_return_window_expired` | the return opened within `return_window_hours` of `delivered_photo_at` |
| `duplicate_photo_flag` | no S1.4 near-duplicate anomaly on this order |

**The clamp** (`clampTriage`, after the model): a missing statement or `low`
confidence ⇒ `needs_more_info`; `partial_band` only with `refund_partial`
(default `30_50`); unknown refs dropped; a paid payout / existing refund is
appended as a rationale note that survives the 5-line cap.

## Re-triage and cap

A triage is requested when the dispute opens and again when the **second**
party's statement lands (a new row; `disputes.triage_id` moves; the console
shows the latest with a history toggle). At most **3** rows per dispute
(trigger + runtime both refuse: terminal `triage_cap`, never retried).

## Founder review flow

The card names the class with confidence, lists the timeline, the claims per
party with evidence chips that deep-link to the event, document, statement or
thread, the gaps, the rationale, the checks as chips, model cost and a
"generated from N statements" line. Below it, both statements verbatim
(redacted) with document links, and the pre-payment thread. Then the
**unchanged** resolve buttons; clicking one posts `triage_id` so the decision
is linked. When no card exists and the agent is on, a muted "Triage pending"
line; nothing when off. `/admin/agents` shows a Dispute triages tile
(pending, agreement rate, needs-more-info share).

## Metrics (PostHog, DESIGN.md Appendix A)

`dispute_statement_submitted`, `dispute_triage_written`,
`dispute_resolved_with_triage { agreed }`. Derived: agreement rate (founder's
class = recommended class), time-to-resolution with vs without a card,
`needs_more_info` share (`triageStats`).

## Rollback

Flag off → statements stay, no new cards, existing cards readable. Migration
**0037** is additive; to drop: `ALTER TABLE disputes DROP COLUMN triage_id;
DROP TABLE dispute_triages; DROP TABLE dispute_statements;` and revert the
code with it (the statement route and the admin GET name the tables).

## Prompt

`dispute_triage@v1` (`packages/agent-core/src/prompts/dispute_triage/v1.md`,
frontier tier, output `disputeTriageSchema`). Trusted: order facts, the event
timeline with ids and actor roles, milestone kinds + timestamps (never the
notes), payout/refund status, the checks, S1.4 photo findings when a dossier
exists, the ref allow-list. Untrusted: the dispute reason, each statement,
each milestone note, each thread message — one Envelope each. Photos are
**not** sent in this stage (FOLLOWUPS). Golden set
`golden/dispute_triage.json`: 17 disputes (12 honest incl. 4 goods and 3 with
a missing statement, 5 injection).

## Known limits (FOLLOWUPS S1.7)

Statement versioning (one row, edited in place until triage); vision on
dispute photos; `dispute_summary` task class unused by any agent; mobile has
no raise-dispute action at all (pre-existing) — statements only; the scope
refusal (a delegated token without `summarize_dispute`) is proven on the route
by the S1.4 pattern, not minted on the laptop rig.

## Verified on this laptop (S1.7 gate, 2026-09-21)

`agents:verify:triage` ran against a local production server on the prod
database: flag OFF after 0037 (the statement spine is proven dark post-
migration because the route reads `disputes.triage_id`, migration-first deploy
rule), then flag ON with the runtime agent driven in-process under the ops
session token, the S1.4 precedent. Three things are recorded skips, not
passes, until the first Fly deploy exercises the real delegated path (the
S1.6 FOLLOWUPS gate): the `AMC-Runtime` HMAC token mint, the pg-boss queue
hop (`agent.dispute_triage`), and the runtime → web notify (`AGENT_RUNTIME_SECRET`
absent locally, so `notified_at` stays null). The goods lifecycle is skipped
while `MART_ENABLED` is off on prod (unit tests + golden cover it).
