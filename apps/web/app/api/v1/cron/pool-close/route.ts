import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { MART_ENABLED } from '@/lib/flags'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { recordHeartbeat } from '@/lib/jobs/heartbeat'
import { closeDuePools, settleOpenSettlements } from '@/lib/mart/pools'

export const dynamic = 'force-dynamic'

/**
 * AMC Mart pools: close open pools past closes_at (met / unmet), then settle
 * closed_met pools (paid members → captured, lapsed → failed; → ordered /
 * fulfilled). Inert while MART_ENABLED=false: returns skipped, touches nothing.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (!MART_ENABLED) return NextResponse.json({ skipped: 'mart_disabled' })
  const admin = await createAdminClient()
  const closed = await closeDuePools(admin)
  const settled = await settleOpenSettlements(admin)
  const result = { ...closed, ...settled }
  await recordHeartbeat(admin, 'pool-close', result)
  return NextResponse.json(result)
}
