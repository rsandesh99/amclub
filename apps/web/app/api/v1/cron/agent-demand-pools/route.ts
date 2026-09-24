import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { recordHeartbeat } from '@/lib/jobs/heartbeat'
import { poolsOn } from '@/lib/pools/core'
import { proposePools } from '@/lib/pools/detect'
import { runPoolClock } from '@/lib/pools/close'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Hourly (S3.4, ADR 024) — the demand-aggregation agent (code, no model): the clock first (lapse groups past form_by,
 * close groups past closes_at, resume a close that stopped), then detection (propose / top up groups). With
 * AGENT_ENABLED or agents_enabled.demand_aggregation off it touches no pool table and records a no-op heartbeat.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  try {
    if (!(await poolsOn(admin))) {
      await recordHeartbeat(admin, 'agent-demand-pools', { enabled: false })
      return NextResponse.json({ enabled: false })
    }
    const clock = await runPoolClock(admin)
    const detect = await proposePools(admin)
    const result = { enabled: true, lapsed: clock.lapsed, closed: clock.closed.length, quotes: clock.closed.reduce((a, c) => a + c.quotes, 0), proposed: detect.proposed, invited: detect.invited }
    await recordHeartbeat(admin, 'agent-demand-pools', result)
    return NextResponse.json(result)
  } catch (e) {
    console.error('[cron/agent-demand-pools]', (e as Error).message)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
