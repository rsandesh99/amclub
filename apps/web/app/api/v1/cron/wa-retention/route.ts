import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { timeBudget } from '@/lib/jobs/budget'
import { runWaRetention } from '@/lib/privacy/retention'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * ADR-030 §6 / D-WA5 — daily WhatsApp retention: redact text after wa_retention_text_days, delete media after
 * wa_retention_media_days, delete never-bound numbers after wa_retention_unknown_days; legal holds kept. Bounded
 * batches inside the time budget. Before 0086 it skips with `notReady` (a degraded heartbeat).
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  return runCronJob(admin, 'wa-retention', () => runWaRetention(admin, timeBudget(maxDuration)))
}
