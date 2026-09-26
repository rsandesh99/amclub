import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { timeBudget } from '@/lib/jobs/budget'
import { processOutbox } from '@/lib/notifications/outbox'
import { outboxSwitchOn } from '@/lib/notifications/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Every minute; each run stops taking rows 15 s before this ceiling so runs rarely overlap (and a row is guarded on
// its status and attempts, so an overlap never sends twice).
export const maxDuration = 60

/**
 * ADR-030 §4 — `notification.dispatch`: claims due notification_outbox rows (queued, deferred past their time, or a
 * send whose lease expired), sends each through its channel, retries with backoff, hands an undelivered WhatsApp to
 * SMS / email and collapses the providers' 09:00 lead digest. Degraded when a notification finally failed with no
 * fallback. Before migration 0087 (or with NOTIFY_OUTBOX=off) there is nothing to process: the dispatcher sends
 * directly and this run reports `ready: false`.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const budget = timeBudget(maxDuration, 15)
  const admin = await createAdminClient()
  return runCronJob(admin, 'notify-dispatch', async () => {
    if (!outboxSwitchOn()) return { ready: false, switch: 'off' }
    return processOutbox(admin, budget)
  })
}
