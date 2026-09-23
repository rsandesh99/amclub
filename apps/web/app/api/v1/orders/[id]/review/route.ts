import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { maybeFlagAnomalousReview } from '@/lib/reviews/anomaly'
import { serverError } from '@/lib/api/errors'
import { accountSuspendedResponse, getMsmeSuspension } from '@/lib/auth/suspension'

const bodySchema = z.object({
  rating: z.number().int().min(1).max(5),
  text: z.string().max(2000).optional(),
})

/** GET — the existing review for this order, visible to either party (buyer or
 *  provider) regardless of moderation status, so both workspaces can render it. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const admin = await createAdminClient()
  const { data: order } = await admin.from('orders').select('msme_id, provider_id, status').eq('id', id).maybeSingle()
  if (!order) return NextResponse.json({ review: null })

  const [{ data: m }, { data: p }] = await Promise.all([
    admin.from('msme_profiles').select('id, deleted_at').eq('user_id', userId).maybeSingle(),
    admin.from('provider_profiles').select('id').eq('user_id', userId).maybeSingle(),
  ])
  const isParty = (m && m.id === order.msme_id) || (p && p.id === order.provider_id)
  if (!isParty) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data } = await admin
    .from('reviews')
    .select('id, rating, text, provider_reply, status, created_at')
    .eq('order_id', id)
    .maybeSingle()
  return NextResponse.json({
    review: data ?? null,
    canReview: !!(m && m.id === order.msme_id && !m.deleted_at) && order.status === 'completed',
    isProvider: !!(p && p.id === order.provider_id),
  })
}

/**
 * POST — create a verified-purchase review (§5.5 / M7). The user-scoped client
 * means RLS does the heavy lifting: insert only succeeds if the caller owns the
 * order AND the order is 'completed'; the unique(order_id) constraint blocks a
 * second review. We translate those failures into clean messages.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rl = await enforce(limiters.reviewWrite, `review:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const { id: orderId } = await params
  if (await getMsmeSuspension(await createAdminClient(), userId)) return accountSuspendedResponse()
  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  // Look up the order's parties (RLS: buyer can read their own order).
  const { data: order } = await supabase
    .from('orders')
    .select('id, msme_id, provider_id, status')
    .eq('id', orderId)
    .maybeSingle()
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  if (order.status !== 'completed') {
    return NextResponse.json({ error: 'You can only review a completed order' }, { status: 409 })
  }

  // Insert as the user — RLS WITH CHECK re-verifies ownership + completion.
  const { data: inserted, error } = await supabase
    .from('reviews')
    .insert({
      order_id: orderId,
      msme_id: order.msme_id,
      provider_id: order.provider_id,
      rating: parsed.data.rating,
      text: parsed.data.text ?? null,
    })
    .select('id, rating, provider_id, msme_id')
    .single()

  if (error) {
    // 23505 = unique(order_id) → already reviewed; 42501/RLS → not allowed.
    if (error.code === '23505') return NextResponse.json({ error: 'You already reviewed this order' }, { status: 409 })
    if (error.code === '42501') return NextResponse.json({ error: 'You can only review your own completed order' }, { status: 403 })
    return serverError('[review POST]', error)
  }

  // Anomaly screen runs with elevated privileges (cross-review read + flag).
  let flagged = false
  try {
    const admin = await createAdminClient()
    flagged = await maybeFlagAnomalousReview(admin, inserted)
  } catch (e) {
    console.error('[review anomaly]', e)
  }

  return NextResponse.json({ ok: true, reviewId: inserted.id, flagged })
}
