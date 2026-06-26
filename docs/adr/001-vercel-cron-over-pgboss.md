# ADR 001 — Vercel Cron for scheduled jobs instead of pg-boss (Phase 4)

**Status:** Accepted · **Date:** 2026-06-25 · **Touches:** money/order pipeline (§8.4)

## Context

§2.2 specifies **pg-boss** (Postgres-backed queue) as the V1 job runner. Phase 4
needs four recurring jobs: 24h auto-cancel, 72h auto-accept, daily payout batch,
daily reconciliation.

pg-boss requires a **persistent Node worker** polling Postgres. The platform is
**Vercel (serverless)** — there is no long-running process to host that worker.
Running pg-boss would mean standing up a separate always-on service.

## Decision

Use **Vercel Cron** + idempotent API routes for the Phase 4 jobs.

**Hobby-plan constraint (learned the hard way):** the Hobby plan allows **≤2 cron
jobs, daily frequency only**. The initial config (4 crons, 2 hourly) made Vercel
**reject the deployment**. Collapsed to a single daily tick:

| Cron | Route | Schedule | Runs |
|---|---|---|---|
| Daily tick | `/api/v1/cron/daily` | daily 04:00 | auto-cancel → auto-accept → payouts → reconcile, in sequence |

The individual routes (`/api/v1/cron/auto-cancel|auto-accept|payouts|reconcile`)
are kept for tests and for Pro-plan fine-grained schedules, but only the combined
`daily` route is registered in `vercel.json`. On Pro, split them back out and
raise auto-cancel/auto-accept to hourly.

Each route is **idempotent** (claims work via status CAS / unique constraints),
authorised with `CRON_SECRET` (`verifyCron`), and reuses the same order/payment
logic as the live request paths. The jobs are all **time-based**, which maps
cleanly to cron — no queue semantics are needed in Phase 4.

## Consequences

- No separate worker to host or monitor; jobs are just deployable routes.
- Schedules are coarser than a queue (minute-level at best); acceptable for 24h/
  72h/daily windows. Hourly cancel/accept jobs are well within tolerance.
- **Vercel plan note:** cron frequency/count is plan-limited (Hobby ≈ daily / 2
  crons). On a constrained plan, collapse to daily and widen the SLA, or move the
  worker to Supabase `pg_cron`.
- If true **event-driven async** work appears later (e.g. fan-out, retries with
  backoff), revisit: introduce pg-boss on a dedicated worker or Supabase Edge
  Functions. This ADR covers time-based jobs only.

## Alternatives considered

- **pg-boss on a separate worker** (Railway/Render): faithful to §2.2 but adds an
  always-on service + ops surface for four periodic jobs. Deferred until queue
  semantics are actually required.
- **Supabase `pg_cron`**: keeps scheduling in Postgres; viable fallback if Vercel
  cron limits bite. Chose Vercel Cron first to keep job logic in one TypeScript
  codebase with the rest of the API.
