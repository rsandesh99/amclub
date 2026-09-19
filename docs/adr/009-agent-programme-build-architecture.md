# ADR 009 — Agent programme: build architecture locked (runtime, delegation grants, ledgers, channels)

**Status:** Accepted, 2026-09-19. Extends ADR-008 (which stays in force). Touches auth
(delegated identity for proactive runs), the money boundary (evidence-gated payout
recommendations) and the order/RFQ state-machine boundary (§8.4). Governance: DESIGN.md
§8.6 as amended 2026-09-19 (founder authorised building the full roadmap **dark**; enablement
still follows the §8.2 gates).

Companion documents: `docs/agents/ARCHITECTURE.md` (operational detail every build prompt
reads first) and `docs/agents/BUILD_PROMPTS.md` (the staged prompts, one PR each).

## Context

ADR-008 fixed the guarantees: agents propose, the spine disposes; agents act under the user's
own session; confirm gates live in `@amclub/shared`; admin actions are never tools. It left
open the concrete choices a build needs: which runtime and host, whether to adopt an agent
framework, how a *proactive* agent (nobody is logged in) obtains a user-scoped token, which
WhatsApp path, how retrieval and budgets are implemented, and which of the two confirmation
ledgers (`ai_decisions` from Mart, `agent_events` from H0) is authoritative.

The roadmap (`AMC_Technology_Roadmap`, Aug 2026) sequences four phases: evidence engine and
cheap trust wins → internal agents → customer-facing agents (Munshi, support) → buyer agents
and trust products → rules-gated autonomy. Its standing guardrails (money always gated, the
lethal-trifecta rule, confirmed extraction, immutable audit, model economics) are restated
here as build invariants.

## Decisions

### 1. Runtime: one TypeScript service, `apps/agent-runtime`, on Fly.io (Mumbai)
- **Language/stack:** Node 22 + TypeScript, in the pnpm workspace, so it consumes
  `@amclub/shared` and the new `@amclub/agent-core` byte-for-byte with web and mobile.
  Python was rejected: a second toolchain, a second copy of every Zod contract, no gain.
- **Process shape:** a single process runs an HTTP server (Hono) for webhooks and internal
  control, and a pg-boss worker for jobs. pg-boss finally lands the persistent worker ADR-001
  deferred; the existing Vercel crons stay as-is and are migrated to pg-boss only when a job
  needs more than a cron can give.
- **Host:** Fly.io region `bom` (Mumbai), one shared-CPU machine at launch, Dockerfile +
  `fly.toml` in the app folder, deployed by a GitHub Action on `master` merges that touch the
  runtime or its packages. Data stays in `ap-south-1` Supabase; the runtime only holds
  short-lived tokens and telemetry credentials.
- **Vercel stays the API of record.** The runtime never writes user data; it calls `/api/v1`
  like a client. The only tables it writes with the service role are its own telemetry:
  `agent_runs`, `agent_events`, `ai_invocations`, `ai_decisions` (see §5), `wa_*`.

### 2. No agent framework; a deterministic runner in `@amclub/agent-core`
The roadmap suggested Claude Agent SDK + LangGraph. Neither is adopted for the first cut:
- Every agent in the roadmap is a **bounded pipeline** (assemble → extract/draft → propose →
  confirm → call one route), not an open-ended tool loop. A ~300-line runner with explicit
  steps, a step budget, and the `AGENT_RUN_TRANSITIONS` machine is easier to test with golden
  sets and easier to audit than a graph library.
- The Claude Agent SDK is a coding-agent harness tied to one vendor; ADR-008 §5 requires every
  model call to go through the task-class router to an OpenAI-compatible endpoint.
- The runner exposes one interface (`runAgent(spec, input)`); a graph library can be added
  behind it later without touching agents. Revisit when an agent genuinely needs branching
  loops (A3 negotiation is the first candidate).

### 3. Model gateway: OpenAI-compatible chat + embeddings + vision, structured JSON only
`@amclub/agent-core/llm` is the only place HTTP reaches a model vendor. Every call: task
class → tier (shared) → model id (env, `lib/agent/router.ts` policy copied into the package),
JSON-schema-constrained output validated by Zod, temperature 0 unless a prompt says
otherwise, prompt caching headers, retries with jitter, usage → paise → `ai_invocations`.
Vision (photo plausibility, document photos) uses the frontier tier through the same gateway.
Embeddings go to an OpenAI-compatible `/v1/embeddings` endpoint (`AGENT_EMBED_BASE_URL`,
`AGENT_MODEL_EMBEDDING`). Vendor today: OpenRouter (keys exist); tomorrow: any compatible
server. Speech stays on Sarvam (STT `saaras`, TTS `bulbul`), wrapped in `agent-core/voice`.

### 4. Delegated identity for proactive runs: **delegation grants**
ADR-008 §3 covers a run opened by a live session. Proactive agents (Munshi scanning RFQs at
night, payout dossiers on buyer confirmation, support replies on WhatsApp) have no session.
- New table `agent_grants` (user, persona, scopes = tool names ⊆ persona allowlist, channel
  binding such as a verified WhatsApp number, consent payload, `revoked_at`). A user creates a
  grant in Settings (web/mobile) or by an explicit WhatsApp opt-in; revocation is one tap.
