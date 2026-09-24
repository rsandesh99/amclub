import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { maybeFlagAnomalousReview } from '@/lib/reviews/anomaly'
import { serverError } from '@/lib/api/errors'
import { accountSuspendedResponse, getMsmeSuspension } from '@/lib/auth/suspension'
import { requireNotDelegated } from '@/lib/agent/scope'
import { SELF_DEALING, isOwnProvider } from '@/lib/orders/self-dealing'

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
    // Audit M22 — never a review of your own provider profile.
    canReview: !!(m && m.id === order.msme_id && !m.deleted_at) && order.status === 'completed' && !(p && p.id === order.provider_id),
    isProvider: !!(p && p.id === order.provider_id),
  })
}

/**
 * POST — create a verified-purchase review (§5.5 / M7). The order is read
 * through the caller's own session (RLS: a party of it); the route then checks
 * the caller is the order's BUYER and the order is 'completed', and writes with
 * the service role — clients hold no write grant on reviews (ADR 018). The
 * unique(order_id) constraint blocks a second review.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Audit M8 — no agent tool wraps this write: a delegated token is refused.
  const delegated = await requireNotDelegated('POST /orders/[id]/review')
  if (delegated) return delegated

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

  // Only the order's buyer reviews it (a provider can read the order too).
  const admin = await createAdminClient()
  const { data: me } = await admin.from('msme_profiles').select('id').eq('user_id', userId).maybeSingle()
  if (!me || me.id !== order.msme_id) {
    return NextResponse.json({ error: 'You can only review your own completed order' }, { status: 403 })
  }
  // Audit M22 (ADR 027) — nobody rates their own provider profile.
  if (await isOwnProvider(admin, order.provider_id as string, userId)) {
    return NextResponse.json({ error: SELF_DEALING }, { status: 409 })
  }

  const { data: inserted, error } = await admin
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
    // 23505 = unique(order_id) → already reviewed.
    if (error.code === '23505') return NextResponse.json({ error: 'You already reviewed this order' }, { status: 409 })
    return serverError('[review POST]', error)
  }

  // Anomaly screen runs with elevated privileges (cross-review read + flag).
  let flagged = false
  try {
    flagged = await maybeFlagAnomalousReview(admin, inserted)
  } catch (e) {
    console.error('[review anomaly]', e)
  }

  return NextResponse.json({ ok: true, reviewId: inserted.id, flagged })
}
