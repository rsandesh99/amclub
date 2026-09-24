import 'server-only'
import { NextResponse } from 'next/server'
import type { createAdminClient } from '@/lib/supabase/server'
import { reportOpsError, reportOpsIssue } from '@/lib/observability'
import { CRON_ERROR_PREFIX, cronRunIssues, encodeCronIssues, type CronHeartbeatStatus } from './cron-registry'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * Cron liveness AND outcome (STATUS_AUDIT B3/#5, audit M35). Every cron records a
 * heartbeat when it finishes: last_ok_at + the route's result, and (migration 0080)
 * the outcome — status 'degraded' with a short summary when the result reports
 * failures (the rules live in cron-registry.ts), else 'ok'. A run that throws marks
 * the row 'failed' (last_ok_at keeps the last run that finished). /admin renders
 * stale or failed rows red and degraded rows amber; degraded and failed runs also
 * reach Sentry. Best-effort — a heartbeat failure must never fail the job itself.
 */

const SUMMARY_MAX = 300

/** Before migration 0080 the table has no status / summary: PostgREST PGRST204, Postgres 42703. */
function missingOutcomeColumns(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST204' || error.code === '42703' || /\b(status|summary)\b.*column|column.*\b(status|summary)\b/i.test(error.message ?? '')
}

export async function recordHeartbeat(
  admin: Admin,
  name: string,
  result?: Record<string, unknown>,
): Promise<void> {
  const issues = cronRunIssues(name, result)
  const status: CronHeartbeatStatus = issues.length > 0 ? 'degraded' : 'ok'
  const summary = encodeCronIssues(issues)
  const now = new Date().toISOString()
  const beat = { name, last_ok_at: now, last_result: result ?? null, updated_at: now }
  try {
    let { error } = await admin.from('cron_heartbeats').upsert({ ...beat, status, summary }, { onConflict: 'name' })
    // Transition: code deployed before 0080 still records liveness.
    if (error && missingOutcomeColumns(error)) ({ error } = await admin.from('cron_heartbeats').upsert(beat, { onConflict: 'name' }))
    if (error) console.error('[heartbeat]', name, error.message)
  } catch (e) {
    console.error('[heartbeat]', name, e)
  }
  if (status === 'degraded') {
    console.warn(`[cron/${name}] degraded: ${summary}`)
    reportOpsIssue(`cron degraded: ${name}`, 'cron', { tags: { cron: name }, extra: { summary, result: result ?? null } })
  }
}

/** A run that threw: Sentry + the row goes 'failed' (a job that never finished keeps "never ran"). */
export async function recordHeartbeatFailure(admin: Admin, name: string, error: unknown): Promise<void> {
  reportOpsError(error, 'cron', { tags: { cron: name } })
  const message = error instanceof Error ? error.message : String(error)
  try {
    const { error: upErr } = await admin
      .from('cron_heartbeats')
      .update({ status: 'failed' satisfies CronHeartbeatStatus, summary: `${CRON_ERROR_PREFIX}${message}`.slice(0, SUMMARY_MAX), updated_at: new Date().toISOString() })
      .eq('name', name)
    if (upErr && !missingOutcomeColumns(upErr)) console.error('[heartbeat]', name, upErr.message)
  } catch (e) {
    console.error('[heartbeat]', name, e)
  }
}

/**
 * The one way a cron route runs its body (after verifyCron): the result becomes the
 * heartbeat and the JSON response; a throw is logged, reported, marked 'failed' and
 * answered 500 — never a silent green row.
 */
export async function runCronJob(admin: Admin, name: string, body: () => Promise<object>): Promise<NextResponse> {
  try {
    const result = await body()
    await recordHeartbeat(admin, name, result as Record<string, unknown>)
    return NextResponse.json(result)
  } catch (e) {
    console.error(`[cron/${name}]`, e instanceof Error ? e.message : e)
    await recordHeartbeatFailure(admin, name, e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
