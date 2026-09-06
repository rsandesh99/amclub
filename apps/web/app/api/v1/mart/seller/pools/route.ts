import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { getSellerCtx } from '@/lib/mart/seller'
import { listPools, listMembers, poolProgressFor } from '@/lib/mart/pools'

export const dynamic = 'force-dynamic'

/** Pools on the caller's listings; allocations (per member qty + order) once closed met. */
export async function GET() {
  const gate = martApiGate()
  if (gate) return gate
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = await createAdminClient()
  const seller = await getSellerCtx(admin, userId)
  if (!seller) return NextResponse.json({ error: 'No provider profile' }, { status: 404 })
  const all = await listPools(admin, { statuses: ['open', 'closed_met', 'closed_unmet', 'ordered', 'fulfilled'], limit: 200 })
  const mine = all.filter((p) => p.seller_id === seller.id)
  const pools = []
  for (const p of mine) {
    const allocations = ['closed_met', 'ordered', 'fulfilled'].includes(p.status)
      ? (await listMembers(admin, p.id))
          .filter((m) => m.payment_state === 'blocked' || m.payment_state === 'captured')
          .map((m) => ({ qty: m.qty, payment_state: m.payment_state, order_id: m.order_id, city: (m.delivery_snapshot as { city?: string })?.city ?? null, pickup: !!(m.delivery_snapshot as { pickup?: boolean })?.pickup }))
      : []
    pools.push({ ...p, progress: poolProgressFor(p), allocations })
  }
  return NextResponse.json({ pools }, { headers: { 'Cache-Control': 'private, no-store' } })
}
