# ADR 008 — Agentic assistant: runtime topology, delegated identity, tool contract

**Status:** Accepted, 2026-09-08. Touches auth and the order/RFQ state-machine
boundary (§8.4). Governance: DESIGN.md §8.6 (mini-PRD + RICE, founder-authorised
pull-forward). Commit: H0 groundwork (this ADR, migration 0026,
`@amclub/shared` `agent.ts`, `lib/agent/router.ts`).

## Context

The product roadmap adds agents for buyers, providers and ops (conversational
voice RFQ, quote drafting, quote comparison, order tracking, dispute drafting,
ops triage). Three properties of the current architecture constrain how that
can be built without weakening the money and authorisation guarantees in
RULES.md and §2.5:

1. **Vercel functions are request-scoped** with hard execution limits. A
   conversational turn, a multi-step tool loop, full-duplex audio and telephony
   need a persistent process holding a socket. (ADR-001 already recorded the
   same constraint for pg-boss.)
2. **RLS is the authorisation model.** The service-role key is server-only and
   never used on a client-reachable path without an explicit check. An agent
   that acted with service-role privileges "on behalf of" a user would bypass
   every policy.
3. **State machines and money have one home each** (`state-machines.ts`,
   `payout.ts`, webhooks as payment truth). An agent that wrote status or money
   directly would create a second path.

## Decision

### 1. Agents propose, the spine disposes
An agent never writes money, status, or user data directly. It calls the same
versioned `/api/v1` routes a human uses, **under the user's own session**, so
RLS, rate limits, and the state machines apply to it unchanged. Nothing in the
agent layer grants a capability the calling user does not already have. Admin
actions (KYC approval, payout release, dispute resolution) are not tools; the
ops persona only produces recommendations. The founder's payout gate (ADR-002)
is untouched.

### 2. Runtime topology: a second, long-running service
Agent execution runs in a separate always-on service (Node or Python; hosted
where long-lived connections are allowed), the **agent runtime**. Next.js on
Vercel remains the product surface and the API of record; the runtime is only
ever a *client* of it. The runtime also hosts the persistent job worker the
roadmap's proactive agents need (closing the ADR-001 gap). The runtime holds
the service-role key **only** to write its own telemetry tables
(`agent_runs`, `agent_events`, `ai_invocations`) after its own authorisation
check; it never reads user data with it.

### 3. Delegated identity: token exchange, not shared secrets
Before opening a run, the surface calls a token-exchange endpoint
(`POST /api/v1/agent/token`, to be built with the runtime) with the user's
session. The endpoint mints a **short-lived JWT** (≤15 minutes) signed with the
project's JWT secret, carrying:

| claim | value |
|---|---|
| `sub` | the user's auth id (so `auth_user_id()` and RLS resolve to them) |
| `role` | `authenticated` |
| `amc_persona` | `buyer` \| `provider` \| `ops` — must match a role the user holds (`PERSONA_REQUIRED_ROLE`) |
| `amc_run_id` | the `agent_runs.id` this token is bound to |
| `exp` | ≤ 15 minutes |

The runtime presents this token as a Bearer to `/api/v1` and to PostgREST.
Postgres sees an ordinary authenticated user; the extra claims let routes
refuse tools outside the persona's allowlist and let audit trace every call
to a run. Tokens are never persisted by the runtime beyond the run.

### 4. Tool contract lives in `@amclub/shared`
`agent.ts` is the single source of truth for personas, the per-persona tool
allowlist, the confirm gates, the task classes and their cost tiers, and the
event kinds. **Confirm gates are fixed in code, not prompts:** a tool with
`confirm: true` parks the run in `awaiting_confirmation` (state machine in
`state-machines.ts`) until the surface, never the model, records the user's
explicit yes. Unknown tools are never allowed. The allowlist is the
prompt-injection boundary: anything read from a user document, a quote thread
or a web page is data, never an instruction, and cannot widen the allowlist.

### 5. Routing: task class → tier → env-driven model id
Every model call is tagged with a task class (`AGENT_TASK_CLASSES`). The
class→tier policy is in shared (reviewable); `lib/agent/router.ts` maps tier →
model id from `AGENT_MODEL_<TIER>` env vars with defaults. All model ids are
OpenAI-compatible routes so cloud, rented GPU, an owned cluster or different
silicon is a serving-stack change, never an application change. The existing
voice parser now takes its model through the router; its default and the
`VOICE_PARSE_MODEL` override precedence are unchanged (behaviour-neutral).

### 6. Ledger: every call attributable, every run replayable
`ai_invocations` gains `run_id`, `task_class`, `tier`, `input_tokens`,
`output_tokens` (all nullable; 0026). `agent_runs` carries per-run budget
counters; `agent_events` is append-only with the same trigger + REVOKE
posture as `order_events`. These feed the two business numbers the roadmap
manages against: AI cost as a share of commission, and cost per active user
per day.

## What lands now (H0) vs later

| Now (this commit) | Later (H1+, each its own PR) |
|---|---|
| This ADR; DESIGN.md §8.6 | Agent runtime service + hosting |
| `agent.ts` contract + unit tests; agent-run state machine | `POST /api/v1/agent/token` exchange (needs `SUPABASE_JWT_SECRET`) |
| Migration 0026 + policies.sql mirror + manifest | Runner, memory builder, retrieval (pgvector) |
| `lib/agent/router.ts`; voice parser routed; ledger attribution | Conversational voice RFQ, quote-draft assistant (H1) |
| `AGENT_ENABLED` flag (default OFF; no surface) | Per-user budgets in a shared store (Upstash) |
| authz §4e checks (RLS, append-only, attribution) | Consent ledger before any external feed (H6) |

## Relationship to the Mart agents (ADR-005/006/007)

AMC Mart's dark build ships three narrow agents (Catalog, Group-Buy, Documents)
that draft and let a human confirm, recording each confirmation in
`ai_decisions`. They run inside Vercel functions because each is a single
bounded call, not a loop. This ADR does not change them. When the runtime
lands they become tools under the `provider` persona, and the two
confirmation ledgers are reconciled (FOLLOWUPS "Agent groundwork").

## Consequences

- No user-visible change. The only production behaviour change is five new
  nullable columns being populated on existing `ai_invocations` rows.
- A second service is a real operational cost (hosting, deploys, secrets).
  It is deferred until the first feature that cannot run on Vercel (H1).
- DESIGN.md §8.2 gates "AI matching" at V1.5→V2. §8.6 records the
  founder-authorised pull-forward of the **AI RFQ assistant** only (precedent:
  Phase 8b voice RFQ, built under §7.2's "no schema change" clause). The buyer
  agent with tools (A2) remains gated unless separately authorised.
- CLAUDE.md's NOT-NOW summary listed "AI matching/chatbot", which §8.3 does
  not; corrected in this commit to match the design document.
- Exit: if the programme is abandoned, 0026's tables stay empty, the flag stays
  off, and the router keeps returning the Phase 8b default. Nothing to unwind.
