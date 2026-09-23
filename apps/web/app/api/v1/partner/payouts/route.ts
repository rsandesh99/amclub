import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { isOnFor } from '@/lib/experiments'
import { listMyPayouts } from '@/lib/orders/queries'

/**
 * GET /api/v1/partner/payouts (PRD Experience v3 E13, flag `mobile`) — the
 * provider's payouts for the mobile Earnings tab: the same ledger rows and
 * hold reasons the web /partner/earnings page renders (listMyPayouts; own
 * rows only). 404 while the flag is off.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isOnFor('mobile', userId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ payouts: await listMyPayouts(userId) }, { headers: { 'Cache-Control': 'private, no-store' } })
}
