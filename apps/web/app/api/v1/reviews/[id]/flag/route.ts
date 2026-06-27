import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'

const bodySchema = z.object({ reason: z.string().trim().max(500).optional() })

/**
 * POST — flag a published review for moderation (A4). Moves it to 'flagged'
 * (drops out of the public average + listing) and routes it to /admin/reviews.
 * Any authenticated user may report; ops makes the final call (remove/restore).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rl = await enforce(limiters.reviewWrite, `review:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const { id: reviewId } = await params
  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json ?? {})
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const { data: review } = await admin.from('reviews').select('id, status').eq('id', reviewId).maybeSingle()
  if (!review) return NextResponse.json({ error: 'Review not found' }, { status: 404 })
  if (review.status === 'removed') return NextResponse.json({ error: 'Review already removed' }, { status: 409 })

  const { error } = await admin
    .from('reviews')
    .update({ status: 'flagged', updated_at: new Date().toISOString() })
    .eq('id', reviewId)
    .neq('status', 'removed')
  if (error) return serverError('[review flag POST]', error)

  await admin.from('audit_logs').insert({
    actor_id: userId,
    action: 'review_flagged',
    entity: 'reviews',
    entity_id: reviewId,
    after: { reason: parsed.data.reason ?? null },
  })

  return NextResponse.json({ ok: true })
}
