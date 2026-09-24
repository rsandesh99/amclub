import { NextResponse } from 'next/server'
import { poolRouteGuard, NO_STORE } from '@/lib/pools/route-guard'
import { providerPools } from '@/lib/pools/queries'

/** GET /api/v1/partner/pools (S3.4, ADR 024) — open groups this provider may offer on, and groups it offered on. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const g = await poolRouteGuard()
  if (!g.ok) return g.res
  if (!g.providerId) return NextResponse.json({ error: 'Not a provider' }, { status: 403 })
  return NextResponse.json({ pools: await providerPools(g.admin, g.providerId) }, { headers: NO_STORE })
}
