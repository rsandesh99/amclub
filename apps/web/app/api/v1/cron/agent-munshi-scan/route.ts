import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { recordHeartbeat } from '@/lib/jobs/heartbeat'
import { AGENT_ENABLED } from '@/lib/flags'
import { enqueueRuntimeJob, NIL_UUID } from '@/lib/agent/runtime-client'

export const dynamic = 'force-dynamic'

/**
 * S2.2 — every 15 minutes: ask the runtime to run the Munshi scan
 * (`POST /internal/jobs/munshi.scan` enumerates enabled providers and opens
 * one run per provider with new matches). The web never drafts. With the
 * flag off (or no runtime configured) this is a no-op that still records a
 * heartbeat; the runtime checks the flag and the per-provider grant again.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  let result: { ok: boolean; jobId: string | null; reason?: string } = { ok: false, jobId: null, reason: 'agent_disabled' }
  if (AGENT_ENABLED) result = await enqueueRuntimeJob('munshi.scan', {}, { userId: NIL_UUID, persona: 'provider' })
  const out = { enqueued: result.ok, jobId: result.jobId, reason: result.reason ?? null }
  await recordHeartbeat(admin, 'agent-munshi-scan', out)
  return NextResponse.json(out)
}
