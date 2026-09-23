import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { recordHeartbeat } from '@/lib/jobs/heartbeat'
import { autoCancelOrder, staleOrdersForAutoCancel } from '@/lib/orders/transitions'

export const dynamic = 'force-dynamic'

/** Orders in 'placed' for >24h → auto_cancelled → refunded (100%). */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString()

  const stale = await staleOrdersForAutoCancel(admin, cutoff)

  let cancelled = 0
  for (const order of stale ?? []) {
    if (await autoCancelOrder(admin, order)) cancelled++
  }
  const result = { checked: stale.length, cancelled }
  await recordHeartbeat(admin, 'auto-cancel', result)
  return NextResponse.json(result)
}
