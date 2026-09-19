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
