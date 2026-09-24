# @amclub/agent-runtime

The always-on runtime (ADR-008 §2, ADR-009 §1): Hono + pg-boss on Fly.io
(Mumbai/`bom`). The ONLY long-lived process — loops, the job worker, and later
audio/WhatsApp conversations. It is a **client** of `/api/v1`, acting under a
delegated JWT it mints via `POST /api/v1/agent/token` with its HMAC credential;
it holds the service role ONLY to write its own telemetry.

Deploy, secrets, and rollback live in **`docs/agents/RUNTIME.md`**.

## Local dev

```bash
pnpm --filter @amclub/agent-runtime typecheck
pnpm --filter @amclub/agent-runtime test    # node:test via tsx: queue registry, WhatsApp binding / confirmations / sweep / media
pnpm --filter @amclub/agent-runtime dev     # tsx watch; GET http://localhost:8080/health
```

Without `DATABASE_URL` the job worker is disabled but `/health` still serves
(`worker.state = disabled`). A worker that fails to start exits the process.
Without an LLM key, agent-core runs in stub mode (no bill). The package is
CommonJS on purpose (see `docs/agents/RUNTIME.md` "Module format").

## Endpoints (internal — require the `AMC-Runtime` HMAC credential)

- `GET  /health` — liveness, missing config, the worker state + last inbound sweep, the residency posture
  (503 while agents are on and the worker is not running).
- `POST /internal/runs/:id/resume` — resume a parked run after the surface
  approved it (verifies the `ai_decisions` row before calling the tool).
- `POST /internal/jobs/:name` — enqueue a job on the `agent.run` pg-boss queue.
