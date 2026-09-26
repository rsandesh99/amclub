import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { timeBudget } from '@/lib/jobs/budget'
import { runReminders } from '@/lib/notifications/reminders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * ADR-030 §4 / DESIGN §5.9 — hourly deadline reminders (accept-by, review-by, request expiring, pool pay-by). Each
 * stage is claimed once in notification_reminders, so a second run sends nothing. Degraded while migration 0087 is
 * not applied (nothing can be claimed, so nothing is sent) or when a step fails.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const budget = timeBudget(maxDuration)
  const admin = await createAdminClient()
  return runCronJob(admin, 'notify-reminders', () => runReminders(admin, budget))
}
