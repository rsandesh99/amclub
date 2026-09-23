import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { isOnFor } from '@/lib/experiments'
import { getBuyAgainForOrder } from '@/lib/home/buy-again'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /api/v1/orders/[id]/buy-again (PRD Experience v3 E9, FR-9.3) — read-only.
 * For the buyer's own finished order: `{kind:'package', packageId, tier,
 * displayThen, displayNow, priceChanged, href}` (today's server price beside
 * what the order charged), `{kind:'similar', searchHref}` when the package or
 * its provider is paused or gone, or `{kind:'repeat', rfqId, href}` for a
 * quote order. Buying is an ordinary checkout; nothing is created here.
 * 404 unless the `home` experience is on for the caller.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isOnFor('home', userId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const delegated = await requireNotDelegated('orders/buy-again')
  if (delegated) return delegated
  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 })
  const r = await getBuyAgainForOrder(userId, id)
  if (!r.ok) return NextResponse.json({ error: r.code, code: r.code }, { status: r.status })
  return NextResponse.json(r.value, { headers: { 'Cache-Control': 'private, no-store' } })
}
