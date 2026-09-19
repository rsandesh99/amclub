# AMClub agent programme — locked architecture (read this before any agent PR)

**Authority:** ADR-008 (guarantees) + ADR-009 (build decisions) + DESIGN.md §8.6. This file is
the operational map. If a build prompt and this file disagree, this file wins; if this file
and an ADR disagree, the ADR wins and this file gets fixed in the same PR.

---

## 1. One-paragraph model

An **agent** is a bounded pipeline that runs on the **agent runtime** (`apps/agent-runtime`,
Fly.io Mumbai), reads data the user could read (under a **delegated token** that resolves to
the user in RLS), calls models through one **gateway** (task class → tier → env model id),
and can only *propose* actions. Every action that moves money, status or an outbound
commitment is a **confirm-gated tool**: the run parks in `awaiting_confirmation`, a **surface**
(web, mobile, WhatsApp) records the human's yes/no as an `ai_decisions` row, and only then does
the runtime call the ordinary `/api/v1` route. Vercel remains the API of record. Everything is
dark behind `AGENT_ENABLED` and per-agent `agent_settings`.

## 2. Repository layout (new pieces in bold)

```
apps/
  web/                         Next.js — API of record, surfaces, admin console
    app/api/v1/agent/          **token, runs, grants, confirm/decline, settings**
    app/[locale]/(admin)/admin/agents/   **runs, budgets, settings, kill switch**
    lib/agent/                 router.ts (exists) + **token.ts, grants.ts**
  mobile/                      Expo — confirm cards, grant toggle, WhatsApp deep links
  **agent-runtime/**           Hono HTTP + pg-boss worker; Dockerfile; fly.toml
    src/server.ts              /health, /webhooks/whatsapp, /internal/*
    src/worker.ts              pg-boss queues (one file per job under src/jobs/)
    src/agents/<name>/         one folder per agent: spec.ts, steps.ts, prompts/, golden/
packages/
  shared/                      contracts only (zero runtime deps except zod)
    src/agent.ts               personas, tools, confirm flags, task classes, event kinds
    src/agent-settings.ts      **closed registry of agent_settings keys (Zod per key)**
    src/state-machines.ts      AGENT_RUN_TRANSITIONS (exists)
  **agent-core/**              runtime library, no Next imports
    src/llm/                   gateway: chat(json-schema), embed, vision; usage → paise
    src/runner/                runAgent(), steps, taint, budgets hook, ledger hooks
    src/ledger/                agent_runs / agent_events / ai_invocations / ai_decisions writers
    src/budget/                Upstash counters (run / user-day / global-month)
    src/whatsapp/              adapter interface + drivers meta_cloud, interakt; templates
    src/voice/                 Sarvam STT (saaras) + TTS (bulbul)
    src/untrusted/             envelope(), strip(), provenance
    src/prompts/               versioned prompt registry (id@version) + loader
    golden/                    <prompt-id>.json golden sets + injection.json red-team set
  db/                          migrations 0027+ (agent tables), policies.sql mirror, schema
docs/agents/                   this file, BUILD_PROMPTS.md, per-agent runbooks
```

## 3. Data model (all additive, RLS from birth, every write audited)

| Table | Purpose | Notes |
|---|---|---|
| `agent_runs`, `agent_events` (0026) | run + append-only trace | add `parent_run_id`, `job_id`, surface value `system` |
| `ai_invocations` (0013+0026) | every model call | `run_id`, `task_class`, `tier`, tokens, paise |
| `ai_decisions` (0022) | **every human yes/no on an AI proposal** | Mart + runtime; refs only |
| `agent_settings` (0027) | closed registry KV | like `mart_settings`; keys in shared |
| `agent_grants` (0027) | delegation: user × persona × scopes × channel | revocable; drives token exchange |
| `wa_conversations`, `wa_messages` (0027) | WhatsApp identity + idempotent message log | vendor message id unique |
| `order_milestones` (+0028) | services evidence engine | `kind`, `photo_doc_id`, `note`, `created_by` |
| `rfq_clarifications` (0029) | pre-quote Q&A | visible to all matched providers |
| `quotes` (+0029) | `extracted`, `extraction_confirmed_at`, `comparability`, `decline_reason`, `decline_message`, `revision` | |
| `payout_dossiers` (0030) | evidence bundle + recommendation + founder decision | references run |
| `provider_price_book`, `agent_memory`, `embeddings` (0031) | Munshi memory + retrieval | confirmed facts only; pgvector |
| `provider_scores`, `buyer_scores`, `score_events` (0032) | AMC Score v1 + two-way rating | versioned, explainable |
| `price_benchmarks` (0033) | fair-price ranges | density-gated |
| `order_guarantees` (0034) | first-order guarantee | ADR-010 |
| `payout_release_rules` (0035) | rules-gated autonomy safe zone | ADR-011 |

