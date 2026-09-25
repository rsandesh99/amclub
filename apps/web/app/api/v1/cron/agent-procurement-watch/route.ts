import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { AGENT_ENABLED } from '@/lib/flags'
import { cronEnqueueOutcome, enqueueRuntimeJob, NIL_UUID } from '@/lib/agent/runtime-client'

export const dynamic = 'force-dynamic'

/**
 * S3.1 — every 15 minutes: ask the runtime to run the procurement watcher (`POST /internal/jobs/procurement.watch`:
 * one run per active session — new quote sets, provider questions, the chase, closing; a revoked grant or the switch
 * off closes the session and sends nothing). The web never drafts. Flag off (or no runtime): a no-op heartbeat.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  return runCronJob(admin, 'agent-procurement-watch', async () => {
    let result: { ok: boolean; jobId: string | null; reason?: string } = { ok: false, jobId: null, reason: 'agent_disabled' }
    if (AGENT_ENABLED) result = await enqueueRuntimeJob('procurement.watch', {}, { userId: NIL_UUID, persona: 'buyer' })
    // audit M32: enqueued only with a job id (a dropped job used to read as a healthy tick)
    return cronEnqueueOutcome(result)
  })
}
