import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { bundlesOn, cancelRemaining } from '@/lib/bundles'
import { captureServerEvent } from '@/lib/analytics/server'

export const dynamic = 'force-dynamic'

/**
 * E12c / ADR 021 — "Cancel remaining": the buyer cancels every UNSTARTED
 * milestone of their own plan (placed / accepted), each through the ordinary
 * `cancel` transition — 100 % back per child, one refund row per child on the
 * plan's one payment. Started and finished milestones are untouched. The
 * buyer's own session only (never a delegated token). 404 while off.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('bundles/cancel-remaining')
  if (delegated) return delegated
  const admin = await createAdminClient()
  if (!(await bundlesOn(admin))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const rl = await enforce(limiters.checkout, `checkout:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const actor = await resolveActor(admin, userId)
  const { data: purchase } = await admin.from('bundle_purchases').select('id, msme_id').eq('id', id).maybeSingle()
  if (!purchase || !actor.msmeId || purchase.msme_id !== actor.msmeId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const result = await cancelRemaining(admin, id, actor)
  captureServerEvent(userId, 'plan_cancelled', { cancelled: result.cancelled.length, failed: result.failed.length })
  return NextResponse.json(result, { status: result.failed.length && !result.cancelled.length ? 409 : 200 })
}
