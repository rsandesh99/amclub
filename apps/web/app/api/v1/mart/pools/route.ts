import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { createAdminClient } from '@/lib/supabase/server'
import { listPublicPools, poolProgressFor, publicPool } from '@/lib/mart/pools'

export const dynamic = 'force-dynamic'

/** Public pool list: open first (soonest close), then recently closed. Progress is server-computed. */
export async function GET(request: NextRequest) {
  const gate = martApiGate()
  if (gate) return gate
  const category = request.nextUrl.searchParams.get('category') ?? undefined
  const admin = await createAdminClient()
  const pools = await listPublicPools(admin, category)
  return NextResponse.json(
    { pools: pools.map((p) => ({ ...publicPool(p), progress: poolProgressFor(p) })) },
    { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } },
  )
}
