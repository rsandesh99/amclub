import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { suggestProducts } from '@/lib/mart/queries'
import { enforce, limiters, tooManyRequests, clientIp } from '@/lib/rate-limit'

/** Search-as-you-type suggestions (name/brand). Edge-cached per query for a minute. */
export async function GET(request: NextRequest) {
  const gate = martApiGate()
  if (gate) return gate
  const rl = await enforce(limiters.search, `mart-suggest:${clientIp(request)}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const q = (request.nextUrl.searchParams.get('q') ?? '').slice(0, 60)
  const suggestions = await suggestProducts(q)
  return NextResponse.json({ suggestions }, { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } })
}