- `POST /api/v1/agent/token` (Vercel) accepts **either** the user's session **or** the
  runtime's service credential (`AGENT_RUNTIME_SECRET`, HMAC over `user_id + persona +
  run_id + timestamp`) *plus* an active grant, and mints the ≤15-minute JWT from ADR-008 §3
  with `amc_persona`, `amc_run_id`, and `amc_scopes`. Postgres and every route still see an
  ordinary authenticated user; routes additionally refuse a tool outside `amc_scopes`.
- No grant, no token, no run. Grants are audited (`audit_logs`) and listed in the admin
  console.

### 5. Ledgers: `ai_decisions` is the confirmation ledger, `agent_events` is the trace
Resolves the FOLLOWUPS item. Every human yes/no on an AI proposal — Mart's three agents and
every runtime agent — is one `ai_decisions` row (refs only, as today). `agent_events` remains
the append-only per-run trace (`confirmed`/`declined` events link to the `ai_decisions.id`).
The runner writes both; Mart agents are unchanged until they move onto `agent_runs` (S2).
Durable evidence bundles that must outlive a run (payout dossiers, dispute triage) get their
own tables and reference the run.

### 6. Flags and per-agent switches
`AGENT_ENABLED` (env) stays the master switch for every agent surface and every proactive
job. Per-agent enablement, budgets, cohorts and thresholds live in a closed registry
`agent_settings` (same pattern as `mart_settings`: keys declared with Zod in shared,
edited at `/admin/agents`, every write audited). Enabling an agent for a cohort is a setting
edit, never a deploy. PostHog flags may mirror a setting for client UI only.

### 7. Budgets: Upstash counters, three caps
Per run, per user per day, and global per month (`AGENT_BUDGET_*`, defaults in shared; the
roadmap's ₹5,000/month ceiling is the initial global cap). The runner checks the caps before
**every** model call; a breach fails the run with reason `budget` and is visible in
`/admin/agents`. `agent_runs` keeps the per-run counters; Upstash keeps the rolling ones.

### 8. Channels: WhatsApp adapter with two drivers, inbound on the runtime
`agent-core/whatsapp` defines one interface (send template, send text/media, download media,
parse inbound, verify signature) with drivers `meta_cloud` (default: official Cloud API, no BSP
margin) and `interakt` (BSP fallback the checklist already planned). Outbound transactional
messages keep flowing through `apps/web/lib/notifications/channels.ts`, which now calls the
adapter. Inbound webhooks land on the runtime (always-on, media downloads, conversation
continuity) and are stored in `wa_conversations` / `wa_messages` keyed by the vendor message
id (idempotent). A WhatsApp identity binds to a user only through a grant (§4).

### 9. Untrusted content and the lethal-trifecta rule, in code
Everything an agent reads from RFQs, quotes, messages, documents, photos or web pages is
wrapped in an **untrusted envelope** (`agent-core/untrusted`): delimited, length-capped,
tagged with provenance, and the system prompt states it is data. The tool allowlist is the
only capability boundary; an agent that read untrusted content in a run can only *propose*
confirm-gated tools for the rest of that run (`runner.taint`). A red-team golden set
(`packages/agent-core/golden/injection.json`) must pass before any customer-facing agent is
enabled (S2.1), and runs in CI.

### 10. Retrieval and memory
pgvector in Supabase (`embeddings` table, `vector(1536)`, owner type + id + chunk +
provenance), ingested by a pg-boss job from packages, help, legal, provider profiles, quote
threads and order documents the user can see. Retrieval is always filtered by the same RLS
the user has (queries run under the delegated token through PostgREST RPC), never by the
service role. Agent memory (`agent_memory`) stores **confirmed** facts only (price book
entries, capabilities the provider approved), each with provenance to the confirming row.

### 11. Evidence first
The services **evidence engine** (staged milestones with photo proof and buyer confirmation)
ships before any internal agent, because every later agent consumes it. It reuses the goods
evidence path (`order_documents`, `EvidenceCapture`) and the existing `delivered → completed`
buyer confirmation; the payout gate for services orders reads milestone evidence exactly as
the goods gate reads delivery photos.

### 12. Sequencing and gates
Build order follows the roadmap's dependency logic (foundation → internal → customer-facing →
buyer/trust products → autonomy). Everything ships **dark**. Enablement per cohort follows
DESIGN.md §8.2/§8.6: A1 after the money-loop gate (25 real paid orders), A2 at V1.5→V2,
rules-gated autonomy only after six months of clean audited payout history. Agent-to-agent
negotiation and reverse auctions remain **ADR + spike only** until §8.3 is amended by the
founder in writing.

## Consequences
- Two deployables (Vercel, Fly) and one more secret set. Runtime cost ≈ one small machine.
- One new workspace package and one new app; shared contracts stay in `@amclub/shared`.
- `ai_decisions` becomes the single answer to "what did a human approve"; reports and any
  future autonomy rules read it.
- Every agent has a golden set and a red-team set; CI runs them keyless in stub mode and with
  a key when the secret is present (same three-mode pattern as `eval:golden`).
