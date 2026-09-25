import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { AGENT_ENABLED } from '@/lib/flags'
import { cronEnqueueOutcome, enqueueRuntimeJob, NIL_UUID } from '@/lib/agent/runtime-client'

export const dynamic = 'force-dynamic'

/**
 * S2.4 — weekly (Monday 05:00 UTC): ask the runtime to run the Munshi growth job (`POST /internal/jobs/munshi.growth`):
 * at most one informational nudge per Munshi provider per week (growth_nudge_enabled + agents_enabled.munshi + cohort +
 * the provider's grant). No-op with the flag off; the heartbeat is still recorded (degraded when the runtime refuses).
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  return runCronJob(admin, 'agent-munshi-growth', async () => {
    let result: { ok: boolean; jobId: string | null; reason?: string } = { ok: false, jobId: null, reason: 'agent_disabled' }
    if (AGENT_ENABLED) result = await enqueueRuntimeJob('munshi.growth', {}, { userId: NIL_UUID, persona: 'provider' })
    // audit M32: enqueued only with a job id (a dropped job used to read as a healthy tick)
    return cronEnqueueOutcome(result)
  })
}
