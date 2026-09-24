import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { poolRouteGuard, isUuid, NO_STORE } from '@/lib/pools/route-guard'
import { poolBuyerView, poolProviderView } from '@/lib/pools/queries'

/**
 * GET /api/v1/pools/[id] (S3.4, ADR 024) — the group, shaped for the caller: a member buyer sees the count and every
 * offer with the server's tier figures (never another member); an eligible provider sees the count, the requests it is
 * matched to and only its own offer (sealed). Anyone else: 404.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await poolRouteGuard()
  if (!g.ok) return g.res
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const locale = request.nextUrl.searchParams.get('locale') ?? 'en'
  if (g.msmeId) {
    const view = await poolBuyerView(g.admin, id, g.msmeId, locale)
    if (view) return NextResponse.json({ role: 'buyer', pool: view }, { headers: NO_STORE })
  }
  if (g.providerId) {
    const view = await poolProviderView(g.admin, id, g.providerId, locale)
    if (view) return NextResponse.json({ role: 'provider', pool: view }, { headers: NO_STORE })
  }
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
