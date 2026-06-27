import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { notifyReviewReply } from '@/lib/notifications/events'
import { serverError } from '@/lib/api/errors'

const bodySchema = z.object({ reply: z.string().trim().min(1).max(1000) })

/** POST — the provider posts ONE reply to a review on their work (§5.5). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rl = await enforce(limiters.reviewWrite, `review:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const { id: reviewId } = await params
  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const { data: provider } = await admin.from('provider_profiles').select('id').eq('user_id', userId).maybeSingle()
  if (!provider) return NextResponse.json({ error: 'Provider profile required' }, { status: 403 })

  const { data: review } = await admin
    .from('reviews')
    .select('id, provider_id, msme_id, order_id, provider_reply')
    .eq('id', reviewId)
    .maybeSingle()
  if (!review) return NextResponse.json({ error: 'Review not found' }, { status: 404 })
  if (review.provider_id !== provider.id) return NextResponse.json({ error: 'Not your review' }, { status: 403 })
  if (review.provider_reply) return NextResponse.json({ error: 'You already replied to this review' }, { status: 409 })

  const { error } = await admin
    .from('reviews')
    .update({ provider_reply: parsed.data.reply, updated_at: new Date().toISOString() })
    .eq('id', reviewId)
    .is('provider_reply', null) // guard a racing double-reply
  if (error) return serverError('[review reply POST]', error)

  try { await notifyReviewReply(admin, review) } catch (e) { console.error('[notifyReviewReply]', e) }

  return NextResponse.json({ ok: true })
}
