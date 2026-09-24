import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { poolRouteGuard, isUuid, NO_STORE } from '@/lib/pools/route-guard'
import { poolForRfq } from '@/lib/pools/queries'

/**
 * GET /api/v1/rfq/[id]/pool (S3.4, ADR 024) — the buyer's group for one of THEIR requests (the invitation / status
 * card on the request page; mobile reads the same). { pool: null } when there is none to show.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await poolRouteGuard()
  if (!g.ok) return g.res
  if (!g.msmeId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ pool: await poolForRfq(g.admin, id, g.msmeId) }, { headers: NO_STORE })
}
