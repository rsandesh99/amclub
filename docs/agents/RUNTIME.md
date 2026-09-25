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
| `FLY_API_TOKEN` | `fly tokens create deploy -a amc-agent-runtime` (app-scoped, never an org token) | CI deploy (GitHub Environment `production` secret; see "Deploy credentials" below) |
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
once `FLY_API_TOKEN` is set; until then the deploy steps are skipped.

## Deploy credentials (audit M26)

The Fly token can deploy code to the machine that holds `SUPABASE_SERVICE_ROLE_KEY`
and `DATABASE_URL`, so it is scoped as narrowly as Fly and GitHub allow. What the
workflow already does:

- Every action is pinned to a full commit SHA (the tag is in the trailing comment),
  and flyctl to an exact version (`with: version:`). Bump both deliberately.
- `permissions: contents: read`; checkout does not persist git credentials.
- The job runs only for `refs/heads/master` (a `workflow_dispatch` from another
  branch is skipped) and uses `environment: production`.
- `concurrency: fly-deploy` with `cancel-in-progress: false`: one deploy at a time,
  never cancelled half-way.
- The token reaches the shell only through `env`, never interpolated into a script.
- The root `.dockerignore` keeps `.git`, `.env*`, `node_modules`, docs and the other
  apps out of the build context; the image runs as the unprivileged `node` user.

Operator steps (once; GitHub and Fly settings, not code):

1. **App-scoped deploy token.** From a machine logged in to Fly:
   ```bash
   fly tokens create deploy -a amc-agent-runtime --expiry 8760h --name github-actions
   ```
   A deploy token can deploy and manage this one app only. Never use an org or
   personal token (`fly auth token`): those also reach every other app and
   `fly ssh` / secrets across the org. Rotate yearly (the expiry above) and at once
   if the repo or a maintainer account is compromised:
   `fly tokens list -a amc-agent-runtime`, then `fly tokens revoke <id>`.
2. **GitHub Environment `production`.** Repo → Settings → Environments → New
   environment → `production`:
   - *Deployment branches and tags* → "Selected branches and tags" → add `master` only.
   - *Required reviewers* → add the founder, if the plan offers it (it is not
     available for private repos on every plan). With a reviewer, every deploy
     waits for an approval click in the Actions run.
   - *Environment secrets* → add `FLY_API_TOKEN` = the token from step 1.
3. **Remove the repo-level secret.** Repo → Settings → Secrets and variables →
   Actions → delete any repository secret `FLY_API_TOKEN`. An environment secret
   is readable only by jobs that name the environment and pass its branch rule; a
   repository secret is readable by every workflow on every branch.
4. **Check.** Push a runtime change to `master` (or run the workflow by hand on
   `master`): the run shows the `production` environment, and "Guard" reports
   `armed=true`. A manual run on any other branch shows the job as skipped.

GitHub offers Environment secrets and branch rules on private repos only on paid
plans (Pro / Team / Enterprise). Without them, skip steps 2–3 and keep
`FLY_API_TOKEN` as a repository secret: the master-only `if:` and the app-scoped
token still bound it. Move it into the Environment when the plan allows. The first
run after this change shows whether the plan accepts `environment: production`; if
that run is refused because of the environment, delete that one line from the job.

## Health & smoke

- `GET https://amc-agent-runtime.fly.dev/health` → `{ ok, missing: [...], degraded: [...], worker, residency }`
  (`missing` lists any unset required config). Audit M33 / M23:
  - `worker` = `{ state: disabled | starting | running | failed | stopped, databaseUrl, since, queues,
    lastErrorAt, lastSweep: { pending, requeued, stale, error, at } }` (the error text stays in the logs — the
    endpoint is public). `requeued > 0` means inbound WhatsApp
    messages were stored but never processed until the sweep re-drove them; `stale > 0` means some older than
    6 h were never processed (look at the logs for that window).
  - `residency` = `{ mode, required }`, the model gateway's posture (`enforced | waived | unconfigured | opt_in`,
    see `docs/agents/SECURITY.md`); `unconfigured` means every model call carrying user data is refused. The
    waiver reason is logged at boot and shown on `/admin/agents`, not here.
  - HTTP **503** while `AGENT_ENABLED=true` and the worker is not `running` (the Fly check turns red).
