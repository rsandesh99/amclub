import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { recordHeartbeat } from '@/lib/jobs/heartbeat'
import { runLicenceReminders } from '@/lib/licences'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Experience v3 E9b (FR-9.5) — daily licence renewal reminders, 60 / 30 / 7
 * days before expiry, once each: `licence_reminders (licence_id, threshold)`
 * is the idempotency key, so a second run sends nothing. Sends nothing while
 * `obligations_enabled` is off (the heartbeat still records the no-op).
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  try {
    const result = await runLicenceReminders(admin)
    await recordHeartbeat(admin, 'licence-reminders', { ...result })
    return NextResponse.json(result)
  } catch (e) {
    console.error('[cron/licence-reminders]', (e as Error).message)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
