import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'
import { requireNotDelegated } from '@/lib/agent/scope'

const bodySchema = z.object({ reason: z.string().trim().max(500).optional() })

/** Distinct reporters (other than the reviewed provider) before a review is hidden pending ops. */
const HIDE_AFTER_REPORTERS = 3

/**
 * POST — report a published review for moderation (A4). Every report is
 * recorded (audit_logs 'review_flagged'). Audit M9: one report no longer hides
 * the review. It moves to 'flagged' (out of the public average + listing, into
 * /admin/reviews) only when HIDE_AFTER_REPORTERS distinct users reported it,
 * not counting the provider the review is about, and never again once ops
 * restored it: ops makes the final call (remove/restore).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Audit wave 3: no agent tool wraps this route, so a delegated agent token is refused.
  const delegated = await requireNotDelegated('POST /reviews/[id]/flag')
  if (delegated) return delegated
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rl = await enforce(limiters.reviewWrite, `review:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const { id: reviewId } = await params
  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json ?? {})
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const { data: review } = await admin.from('reviews').select('id, status, provider_id').eq('id', reviewId).maybeSingle()
  if (!review) return NextResponse.json({ error: 'Review not found' }, { status: 404 })
  if (review.status === 'removed') return NextResponse.json({ error: 'Review already removed' }, { status: 409 })

  await admin.from('audit_logs').insert({
    actor_id: userId,
    action: 'review_flagged',
    entity: 'reviews',
    entity_id: reviewId,
    after: { reason: parsed.data.reason ?? null },
  })
  if (review.status !== 'published') return NextResponse.json({ ok: true, status: review.status })

  const [{ data: reports }, { data: restored }, { data: subject }] = await Promise.all([
    admin.from('audit_logs').select('actor_id').eq('entity', 'reviews').eq('entity_id', reviewId).eq('action', 'review_flagged').limit(200),
    admin.from('audit_logs').select('id').eq('entity', 'reviews').eq('entity_id', reviewId).eq('action', 'review_restored').limit(1),
    admin.from('provider_profiles').select('user_id').eq('id', review.provider_id).maybeSingle(),
  ])
  const reporters = new Set((reports ?? []).map((r) => r.actor_id as string).filter((a) => a && a !== subject?.user_id))
  if ((restored ?? []).length > 0 || reporters.size < HIDE_AFTER_REPORTERS) {
    return NextResponse.json({ ok: true, status: 'published', reported: true })
  }

  const { error } = await admin
    .from('reviews')
    .update({ status: 'flagged', updated_at: new Date().toISOString() })
    .eq('id', reviewId)
    .eq('status', 'published')
  if (error) return serverError('[review flag POST]', error)
  return NextResponse.json({ ok: true, status: 'flagged' })
}
