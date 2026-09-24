import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { poolCommitSchema } from '@amclub/shared'
import { poolRouteGuard, isUuid } from '@/lib/pools/route-guard'
import { commit, poolErrorStatus } from '@/lib/pools/actions'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

/**
 * POST /api/v1/pools/[id]/commit { offer_id | null } (S3.4, ADR 024) — a joined buyer chooses one group offer (or
 * none) while the group is open. No money moves: at close the buyer gets ONE ordinary quote at the tier reached, and
 * pays it (or not) through the ordinary Accept & pay.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await poolRouteGuard()
  if (!g.ok) return g.res
  if (!g.msmeId) return NextResponse.json({ error: 'Not a buyer' }, { status: 403 })
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const rl = await enforce(limiters.authed, `pool:${g.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const parsed = poolCommitSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 422 })
  const r = await commit(g.admin, { userId: g.userId, msmeId: g.msmeId, poolId: id, offerId: parsed.data.offer_id })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: poolErrorStatus(r.error) })
  return NextResponse.json({ committedOfferId: r.committedOfferId })
}
