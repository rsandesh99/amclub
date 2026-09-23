import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { isOrderMessagingOn, loadOrderThread, markOrderMessagesRead } from '@/lib/orders/messages'

/** POST /api/v1/orders/[id]/messages/read (E8b) — the caller has seen the other party's messages. Parties only; 404 otherwise. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('orders/messages/read')
  if (delegated) return delegated
  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const admin = await createAdminClient()
  if (!(await isOrderMessagingOn(admin, userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const thread = await loadOrderThread(admin, id, userId)
  if (!thread) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ marked: await markOrderMessagesRead(admin, id, userId) })
}
