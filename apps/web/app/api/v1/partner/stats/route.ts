import { NextResponse } from 'next/server'
import { summarizeProviderOrders } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { listMatchedRfqsForProvider } from '@/lib/rfq/queries'

/**
 * GET /api/v1/partner/stats (E0 / U8) — the provider home's numbers for the
 * caller's OWN provider profile: open matched RFQs, active and completed
 * orders, and completed earnings in paise. Computed on the server so mobile
 * stops showing hard-coded zeros (and never sums money itself). No id
 * parameter: the provider is resolved from the session. Not an agent tool.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('partner/stats')
  if (delegated) return delegated
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const [{ data: orders }, rfqs] = await Promise.all([
    admin.from('orders').select('status, provider_earning_paise').eq('provider_id', actor.providerId),
    listMatchedRfqsForProvider(userId),
  ])
  const stats = summarizeProviderOrders(orders ?? [])
  return NextResponse.json(
    { openRfqCount: rfqs.filter((r) => r.outcome === 'open').length, ...stats },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
