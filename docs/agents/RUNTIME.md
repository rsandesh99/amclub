# RUNTIME.md — deploying the agent runtime (S0.1)

`apps/agent-runtime` is the always-on service (ADR-008 §2, ADR-009 §1): Hono +
pg-boss on **Fly.io, region `bom` (Mumbai)**, one machine, next to the
`ap-south-1` Supabase. It is a **client** of `/api/v1` — it never holds a user
session; it mints a ≤15-min delegated JWT by calling
`POST /api/v1/agent/token` with its HMAC credential, and holds the service role
only to write its own telemetry (`agent_runs` / `agent_events` /
`ai_invocations` / `ai_decisions`).

Everything here is **dark**: nothing runs for a user until `AGENT_ENABLED=true`
on the web app **and** the agent's `agent_settings.agents_enabled.<name>` flag +
cohort allowlist are flipped from `/admin/agents` (S0.2).

**Web-side readiness (2026-09-24).** `payout_dossier`, `onboarding`, `dispute_triage`, `munshi` and `procurement` (shared `RUNTIME_AGENTS`) read as **off** while the web app lacks any of these: `AGENT_RUNTIME_URL`, `AGENT_RUNTIME_SECRET` or `SUPABASE_JWT_SECRET`.
- The check is shared `agentRunnable` inside `isAgentEnabledForUser`.
- Their pages 404 and their triggers skip, instead of silently never answering.
- `/admin/agents` shows a "runtime not configured" banner that lists them.
- Their switches stay as set, so they come on by themselves once the web app has all three values and the runtime is deployed.
- The bounded Vercel agents and the support web chat don't need the runtime.

## Founder-gated externals (enable, not build)

Recorded in `docs/COMPLIANCE.md`. None is needed to build/verify S0.1; all are
needed to turn it on:

| secret | where | purpose |
|---|---|---|
| `SUPABASE_JWT_SECRET` | Supabase dashboard → Settings → API → JWT Secret | web signs the delegated JWT with it |
| `AGENT_RUNTIME_SECRET` | `openssl rand -hex 32` | HMAC shared by web ↔ runtime |
| `FLY_API_TOKEN` | Fly.io → tokens | CI deploy (repo secret) |
| `AGENT_LLM_API_KEY` | LLM gateway (or reuse `OPENROUTER_API_KEY`) | model calls; absent ⇒ stub mode |
| `AGENT_MODEL_EMBEDDING`, `AGENT_EMBED_BASE_URL` | gateway | retrieval (later stages) |
| `UPSTASH_REDIS_REST_URL/TOKEN` | reuse the web rate-limit Upstash | budget counters |

## First deploy

```bash
# 1. Create the app (once), from the repo root:
fly apps create amc-agent-runtime

# 2. Set secrets (fly stores them; never commit):
fly secrets set --app amc-agent-runtime \
  API_URL="https://<web-app-url>" \
  AGENT_RUNTIME_SECRET="<hex32>" \
  NEXT_PUBLIC_SUPABASE_URL="https://<project>.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="<service-role-key>" \
  DATABASE_URL="postgres://…"  \
  AGENT_ENABLED="true" \
  AGENT_LLM_API_KEY="<gateway-key>" \
  UPSTASH_REDIS_REST_URL="<url>" UPSTASH_REDIS_REST_TOKEN="<token>"

# 3. Deploy (repo-root build context so the pnpm workspace resolves):
fly deploy --config apps/agent-runtime/fly.toml \
  --dockerfile apps/agent-runtime/Dockerfile --remote-only .

# 4. Set the matching secrets on the WEB app (Vercel):
#    SUPABASE_JWT_SECRET, AGENT_RUNTIME_SECRET, AGENT_RUNTIME_URL=https://amc-agent-runtime.fly.dev
```

CI (`.github/workflows/agent-runtime.yml`) redeploys on `master` when
`apps/agent-runtime/**` or `packages/{shared,agent-core}/**` change — but only
once `FLY_API_TOKEN` is a repo secret; until then the deploy step is skipped.

## Health & smoke

- `GET https://amc-agent-runtime.fly.dev/health` → `{ ok, missing: [...] }`
  (`missing` lists any unset required config).
- Internal endpoints (`/internal/runs/:id/resume`, `/internal/jobs/:name`)
  require a valid `AMC-Runtime` HMAC and are not publicly usable.

### Smoke: enqueue a payout dossier by hand (S1.4)

The web trigger does this automatically when a payout is born held; to exercise
the job directly (local runtime, `DATABASE_URL` set, `AGENT_ENABLED=true` on
the web, ops grant + `ops_user_id` set — see `docs/agents/PAYOUT_DOSSIER.md`):

```bash
# credential = signRuntimeCredential(AGENT_RUNTIME_SECRET, { userId: <ops_user_id>, persona: 'ops', runId: '00000000-0000-0000-0000-000000000000' })
curl -X POST "$AGENT_RUNTIME_URL/internal/jobs/payout_dossier" \
  -H "Authorization: AMC-Runtime $CRED" -H "Content-Type: application/json" \
  -d '{"open":{"userId":"<ops_user_id>","surface":"system","subjectType":"order","subjectId":"<order_id>"},"input":{"orderId":"<order_id>","payoutId":"<payout_id>"}}'
```

The job lands on queue `agent.payout_dossier` (retryLimit 2, retryDelay 300 s);
`agent_disabled` / `no_ops_grant` fail the run without a retry. Result:
a `payout_dossiers` row for the order and one `payout_dossier_ready`
notification to the ops user.

### S1.6 — the onboarding queue and cron

Queue `agent.onboarding` (retryLimit 1, retryDelay 60 s): one job per turn —
`{ kind:'start', sessionId }` (the web start route via
`POST /internal/jobs/onboarding`, or JOIN from the inbound job),
`{ kind:'message', sessionId, messageId }` (every inbound message of an active
session, enqueued by the `wa.inbound` job) and `{ kind:'expire', sessionId }`.
Turns are idempotent through guarded state updates; `session_terminal`,
`session_not_found`, `message_not_found` and `budget_*` never retry.

Cron: the web `GET /api/v1/cron/agent-onboarding-expire` (hourly, Vercel)
calls `POST /internal/jobs/onboarding.expire`, which enumerates sessions past
`expires_at` and enqueues one expire turn each; with the flag off there are
no sessions. Runbook: `docs/agents/ONBOARDING.md`.

## Rollback

The runtime holds no state of its own (runs/events live in Postgres). To stop it
instantly:

```bash
fly scale count 0 --app amc-agent-runtime     # rollback = scale to zero
```

The web surfaces stay dark on their own flags, so scaling the runtime to zero
never breaks the spine — bounded agent calls (run_id=null) run on Vercel
regardless, and with `AGENT_ENABLED=false` even those 404.

## Migration note (0027)

`0027_agent_foundation.sql` is **NOT staged** — apply it to prod **before/with**
the writer deploy (RULES.md 2): it lifts `ai_decisions` into an always-applied
table (`CREATE TABLE IF NOT EXISTS` — a no-op where it already exists) and adds
`agent_settings` + `agent_grants`. Verify with
`DATABASE_URL= MART_MIGRATIONS_EXPECTED=false pnpm --filter @amclub/web exec tsx scripts/verify-migrations.ts`.
