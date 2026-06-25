import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { resolveActor } from '@/lib/orders/actor'

/** Order detail for a party (cookie or Bearer auth) — used by web + mobile. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  const { data: order } = await admin.from('orders').select('*').eq('id', id).maybeSingle()
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const isMsme = actor.msmeId && order.msme_id === actor.msmeId
  const isProvider = actor.providerId && order.provider_id === actor.providerId
  if (!isMsme && !isProvider) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data: events } = await admin
    .from('order_events')
    .select('id, event, created_at')
    .eq('order_id', id)
    .order('created_at', { ascending: true })

  return NextResponse.json({ order, events: events ?? [], viewerRole: isProvider ? 'provider' : 'msme' })
}
