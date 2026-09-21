import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { recordHeartbeat } from '@/lib/jobs/heartbeat'
import { AGENT_ENABLED } from '@/lib/flags'
import { enqueueRuntimeJob, NIL_UUID } from '@/lib/agent/runtime-client'

export const dynamic = 'force-dynamic'

/**
 * S1.6 — hourly: ask the runtime to abandon WhatsApp onboarding sessions past
 * their expires_at (`POST /internal/jobs/onboarding.expire` enumerates them
 * and enqueues one expire turn each). The web never touches the sessions
 * itself; with the flag off (or no runtime configured) this is a no-op that
 * still records a heartbeat. The rfq-expire cron is untouched.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  let result: { ok: boolean; jobId: string | null; reason?: string } = { ok: false, jobId: null, reason: 'agent_disabled' }
  if (AGENT_ENABLED) {
    result = await enqueueRuntimeJob('onboarding.expire', {}, { userId: NIL_UUID, persona: 'provider' })
  }
  const out = { enqueued: result.ok, jobId: result.jobId, reason: result.reason ?? null }
  await recordHeartbeat(admin, 'agent-onboarding-expire', out)
  return NextResponse.json(out)
}
