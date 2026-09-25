import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { AGENT_ENABLED } from '@/lib/flags'
import { cronEnqueueOutcome, enqueueRuntimeJob, NIL_UUID } from '@/lib/agent/runtime-client'

export const dynamic = 'force-dynamic'

/**
 * S2.2 — every 15 minutes: ask the runtime to run the Munshi scan
 * (`POST /internal/jobs/munshi.scan` enumerates enabled providers and opens
 * one run per provider with new matches). The web never drafts. With the
 * flag off (or no runtime configured) this is a no-op that still records a
 * heartbeat; the runtime checks the flag and the per-provider grant again.
 * A runtime that refuses or does not answer marks the beat degraded.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  return runCronJob(admin, 'agent-munshi-scan', async () => {
    let result: { ok: boolean; jobId: string | null; reason?: string } = { ok: false, jobId: null, reason: 'agent_disabled' }
    if (AGENT_ENABLED) result = await enqueueRuntimeJob('munshi.scan', {}, { userId: NIL_UUID, persona: 'provider' })
    // audit M32: enqueued only with a job id (a dropped job used to read as a healthy tick)
    return cronEnqueueOutcome(result)
  })
}