Migrations 0027+ are **not staged**: apply to prod *before* deploying the writer (additive),
exactly as 0026 was. Anything that touches a Mart table follows the staged rule instead.

## 4. Identity and authorisation

1. **Live surface run:** surface calls `POST /api/v1/agent/token` with the user's session →
   ≤15 min JWT (`sub`, `role=authenticated`, `amc_persona`, `amc_run_id`, `amc_scopes`).
2. **Proactive run:** runtime calls the same endpoint with `Authorization: AMC-Runtime
   <hmac>` + `{user_id, persona, run_id}`; the endpoint requires an active `agent_grants`
   row and returns the same JWT with `amc_scopes` = the grant's scopes.
3. Every `/api/v1` route that a tool wraps checks: JWT valid → persona's role held by the
   user (`PERSONA_REQUIRED_ROLE`) → tool ∈ `amc_scopes` → normal rate limit → normal handler.
   PostgREST sees an ordinary user; RLS applies unchanged.
4. Admin actions are never scoped: `amc_scopes` can never contain a `/admin/*` writer.
5. The runtime's service role is used only for its own telemetry tables, after its own check.

## 5. The runner contract (`@amclub/agent-core/runner`)

```ts
runAgent({ spec, input, token, runId, surface, budget })
  // spec: { name, persona, steps: Step[], maxSteps, taskClassesUsed }
  // Step: (ctx) => Promise<Propose | Continue | Done>
  // Propose: { tool, payload, rationale } → if confirm: park (awaiting_confirmation)
  //                                          else: call /api/v1 now, record tool_called
  // ctx.llm(taskClass, prompt@version, schema, untrustedParts) → validated JSON
  // ctx.taint(): true once any untrusted envelope entered the run → unconfirmed tools refused
```
Rules the runner enforces (tests in `packages/agent-core/src/runner/*.test.ts`):
- transitions only via `isValidAgentRunTransition`; `completed|failed|cancelled` are terminal;
- a `confirm:true` tool is never called without an `ai_decisions` row of `decision='approved'`
  whose `run_id` + `tool` match;
- budget check precedes every model call; breach → `failed` with `error='budget:<cap>'`;
- every model call writes `ai_invocations` (best-effort, never blocks);
- every prompt is loaded by `id@version` from the registry; ad-hoc strings are refused;
- untrusted parts are always passed through `envelope()`; the runner refuses raw strings.

## 6. Model policy (from shared; edit there, never in an agent)

| task class | tier | used by |
|---|---|---|
| speech_to_text / text_to_speech | live (Sarvam) | every voice surface |
| rfq_parse, rfq_clarify, rfq_quality | routine / live | voice RFQ, quality agent |
| quote_extract, decline_message, translation, embedding | routine | quote features, Munshi intake |
| quote_draft, quote_compare, support_reply, onboarding_interview | reasoning | Munshi, compare helper, support |
| document_extract, photo_plausibility, dispute_summary, benchmark_explain | frontier | dossiers, documents, triage |