- The process **exits** when the worker cannot start (Fly restarts the machine) — it used to log and keep
  serving while nothing processed the stored messages.

## Queues (audit M32)

Every pg-boss queue is declared once in `apps/agent-runtime/src/queues.ts` (`Q`) and created by `startWorker`
before the first send; pg-boss v10 silently drops a send to a queue that was never created (that is how the
weekly `agent.munshi.growth` job never ran). A send that inserts nothing throws `enqueue_dropped:<queue>` —
`POST /internal/jobs/:name` answers 503 — unless it is a singleton collision (an overlapping cron tick), which
answers `{ ok: true, jobId: null, deduped: true }`. The web crons record `enqueued: jobId != null` (+ `deduped`,
`reason`) in their heartbeat (`cronEnqueueOutcome`). `pnpm --filter @amclub/agent-runtime test` proves it
(`queues.test.ts`: every queue worked / scheduled / sent to was created, and a static check that every
`send` / `work` / `schedule` names a registry entry).

| queue | policy | fed by |
|---|---|---|
| `agent.run` | pg-boss default | `POST /internal/jobs/hello` |
| `wa.inbound` | retry 2 × 30 s; job id = message id | the webhook, the sweep |
| `wa.inbound.sweep` | no retry; pg-boss cron `* * * * *` | the runtime itself |
| `agent.payout_dossier`, `agent.dispute_triage` | retry 2 × 300 s | web triggers |
| `agent.onboarding` | retry 1 × 60 s | web start route, the inbound job, `onboarding.expire` |
| `agent.munshi.scan` / `.followup` / `.growth` | no retry; singleton per tick | web crons |
| `agent.munshi.decide` | retry 1 × 60 s | the inbound job |
| `agent.support.reply` / `.decide` | retry 1 × 60 s | the inbound job |
| `agent.procurement.turn` / `.decide` | retry 1 × 60 s | the inbound job, web composer / taps |
| `agent.procurement.watch` | no retry; singleton per tick | web cron |

**Module format.** The runtime package is CommonJS (no `"type": "module"`). Under ESM, Node could not see the
named exports that the source packages (`@amclub/shared`, `@amclub/agent-core`, compiled by tsx as CommonJS)
re-export with `export *`, so `node --import tsx src/main.ts` (the Dockerfile's CMD) died at the first import
(`does not provide an export named 'agentSettingDefault'`) — reproduced on 2026-09-24 (Node 22, tsx 4.22) both in
a checkout and in the `pnpm deploy` layout the image runs. As CommonJS it boots in both (`[server] agent-runtime
listening`). The verify rigs never saw this: they `require()` the runtime modules from CommonJS scripts. The
Dockerfile's `pnpm deploy --legacy` also failed the image build (pnpm 9.15, the `packageManager` pin, has no such
flag); it is plain `pnpm deploy` now. So no image built from the Dockerfile before this fix could have served.
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

## Migration note (0079)

`0079_whatsapp_inbound_binding.sql` is **NOT staged** — apply it before (or with) the runtime deploy: it adds
`wa_messages.processed_at` (default `now()`, so history is never re-driven) + a partial index for the sweep, and
the `users.phone` trigger that unbinds a number's conversations and revokes its WhatsApp grants when the phone
changes. The runtime tolerates its absence (stores without the column, logs once; the sweep reports
`sweep_read_failed`). Rollback: `DROP TRIGGER users_phone_change_wa_unbind ON users; DROP FUNCTION
wa_unbind_on_phone_change(); DROP INDEX wa_messages_unprocessed_in_idx; ALTER TABLE wa_messages DROP COLUMN
processed_at;` after reverting the runtime.

## Migration note (0027)

`0027_agent_foundation.sql` is **NOT staged** — apply it to prod **before/with**
the writer deploy (RULES.md 2): it lifts `ai_decisions` into an always-applied
table (`CREATE TABLE IF NOT EXISTS` — a no-op where it already exists) and adds
`agent_settings` + `agent_grants`. Verify with
`DATABASE_URL= MART_MIGRATIONS_EXPECTED=false pnpm --filter @amclub/web exec tsx scripts/verify-migrations.ts`.
