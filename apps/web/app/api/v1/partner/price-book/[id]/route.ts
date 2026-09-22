import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { captureServerEvent } from '@/lib/analytics/server'

/** S2.2 — soft-delete one of the provider's own price-book rows (session only; never a delegated token). */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('DELETE /partner/price-book/[id]')
  if (delegated) return delegated
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return NextResponse.json({ error: 'Not a provider' }, { status: 403 })
  const { data, error } = await admin
    .from('provider_price_book')
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('provider_id', actor.providerId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle()
  if (error) return NextResponse.json({ error: 'price_book_unavailable' }, { status: 503 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  captureServerEvent(userId, 'munshi_price_book_row_deleted', {})
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } })
}
