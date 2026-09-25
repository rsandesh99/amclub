import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { AGENT_ENABLED } from '@/lib/flags'
import { cronEnqueueOutcome, enqueueRuntimeJob, NIL_UUID } from '@/lib/agent/runtime-client'

export const dynamic = 'force-dynamic'

/**
 * S2.2 — hourly: ask the runtime to run the Munshi follow-up
 * (`POST /internal/jobs/munshi.followup`: window warnings before the
 * quote-or-decline window lapses, reply drafts on quote threads with an
 * unanswered buyer message, expiry of stale drafts, and resumes of approved
 * runs the decision ping could not reach). No-op with the flag off; the
 * heartbeat is still recorded (degraded when the runtime refuses the job).
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  return runCronJob(admin, 'agent-munshi-followup', async () => {
    let result: { ok: boolean; jobId: string | null; reason?: string } = { ok: false, jobId: null, reason: 'agent_disabled' }
    if (AGENT_ENABLED) result = await enqueueRuntimeJob('munshi.followup', {}, { userId: NIL_UUID, persona: 'provider' })
    // audit M32: enqueued only with a job id (a dropped job used to read as a healthy tick)
    return cronEnqueueOutcome(result)
  })
}
