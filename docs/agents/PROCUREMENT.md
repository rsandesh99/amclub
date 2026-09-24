# Buyer Procurement Agent — runbook (S3.1, A2)

**Status: built dark, and it stays dark.** DESIGN §8.2 / §8.6 put the buyer agent (A2) at the **V1.5 → V2 gate**.
Building it dark was authorised; switching it on for **any** cohort needs a separate §8.1 mini-PRD and the founder's
sign-off (see "Enablement" below). Nothing in this stage turns it on: `AGENT_ENABLED` (web + runtime),
`agents_enabled.procurement`, the cohort allowlist and the buyer's own grant are all required, and every one of them
defaults off.

## What it does

A buyer says what they need once — typed, as a voice note, or as a photo / PDF — on WhatsApp or in the web / mobile
**assistant** (`/app/assistant`). The agent:

1. **Drafts the request** through the S1.8 pipeline (`/api/v1/rfq/voice-parse`, typed round one or STT;
   `/api/v1/rfq/document-extract` for a photo / PDF; the ONE clarifying question when the rule finds a gap) and shows
   the draft. **It creates the request only after the buyer's Yes** (`create_rfq`).
2. **Relays the S1.5 quality questions** when the request is held, collects the answers and proposes `complete_rfq`
   (or "send as is").
3. **Watches the request** (every 15 min): a provider's question is answered from the buyer's **own earlier words**
   when they contain the answer (`clarification_answer@v1` + a code backstop), else relayed verbatim (masked by the
   route) and the buyer's reply is proposed; when quotes arrive it sends **one three-line summary per new quote set**,
   built by code from the S1.2 comparison (no model), with the compare link.
4. **"Go with B"** → the `choose_quote` proposal → the buyer's **button / web tap** → a link to the buyer's own RFQ
   page with B selected (`/app/rfq/<id>?pay=<quote>&d=<decision>`), where the ordinary confirm sheet takes the payment
   on the buyer's own tap.
5. **Declines a quote with a reason** (button only), **asks a provider a scope / timing / terms / documents question**
   (`message_provider`, clamped), **chases** once after `procurement_chase_hours` with zero quotes (the S2.3 nudge),
   answers **status** from the S2.3 reply matrix, and **escalates** to the S2.3 ticket path.

## What it never does

| Never | Enforced by |
|---|---|
| **Pay** | `PROCUREMENT_SCOPES` holds neither `place_order` nor `accept_quote` (shared test); `POST /checkout` refuses a token without `place_order` (`requireToolScope`); the runner refuses an out-of-scope tool; `AgentRun.scriptedCall` refuses `/checkout`, `/payments`, payouts, refunds, order transitions and admin paths before any fetch; every golden conversation asserts zero checkout calls. |
| **Accept a quote by itself** | Acceptance in this codebase IS the buyer's paid checkout. `choose_quote` is a LOCAL confirm gate whose only effect is the decision-bound link; the page opens its OWN confirm sheet only when the `ai_decisions` row is this buyer's `choose_quote` for that RFQ + quote (`verifyChooseDecision`). |
| **Negotiate price** (§8.3 NOT-NOW) | `clampProviderMessage` runs on the buyer's words AND on the drafted message: a currency amount (₹ / Rs / rupees, 20k, 2 lakh, 20,000), a percentage, or counter-offer phrasing in any locale (en / hi / te / ta, Latin + native) → nothing is proposed; the buyer is told the agent does not negotiate price and may message the provider themselves. The buyer's own typed messages in the thread UI are unchanged. |
| **Write a sentence the buyer reads** | `procurement_turn@v1` has no reply field; every message is a template in `procurement-copy.ts` (en / hi / te / ta). |
| **Confirm a money-adjacent step from speech or text** | `choose_quote`, `decline_quote` and the chase nudge confirm by **button or web tap only**; a typed / spoken "yes" re-sends the buttons and records nothing (`readUtteranceOnProposal`). `create_rfq`, `complete_rfq`, `answer_clarification`, `message_provider` may also confirm by the S2.2 allow-list (`isUnambiguousYes`, code — the model never approves). |
| **Read or write with the service role** | Every RFQ / quote / clarification / thread read or write is `/api/v1` under the buyer's delegated token; the runtime's service role touches only `procurement_*`, `wa_*`, the ledgers (agent-writes audit). |

