import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { poolOfferSchema } from '@amclub/shared'
import { poolRouteGuard, isUuid } from '@/lib/pools/route-guard'
import { poolErrorStatus, submitOffer, withdrawOffer } from '@/lib/pools/actions'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

/**
 * POST   /api/v1/pools/[id]/offer — an eligible provider states ONE group offer: scope, days, GST, validity and 1–3
 *        volume tiers (shared poolTierProblems: first tier = one business, then higher thresholds at strictly lower
 *        prices; 400 tiers_incoherent). Sealed: no provider sees another's offer. By submitting, the provider
 *        authorises AMClub to send it as an ordinary quote to each business that chose it, at the tier reached.
 * DELETE /api/v1/pools/[id]/offer — withdraw it while the group is open (commitments to it are cleared).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await poolRouteGuard()
  if (!g.ok) return g.res
  if (!g.providerId) return NextResponse.json({ error: 'Not a provider' }, { status: 403 })
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const rl = await enforce(limiters.quoteSubmit, `quote:${g.providerId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const parsed = poolOfferSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const r = await submitOffer(g.admin, { userId: g.userId, providerId: g.providerId, poolId: id, body: parsed.data })
  if (!r.ok) return NextResponse.json({ error: r.error, ...(r.detail ? { problems: r.detail } : {}) }, { status: poolErrorStatus(r.error) })
  return NextResponse.json({ offerId: r.offerId })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await poolRouteGuard()
  if (!g.ok) return g.res
  if (!g.providerId) return NextResponse.json({ error: 'Not a provider' }, { status: 403 })
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const r = await withdrawOffer(g.admin, { userId: g.userId, providerId: g.providerId, poolId: id })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: poolErrorStatus(r.error) })
  return NextResponse.json({ offerId: r.offerId })
}
