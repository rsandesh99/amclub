import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { universalSearchQuerySchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { enforce, limiters, tooManyRequests, clientIp } from '@/lib/rate-limit'
import { universalSearch } from '@/lib/search/universal'

/**
 * GET /api/v1/search/universal?q= (N3, PRD Experience v3 FR-1.5) — services,
 * providers and categories for everyone; plus the caller's own requirements,
 * orders and invoices when signed in. Rate-limited like catalog search.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const rl = await enforce(limiters.search, `usearch:${clientIp(request)}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const parsed = universalSearchQuerySchema.safeParse({ q: request.nextUrl.searchParams.get('q') ?? '' })
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const { userId } = await getAuthedSupabase()
  const locale = request.nextUrl.searchParams.get('locale') ?? request.headers.get('x-amc-locale') ?? 'en'
  const result = await universalSearch(parsed.data.q, userId ?? null, locale)
  return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
}
