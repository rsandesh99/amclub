# ADR 009 — Agent programme: build architecture

**Status:** Accepted, 2026-09-19. Touches auth, the order/RFQ/payout
boundary, and AI cost governance (§8.4). Governance: DESIGN.md §8.6
(founder-authorised, staged). Companion to ADR-008 (the runtime topology and
delegated-identity *why*); this ADR fixes the *how* of building the programme
in `BUILD_PROMPTS.md`. Locked architecture: `docs/agents/ARCHITECTURE.md`.

## Context

ADR-008 established that agents propose and the spine disposes, that execution
that cannot fit a Vercel request lives in a second always-on runtime, and that
the runtime acts under a short-lived delegated JWT rather than the service
role. What it deliberately left open — because H0 shipped no runtime — is the
*build shape*: where the shared logic lives, how a dozen agents are added one
gated PR at a time without a second money path or a prompt-injection foothold,
and how the two confirmation ledgers (Mart's `ai_decisions` and the runtime's
runs) reconcile. This ADR settles that so every stage prompt can be executed
by an IDE agent that has the repo but not the conversation.

## Decision

### 1. Two new workspace pieces, no framework
- **`packages/agent-core`** — a "source" package (`main` → `./src/index.ts`,
  like `@amclub/shared`/`@amclub/db`), deps limited to `zod`, `postgres`,
  `@supabase/supabase-js`, `@upstash/redis`, `undici`; **no `next`**. It owns
  the model gateway, the prompt registry, the untrusted-content Envelope, the
  ledgers, the budget counters, and the runner. Both the runtime and the
  Vercel functions import it, so a bounded single-shot call and a long-running
  loop share one gateway, one cost logger, one injection boundary.
- **`apps/agent-runtime`** — Hono + pg-boss on Fly.io (Mumbai/`bom`), the only
  long-lived process and the persistent job worker ADR-001 deferred. It is a
  *client* of `/api/v1`; it holds the service role only for its own telemetry.
- **No agent framework dependency.** The runner is ours (ARCHITECTURE.md §5),
  small and testable, so the propose/confirm/taint guarantees are code we own,
  not behaviour we hope a library preserves.

### 2. Bounded work stays on Vercel; only loops go to the runtime
If a task is one model call and one optional write behind a confirm, it runs in
the Vercel function via agent-core with `run_id = null` (the voice parser is
the precedent). The runtime is reserved for multi-step loops, audio sockets,
WhatsApp conversations, and scheduled/proactive agents. This keeps the new
service's blast radius small and most agent features deployable without it.

### 3. Migrations: agent tables are NOT staged
The Mart migrations (0022–0025) are *staged* — their columns are dark until
`MART_ENABLED`, and must never be named outside `lib/mart`. **Agent migrations
are the opposite: additive and applied to prod before the writer deploys**
(RULES.md 2), because the agent tables are inert without a surface and there is
no read-path that a premature column would poison. 0027 therefore lifts
`ai_decisions` out of the staged 0022 into an always-applied table (its
`IF NOT EXISTS` in 0022 becomes a no-op on prod), so the runtime's confirm gate
does not depend on the Mart flag. Every agent migration still carries the full
ceremony: idempotent SQL, RLS + `policies.sql` mirror, Drizzle schema, and a
`verify-migrations.ts` manifest entry.

### 4. `ai_decisions` is the one confirmation ledger
The Mart agents (Catalog, Group-Buy, Documents) already record every
human-confirmed AI output in `ai_decisions`. The runtime's confirm gate writes
the same table (0027 adds `run_id` + `tool` and widens the `feature` CHECK).
There is exactly one ledger of "a human approved this AI proposal", queried by
both the Mart routes and the runner's `resume`. This is the reconciliation
ADR-008 promised, and it is why the confirm gate is auditable end to end.

### 5. Prompts are versioned files with a golden gate
Every prompt is a file `packages/agent-core/src/prompts/<id>/<version>.md` with
front-matter `{id, version, taskClass, schemaRef}`; the loader refuses an
unknown `id@version`. Each has a golden set under
`packages/agent-core/golden/` and an `eval` script that runs in **stub mode**
in CI (no key) and **live mode** where a key exists. Customer-facing agents
additionally pass the **red-team injection set** (S2.1) as a CI gate before
they may ship — S2.2 onward is blocked on it. Model ids never appear in a
prompt; only the registry and the router know them.

### 6. Delegated identity is a token exchange with grants
`POST /api/v1/agent/token` mints the ≤15-min run-bound JWT (ADR-008 §3),
signed with `SUPABASE_JWT_SECRET`, carrying `amc_persona`, `amc_run_id`,
`amc_scopes`. Two callers: a **session** (persona must map to a role the user
holds) and the **runtime** (an `AMC-Runtime` HMAC credential, which additionally
requires an active `agent_grants` row for `(user_id, persona[, channel])`).
Scopes are enforced per tool by `requireToolScope` on the wrapped routes, a
no-op for ordinary sessions (which carry no `amc_scopes` claim). The endpoint
404s while `AGENT_ENABLED=false` (the `martApiGate` pattern).

### 7. Everything ships dark, enabled per cohort
`AGENT_ENABLED` gates the whole `/api/v1/agent/*` surface. Each agent has its
own `agent_settings.agents_enabled.<name>` (default false) and a
`cohort_user_ids` allowlist. The founder flips agents from `/admin/agents`
(S0.2) and has a one-tap kill switch. No flag is enabled in code.

## Consequences

- The programme is ~15 sequential, individually-gated PRs. Each assumes the
  previous merged; none is combined; each ends with the ARCHITECTURE.md §7
  checklist ticked and the founder approving the push (RULES.md 18).
- A second always-on service is a real operating cost (Fly.io, secrets,
  deploys). It is justified only from S0.1, where the roadmap's first feature
  that cannot run on Vercel (the job worker + conversational runtime) lands.
- New secrets become go-live gates, recorded in `docs/COMPLIANCE.md`:
  `SUPABASE_JWT_SECRET`, `AGENT_RUNTIME_SECRET`, `FLY_API_TOKEN`, the LLM
  gateway base URL + key, the embedding model, and the WhatsApp BSP/Meta
  credentials.
- Money posture is unchanged: `payout.ts` stays the only money-out path,
  `PAYOUT_AUTO_RELEASE` stays OFF, and no agent gains an admin capability —
  the single future exception (S4.1 rules-gated auto-release) requires its own
  ADR-012 and six audited months of dossiers first.
- Exit: if the programme is abandoned, the runtime scales to zero, the flags
  stay off, 0027's tables sit empty, and nothing in the spine changes.
