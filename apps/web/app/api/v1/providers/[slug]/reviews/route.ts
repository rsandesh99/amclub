import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getProviderBySlug } from '@/lib/catalog/queries'
import { enforce, limiters, tooManyRequests, clientIp } from '@/lib/rate-limit'
import { reviewsV2 } from '@/lib/trust/reviews'

/**
 * GET /api/v1/providers/[slug]/reviews?cursor= (E3 / N13) — published reviews
 * for an active provider, keyset-paginated, with the histogram and the
 * server-derived "repeat buyer" marker. Public; no buyer identity ever.
 */
export const runtime = 'nodejs'

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const rl = await enforce(limiters.publicIp, `reviews:${clientIp(request)}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const { slug } = await params
  const provider = await getProviderBySlug(slug)
  if (!provider) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const page = await reviewsV2(provider.id, { cursor: request.nextUrl.searchParams.get('cursor'), limit: Number(request.nextUrl.searchParams.get('limit')) || 10 })
  return NextResponse.json(page, { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } })
}
