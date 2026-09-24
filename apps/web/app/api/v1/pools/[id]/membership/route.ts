import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { poolMembershipSchema } from '@amclub/shared'
import { poolRouteGuard, isUuid } from '@/lib/pools/route-guard'
import { memberAction, poolErrorStatus } from '@/lib/pools/actions'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

/**
 * POST /api/v1/pools/[id]/membership { action: join | leave | dismiss } (S3.4, ADR 024) — the buyer's answer to the
 * agent's proposal for their own request. Join records ONE ai_decisions row (feature demand_pool, tool join_pool) and
 * opens the group once enough buyers joined. Moves no money.
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
  const parsed = poolMembershipSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 422 })
  const r = await memberAction(g.admin, { userId: g.userId, msmeId: g.msmeId, poolId: id, action: parsed.data.action })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: poolErrorStatus(r.error) })
  return NextResponse.json({ status: r.status, poolStatus: r.poolStatus })
}
