# SUPPORT.md — the Support agent: status answers, one nudge, escalation to a human (S2.3)

**Status:** built 2026-09-22, dark. Ships behind `AGENT_ENABLED` (web + runtime) **and**
`agent_settings.agents_enabled.support` **and** `cohort_user_ids` **and**, on WhatsApp only, an active
WhatsApp grant (the user's own START). Flag off: `/app/support`, `/partner/support`, `/admin/support` and
`/api/v1/agent/support/*` + `/api/v1/agent/admin/support/*` are real 404s, the WhatsApp dispatcher sends the
S0.5 holding reply exactly as before. The one spine addition, the counterparty **nudge** routes, works with
the flag off. Migration **0041** (NOT staged; applied to prod before the writer deploys).

## The one rule

**The model never writes a sentence the user reads.** It classifies the message into an intent and says
which order or request it is about (`supportIntentSchema`: intent, `as_role`, `order_ref`, `rfq_ref`,
`how_to_topic`, `escalate`, `escalate_reason`, an ops-only `ops_summary`, language — strict, **no reply
field**). The reply is a fixed template from `packages/shared/src/support-copy.ts` (en / hi / te / ta) whose
slots are filled from `/api/v1` reads made under the user's own identity. Money slots are formatted
server-side from paise; status labels reuse the app's own order / RFQ / payout label text, so the agent can
never contradict the screen.

**One engine, two surfaces.** `runSupportTurn` (`packages/agent-core/src/support/core.ts`) classifies once,
resolves the reference through an injected `SupportLookups`, picks the template with the pure
`resolveSupportReply` (shared), renders it and checks the numbers rule. The surfaces differ only in the
lookups:

| surface | classifier | lookups |
|---|---|---|
| web + mobile — `POST /api/v1/agent/support/message` | bounded call (`boundedChatJson`, `run_id` null) | the user's **session client** (RLS) — `webSupportLookups` |
| WhatsApp — runtime `support.reply` | `run.callModel` in a run per turn | GETs under the **delegated token** (`/orders`, `/orders/[id]`, `/rfq/mine`, `/rfq/matched`), each logged as a `tool_called` event with tool `support_lookup` (`readUnderToken`); the token persona is the user's WhatsApp grant persona |

The service role touches only the support tables, `wa_*` and the ledgers — with one documented exception:
payout / refund facts are not on any party route, so the **web** lookups read `payouts` / `refunds` for an
order **only after the session read returned that order** (RLS already proved it is the user's). The runtime
does not read them (its payout replies degrade to the order status; FOLLOWUPS S2.3).

## Intents and the reply matrix

Intents: `order_status · quote_status · rfq_status · payment_status · payout_status · how_to · nudge_request
· complaint · dispute_language · payment_problem · greeting · other`.

| intent | outcome → key |
|---|---|
| `order_status` | the order's status → `order_status.<placed…refunded>` (resolved_* → `resolved`, cancellations → `cancelled`); a reference that did not resolve → `not_found`; no orders → `none` |
| `payment_status` | refunded → `refunded`; a refund row / partial / cancellation → `refund_pending`; else `paid` (an order exists only after the webhook); `not_found` / `none` |
| `payout_status` (provider hat) | disputed → `held_dispute`; the payout row's status → `paid / processing / failed / held / scheduled`; completed without a row → `scheduled`; else `not_due`; `not_found` / `none` |
| `quote_status` (provider hat) | my quote's status → `submitted / accepted / declined / withdrawn / expired`; no quote → `none`; `not_found` |
| `rfq_status` | `open_no_quotes / open_quoted / accepted / expired / cancelled`; `not_found` / `none` |
| `how_to` | `how_to.<topic>` — create_rfq, compare_quotes, accept_quote, pay, refund, cancel, verification, fees, kyc_bank, payout_timing, dispute, contact_human, other |
| `nudge_request` | `nudge.confirm` (+ action) · `nudge.capped` · `nudge.out_of_window` (subject not active) · `nudge.no_subject` |
| `complaint / dispute_language / payment_problem` | `escalated` (+ ticket) |
| `greeting` | `greeting` |
| `other` | `unclear`, then `unclear_again`; the streak reaching `support_escalate_after_turns` → `escalated` (reason `unclear_twice`) |
| (open ticket) | `escalated_open` — no classification |

A nudge is **offered** (the action) on an active order (placed … revision_requested), an open RFQ with no
quotes (buyer), or my submitted quote (provider) — only when the subject is active and not capped.

**Dual role.** A user who is both buyer and provider gets the classifier's `as_role`; payout and quote
questions default to the provider hat.

## The numbers rule

Every digit run in a rendered reply must appear in the lookup payload (the order / RFQ view the template was
filled from), the copy constant for that key, the SLA, the support contact line, the ticket ref or the nudge
cooldown setting (`numbersAccountedFor`). It is tested on every key × locale with fixtures (shared +
`verify-support.ts` offline), on a 12-turn scripted session (agent-core), on every `support_intent` golden
case (`eval --set support_intent`), and against the live order GET in the rig. A violation is logged
(`[support] numbers rule violated`) — it cannot happen by construction, because no slot is model-filled.

## Escalation halts the agent

Escalate on: complaint, dispute language, a payment problem, abuse, an explicit request for a human, or the
unclear streak reaching `support_escalate_after_turns` (default 2). The turn opens a **ticket**
(`openTicket` in `apps/web/lib/support/tickets.ts`; the runtime calls `POST
/api/v1/agent/admin/support/tickets` with the `AMC-Runtime` credential):

- ONE open ticket per (user, channel) — a second escalation returns the existing one.
- `summary` / `suggested_next` from `support_ticket_summary@v1` over the last 6 turns as Envelopes (ops-facing;
  the contact rule applies; fallback "see the transcript" on any failure).
- The user gets the `escalated` template (the ticket ref, the SLA, the human contact line) and the
  `support_escalated` notification; the ops user (`ops_user_id`) gets `support_ticket_opened` in-app
  immediately and on WhatsApp outside `support_ops_quiet_hours`.
- The thread (`support_threads.open_ticket_id`) / conversation (`wa_conversations.support_ticket_id`) is marked.
  **From then on:** web / mobile store each message and answer `escalated_open` with NO model call; WhatsApp
  stores each message and replies **nothing**. Only a human's **Resolve** clears the mark.
- If the runtime cannot reach the web ticket route, it opens a bare ticket itself (support table, fallback
  summary) so the halt still holds.

## The nudge (the one action)

`POST /api/v1/orders/[id]/nudge` and `POST /api/v1/rfq/[id]/nudge` — spine, no flag. Party check (a buyer
nudges every matched, non-declined provider on an RFQ; a matched provider nudges the buyer), the subject must
be active, **once per sender per subject per `support_nudge_cooldown_hours`** (default 24; 429
`nudge_cooldown` + `Retry-After`), a fixed-template notification (`order_nudge` / `rfq_nudge`; no free text —
an extra body field is a 422), an `order_events` `nudged` row for orders, PostHog `nudge_sent`. The **Nudge**
button on the order workspace and the RFQ pages calls these directly; the agent is just another caller.

- Web / mobile: the reply carries `action` + `support_message_id`; the user's click on the spine route is the
  confirmation and writes ONE `ai_decisions` row (feature `support_nudge`, tool `nudge_counterparty`, `run_id`
  null) — only when the message is an assistant turn in the caller's own thread.
- WhatsApp: the run parks on `nudge_counterparty` (confirm:true) and sends `nudge:yes|no:<runId>` buttons; Yes →
  `support.decide` → the decision route under the token (`input_refs.wa_message_id`) → resume → the same nudge
  route; a 429 on resume → the `nudge.capped` reply.

## SLA copy source

`apps/web/lib/legal/grievance.ts` — `GRIEVANCE_SLA { acknowledgeHours: 24, resolveDays: 15 }` and
`SUPPORT_CONTACT`. The web passes them into every template; the runtime mirrors the two constants
(`SLA`, `CONTACT` in `agents/support/index.ts`) because it cannot import web code — **change both together**.

## Enablement bootstrap (nothing answers until all are true)

1. Migration 0041 applied; `verify-migrations` shows it present.
2. `AGENT_ENABLED=true` on web **and** runtime.
3. `agent_settings.agents_enabled.support = true` and the user in `cohort_user_ids`.
4. `agent_settings.ops_user_id` = the founder / ops user (ticket notifications).
5. Settings (defaults are safe): `support_escalate_after_turns` (1..5, 2), `support_nudge_cooldown_hours`
   (1..168, 24), `support_ops_quiet_hours` (`{ from: 'HH:MM', to: 'HH:MM' }` IST, or null).
6. WhatsApp: the user's own START grant; the templates below approved at Meta (PRE_LAUNCH_CHECKLIST 1.3).
7. The live eval gate green (below).

## Tables (0041)

`support_tickets` (one open per user × channel; status `open → in_progress → resolved`), `support_threads`
(web / mobile; `last_intents`, `unclear_streak`, `open_ticket_id`), `support_messages` (user text
contact-masked with `redacted`; assistant text = the rendered template; `lookup_refs` ids only), `nudges`
(spine), `wa_conversations.support_ticket_id / support_last_intents / support_unclear_streak`, and
`ai_decisions_feature_check` restated with `support_nudge`. RLS: users read their own rows; admin / ops read
all; **no client writes** — the web route writes the thread and messages with the service role after the
session check, because the model call and the two-table write happen server-side.

## WhatsApp templates

`support_reply` (`amc_support_reply_{en,hi,te}`, params `[title, body]` — the out-of-window carrier),
`support_escalated` (`[ticket ref]`), `support_ticket_opened` (ops, `[summary]`), `support_resolved`
(`[note]`), `order_nudge` / `rfq_nudge` (`[body]`). The nudge confirmation is in-window buttons only.

## Admin queue

`/admin/support` (the `(agent-admin)` group): open first, the SLA countdown against `acknowledgeHours`,
channel, role, intent, summary, suggested next; the detail shows the masked transcript and the linked order /
RFQ. **Acknowledge** (`in_progress`, `acknowledged_at`), **Assign to me**, **Resolve** (a note is required →
the user is told, the agent is re-enabled). Every action writes `audit_logs` (`support_ticket_<action>`).
Routes: `GET /api/v1/agent/admin/support/tickets[?status=all]`, `GET/PATCH …/tickets/[id]`, `POST …/tickets`
(runtime credential only), `GET …/stats`.

## Metrics

- **Self-serve rate** = turns without escalation ÷ all turns over 7 days (web / mobile user messages +
  WhatsApp `support.reply` runs). **Target 40–50 %.**
- **Median acknowledgement minutes** vs the 24 h SLA, and the share acknowledged within it.
- **Escalation reasons** (`reasons` on the stats route).
- PostHog: `support_turn { channel, intent, escalated, reply_key, role }`, `nudge_sent { subject_kind, via,
  recipients }`, `support_nudge_decided { outcome }`, `support_ticket_opened { channel, role, reason,
  has_summary }`, `support_ticket_resolved { channel, minutes_open }`.

## Live evals (gate before any cohort)

```
pnpm --filter @amclub/agent-core eval --set support_intent --live          # ≥ 90 % intent agreement, every injection case
pnpm --filter @amclub/agent-core eval --set support_ticket_summary --live  # ≥ 90 %, no contact details, no marker strings
pnpm --filter @amclub/agent-core eval --set injection --live               # the red-team gate, incl. the support_chat surface
```

Not run at build time (no LLM key) — the stub runs are green in CI.

## Rollback

- Remove `support` from `agents_enabled` (or clear the cohort): the pages / API 404 for everyone, WhatsApp falls
  through to the holding reply. Open tickets stay in the queue and can still be resolved.
- `AGENT_ENABLED=false` on the runtime: WhatsApp stores inbound and replies nothing (S0.5 dark behaviour).
- The nudge routes are ordinary product; to stop nudges, hide the button — the routes stay harmless (capped,
  fixed text).
- 0041 is additive; leaving the tables in place is safe. Rolling it back needs the web + runtime code reverted
  first (the dispatcher selects `support_ticket_id`).

## Verify

`BASE_URL=http://localhost:3100 [AGENT_RUNTIME_SECRET=<throwaway, same as the server>] pnpm --filter @amclub/web agents:verify:support`
— offline laws, flag-off 404s + the nudge spine + the holding reply, flag-on web / WhatsApp (in-process) / admin,
zero residue. Legs that need 0041 are recorded skips until it is applied.

## Known limits (FOLLOWUPS S2.3)

No streaming (template replies are instant); payout / refund facts only on the web surface; en / hi / te / ta
copy only; no "did the buyer see my quote" intent (needs read receipts); the web Nudge toast says "24 hours"
(the default) rather than the configured cooldown.