## The session machine

`PROCUREMENT_SESSION_TRANSITIONS` (`packages/shared/src/state-machines.ts`):

```
drafting → awaiting_create → live → quotes_in → chosen → closed
                           ↘ quality → live
awaiting_create → drafting            (the buyer adds detail / taps Edit)
chosen → quotes_in                    (chooses again, until the request closes)
any active → expired (TTL) | failed (grant revoked / agent off)
```

One session per need; **one ACTIVE session per (buyer, RFQ)**; a WhatsApp conversation routes to its most recent
active session (`wa_conversations.procurement_session_id`); a new need while one is live asks "new request or about
<title>?" with buttons. **One open proposal per session** (`open_run_id`); a message while it is open gets "tap a
button" unless it adds detail to an open draft (the draft is superseded). The daily cap
`procurement_max_proposals_per_day` counts proposals per buyer (IST day).

## Tools

| Tool | Confirm | Route | Voice / text yes? |
|---|---|---|---|
| `create_rfq` | yes | `POST /rfq` | yes |
| `complete_rfq` | yes | `POST /rfq/[id]/quality/{answer\|send}` | yes |
| `answer_clarification` | yes | `POST /rfq/[id]/clarifications/[cid]/answer` | yes |
| `message_provider` | yes | `POST /quotes/[quoteId]/messages` (clamped) | yes |
| `decline_quote` | yes | `POST /rfq/[id]/quote/[quoteId]/decline` | **button only** |
| `choose_quote` | yes | **local** — the link, no route | **button only** |
| `nudge_counterparty` | yes | `POST /rfq/[id]/nudge` (S2.3 cap) | **button only** |
| `compare_quotes` | no | `GET /rfq/[id]/compare` (+ the detail read) | — |
| `draft_rfq` / `clarify_rfq` / `extract_document` | no | the S1.8 prefill routes (scripted) | — |
| `support_lookup` / `track_order` / `search_catalog` | no | reads | — |

Every confirmation is ONE `ai_decisions` row, **feature `procurement_step`**, written by the decision route under the
buyer's token (the route picks the feature from the run's `meta.agent`). A create that links S1.8 intake rows links
them to that same decision (no second `rfq_intake` row) when the call carries the run-bound token.

## WhatsApp dispatcher order

STOP → active onboarding session → Munshi buttons (S2.2) → **procurement `pr:` buttons (S3.1)** → **free text vs the
open proposals (audit M42)** → opt-in keywords → JOIN → support (S2.3, incl. the `new_need` offer) → holding reply.

**A typed / spoken yes confirms at most one proposal (audit M42).** A buyer who is also a provider can have a Munshi
draft, a procurement proposal and a support nudge open on one conversation. `whatsapp/confirmations.ts` binds free
text with agent-core `bindTextConfirmation`: a reply that quotes this session's card, or the session's proposal being
the ONLY open one, reaches the turn with `textApproval: true`; anything else is ambiguous, so an approving yes re-sends
the card (and the other open cards) and approves nothing (`runProcurementTurn` enforces it too: on WhatsApp a yes
approves only with `textApproval: true`). The session still takes every other message. The web / mobile composer is
the session's own UI and is unchanged.

Procurement sits **before the opt-in keywords** because "yes" / "ok" / "hi" are S0.5 opt-in words: after them, a
buyer's typed yes to a draft would never reach the session (FOLLOWUPS "Agent S3.1"). It takes a `pr:` button of this
buyer (`pr:ok|edit|no:<runId>`, `pr:label:<session>:<A-G>`, `pr:sess:new|cur:<messageId>`) or any message while the
conversation's session is active; the S2.3 ticket halt is applied inside the turn. **STOP always wins**, and the S0.5
opt-out words include **"no" / "cancel" / "नहीं" / "వద్దు" typed as text** — buyers are steered to the buttons; a typed
"no" revokes WhatsApp (the web mirror continues). A first message with no session goes to Support, whose `new_need`
intent (`support_intent@v2`) offers **"Shall I start a request for this?"** with one `pr:sess:new` button (only when
procurement is on for the buyer).

Out of the 24 h window: template `procurement_update` (`amc_procurement_update_{en,hi,te}`, params `[one line, the
assistant link]`); decisions then happen in the app.

## Surfaces

