import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { resolveActor } from '@/lib/orders/actor'
import { orderDisputeWindowEndsAt } from '@/lib/orders/queries'

/** Order detail for a party (cookie or Bearer auth) — used by web + mobile. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // S2.3 — the Support agent's read (support_lookup) and the buyer's track_order; no-op for sessions.
  const scope = await requireToolScope(['support_lookup', 'track_order'])
  if (scope) return scope
  const { id } = await params

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  const { data: order } = await admin.from('orders').select('*').eq('id', id).maybeSingle()
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const isMsme = actor.msmeId && order.msme_id === actor.msmeId
  const isProvider = actor.providerId && order.provider_id === actor.providerId
  if (!isMsme && !isProvider) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const [{ data: events }, disputeWindowEndsAt] = await Promise.all([
    admin.from('order_events').select('id, event, created_at').eq('order_id', id).order('created_at', { ascending: true }),
    orderDisputeWindowEndsAt(admin, order),
  ])

  // ADR-014 (H2) — disputeWindowEndsAt: a completed order's last moment to report a problem (null otherwise).
  return NextResponse.json({ order, events: events ?? [], viewerRole: isProvider ? 'provider' : 'msme', disputeWindowEndsAt })
}
