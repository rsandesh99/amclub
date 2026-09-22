import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { recordHeartbeat } from '@/lib/jobs/heartbeat'
import { AGENT_ENABLED } from '@/lib/flags'
import { enqueueRuntimeJob, NIL_UUID } from '@/lib/agent/runtime-client'

export const dynamic = 'force-dynamic'

/**
 * S2.2 — hourly: ask the runtime to run the Munshi follow-up
 * (`POST /internal/jobs/munshi.followup`: window warnings before the
 * quote-or-decline window lapses, reply drafts on quote threads with an
 * unanswered buyer message, expiry of stale drafts, and resumes of approved
 * runs the decision ping could not reach). No-op with the flag off; the
 * heartbeat is still recorded.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  let result: { ok: boolean; jobId: string | null; reason?: string } = { ok: false, jobId: null, reason: 'agent_disabled' }
  if (AGENT_ENABLED) result = await enqueueRuntimeJob('munshi.followup', {}, { userId: NIL_UUID, persona: 'provider' })
  const out = { enqueued: result.ok, jobId: result.jobId, reason: result.reason ?? null }
  await recordHeartbeat(admin, 'agent-munshi-followup', out)
  return NextResponse.json(out)
}