Cost telemetry: `ai_invocations.cost_est_paise` summed per run, per user-day, per month;
`/admin/agents` shows AI cost as % of commission (the roadmap's managed number).

## 7. Invariants checklist (copy into every agent PR description)

- [ ] Agent calls only `/api/v1` routes under a delegated token; no service-role reads of user data
- [ ] Every money/status/outbound tool is `confirm:true` in `packages/shared/src/agent.ts`
- [ ] Untrusted content enters only through `envelope()`; taint refuses unconfirmed tools
- [ ] Extraction from human text is confirmed by that human before it becomes data
- [ ] `ai_decisions` row for every yes/no; `agent_events` trace for the run
- [ ] Golden set + (for customer-facing) injection set added and passing in stub mode
- [ ] Budgets enforced; cost visible in `/admin/agents`
- [ ] Ships dark: `AGENT_ENABLED` + `agent_settings` key; inert when off (verify script)
- [ ] i18n: every user-visible string via next-intl (en + hi; te where the surface has it)
- [ ] Docs: ADR if money/auth/state machine; FOLLOWUPS; runbook under `docs/agents/`

## 8. Verification conventions

- `pnpm turbo run typecheck lint` · `pnpm --filter @amclub/shared test` ·
  `pnpm --filter @amclub/agent-core test` · `pnpm --filter @amclub/web mart:static`
- `pnpm --filter @amclub/agent-core eval` — golden + injection sets (keyless stub mode in CI;
  live when `OPENROUTER_API_KEY` is set), same three-mode pattern as `eval:golden`.
- `apps/web/scripts/verify-agents.ts` — HTTP-level killtest: token exchange authz, grant
  revocation, confirm gate cannot be bypassed, `AGENT_ENABLED=false` inertness (every
  `/api/v1/agent/*` → 404, runtime jobs → `skipped`). Kill-test rows only, zero residue.
- Local DB on Windows: Docker Desktop + Supabase CLI (`supabase start`), then
  `pnpm --filter @amclub/db db:bootstrap -- --url <local url>`; or a plain Postgres 16 (the
  bootstrap script shims `auth.*`).
- Runtime locally: `pnpm --filter @amclub/agent-runtime dev` with `.env.local` mirroring
  `apps/agent-runtime/.env.example`; jobs can be triggered by `POST /internal/jobs/<name>`
  with `AGENT_RUNTIME_SECRET`.

## 9. Environment variables (new; add to `.env.example` and `lib/env.ts`)

```
AGENT_ENABLED=false
AGENT_RUNTIME_URL=https://amclub-agent-runtime.fly.dev
AGENT_RUNTIME_SECRET=<32+ random>            # shared Vercel ↔ runtime
SUPABASE_JWT_SECRET=<project jwt secret>     # token exchange signing (Vercel only)
AGENT_MODEL_LIVE / _ROUTINE / _REASONING / _FRONTIER   # exist
AGENT_EMBED_BASE_URL=https://openrouter.ai/api/v1
AGENT_MODEL_EMBEDDING=openai/text-embedding-3-small
AGENT_BUDGET_RUN_PAISE=2000
AGENT_BUDGET_USER_DAY_PAISE=5000
AGENT_BUDGET_MONTH_PAISE=500000
WHATSAPP_DRIVER=meta_cloud                   # or interakt
WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN / WHATSAPP_VERIFY_TOKEN / WHATSAPP_APP_SECRET
INTERAKT_API_KEY                              # only when driver=interakt
SARVAM_API_KEY (exists) · OPENROUTER_API_KEY (exists) · UPSTASH_* (exist)
DATABASE_URL (runtime only; pg-boss schema `pgboss`)
```

## 10. Stage map (details in BUILD_PROMPTS.md)

| Stage | PRs | Ships |
|---|---|---|
| S0 Foundation | S0.1–S0.5 | agent-core + runtime + token/grants, admin console, evidence engine, trust mechanics, WhatsApp rails |
| S1 Internal agents + specced quote features | S1.1–S1.8 | quote extraction, compare + decline loop, clarifications, payout dossier, RFQ quality, onboarding, dispute triage, conversational voice RFQ + document/drawing intake |
| S2 Customer-facing | S2.1–S2.4 | injection hardening gate, Digital Munshi, support agent, two-way rating + AMC Score v1 |
| S3 Buyer agents + trust products | S3.1–S3.4 | procurement agent, benchmark pricing, first-order guarantee, demand aggregation + tiered quotes |
| S4 Autonomy | S4.1–S4.3 | rules-gated micro-payouts, public AMC Score, negotiation ADR/spike |
