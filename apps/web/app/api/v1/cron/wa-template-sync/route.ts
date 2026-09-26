import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { syncWaTemplates } from '@/lib/whatsapp/admin'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * ADR-030 §3 / §6 — daily: mirror Meta's template list (status, category, rejection reason) into wa_templates, so the
 * send path can refuse a paused / re-categorised template and /admin/whatsapp shows what is approved. Not configured
 * (no WHATSAPP_WABA_ID / token) → an ok beat with `skipped`; before 0086 → `notReady` (degraded); a Graph error →
 * `errors` (degraded).
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  return runCronJob(admin, 'wa-template-sync', async () => {
    const r = await syncWaTemplates(admin)
    if (!r.configured) return { skipped: 'not_configured' }
    if (r.notReady) return { notReady: true }
    return r
  })
}