- **WhatsApp** — the runtime jobs `agent.procurement.turn` (retry 1), `.decide` (retry 1), `.watch` (every 15 min via
  `cron/agent-procurement-watch`, no retry, singleton).
- **Web** — `/app/assistant` in its own route group `(agent-procurement-msme)` (a real 404 dark): consent, sessions,
  the thread (WhatsApp + web turns), cards with Yes / Edit / No, label and session taps, a composer. The composer posts
  `POST /api/v1/agent/procurement/message` → the SAME `procurement.turn` engine. A tap posts
  `/agent/procurement/decision` → the runtime's decide job (the WhatsApp button path).
- **Mobile** — `assistant.tsx` behind `/profile/me.procurementEnabled`.
- **Admin** — the `/admin/agents` tile (30 days: active sessions, proposals approved / edited / declined, RFQs created
  via the agent, completed orders from agent sessions, model cost per completed order) and the runs view.

## Settings (closed registry)

| Key | Default | |
|---|---|---|
| `agents_enabled.procurement` | false | the switch |
| `cohort_user_ids` | [] | who |
| `procurement_chase_hours` | 24 | zero quotes this long after the request → one nudge offer |
| `procurement_session_ttl_days` | 7 | sliding on each buyer turn; the watcher closes stale sessions with a final message |
| `procurement_max_proposals_per_day` | 30 | per buyer, IST day |
| `budget_run_paise_by_agent.procurement` | (global) | documented at 1500 (₹15) per run |

## Enablement — the V1.5 → V2 gate (do not skip)

This stage must not be enabled on its own authority. Before any cohort, the founder signs a **§8.1 mini-PRD** that
states at least:

1. **The problem and the metric** — agent-assisted conversion (request → paid order) vs manual for comparable buyers,
   and the §8.6 A2 exit bar (agent-assisted conversion ≥ manual; AI cost < 5 % of commission).
2. **RICE** with the displaced work named.
3. **The cohort** — size, selection, the kill criteria (e.g. any proposal the buyer disputes as "I didn't ask for
   that", any checkout attributed to the agent, a no-negotiation escape, cost per completed order above the bar).
4. **The live gates passed**: `eval --set procurement_turn` ≥ 90 %, `clarification_answer` ≥ 85 %,
   `provider_message` ≥ 85 % with **zero proposable counter-offers**, `procurement_conversations` ≥ 90 % with **zero
   checkout calls**, and `eval --set injection` green (live) — all with the key.
5. **The WhatsApp template approval** (`amc_procurement_update_*`) and the runtime deployed (the Fly deploy currently
   skips — no `FLY_API_TOKEN`).
6. **Consent copy reviewed** (`PROCUREMENT_CONSENT_TEXT_VERSION`).

Then: `agents_enabled.procurement = true` + the cohort in `/admin/agents`; each buyer enables it themselves on
`/app/assistant` (the grant is theirs).

## Rollback

- **Kill switch** (`/admin/agents`) or `agents_enabled.procurement = false` → the next watch closes every open
  session as failed (`agent_disabled`) and sends nothing; the routes 404; WhatsApp messages fall through to Support /
  the holding reply.
- **A buyer**: "Turn off the assistant" (revokes the web grant, strips the WhatsApp scopes) — the next watch closes
  their sessions (`grant_revoked`), nothing further is sent. STOP on WhatsApp stops WhatsApp only.
- **Code**: the tables are inert without the runtime; migration 0045 is additive (drop the two tables and the column
  after the code is reverted).

## Metrics (PostHog)

`procurement_enabled` · `procurement_disabled` · `procurement_message` · `procurement_turn` · `procurement_proposed` ·
`procurement_step_decided` · `procurement_yes_needs_button` · `procurement_quotes_summarised` ·
`procurement_checkout_link_sent` · `procurement_checkout_opened` (client) · `procurement_card_tapped` (client) ·
`procurement_session_closed`.

## Verification

`pnpm --filter @amclub/web agents:verify:procurement` — offline laws + the golden conversations; flag OFF (dark, and
the dispatcher byte-identical); flag ON (the whole lifecycle on the prod DB with kill-test rows, the runtime
in-process). `pnpm --filter @amclub/agent-core eval --set procurement_conversations|procurement_turn|clarification_answer|provider_message|injection`.
