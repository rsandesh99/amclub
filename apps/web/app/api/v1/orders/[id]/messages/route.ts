import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { orderMessageSchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { isOrderMessagingOn, listOrderMessages, loadOrderThread, sendOrderMessage } from '@/lib/orders/messages'

/**
 * GET / POST /api/v1/orders/[id]/messages (PRD Experience v3 E8b FR-8.4, N24)
 * — the order's thread, for its two parties only. 404 unless the `orders`
 * experience is on for the caller AND order_messaging_enabled; 404 for anyone
 * who is not a party (no existence oracle). POST is the ONE writer: masks
 * phone / email, attaches only this order's documents, refuses a read-only
 * thread (409 thread_read_only, 30 days after the order ends). Delegated
 * (agent) tokens are refused — reply drafting stays dark.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOT_FOUND = () => NextResponse.json({ error: 'Not found' }, { status: 404 })

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('orders/messages')
  if (delegated) return delegated
  const { id } = await params
  if (!UUID.test(id)) return NOT_FOUND()
  const admin = await createAdminClient()
  if (!(await isOrderMessagingOn(admin, userId))) return NOT_FOUND()
  const thread = await loadOrderThread(admin, id, userId)
  if (!thread) return NOT_FOUND()
  const { messages, unread } = await listOrderMessages(admin, thread, userId)
  return NextResponse.json({ state: thread.state, messages, unread }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('orders/messages')
  if (delegated) return delegated
  const { id } = await params
  if (!UUID.test(id)) return NOT_FOUND()
  const admin = await createAdminClient()
  if (!(await isOrderMessagingOn(admin, userId))) return NOT_FOUND()
  const rl = await enforce(limiters.orderMessage, `order-message:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const thread = await loadOrderThread(admin, id, userId)
  if (!thread) return NOT_FOUND()
  const parsed = orderMessageSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body', code: 'invalid_body' }, { status: 422 })
  const r = await sendOrderMessage(admin, thread, userId, parsed.data)
  if (!r.ok) {
    const status = r.code === 'thread_read_only' ? 409 : r.code === 'document_not_on_order' ? 422 : 500
    return NextResponse.json({ error: r.code, code: r.code }, { status })
  }
  return NextResponse.json(r.message, { status: 201 })
}
