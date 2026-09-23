import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { parseSearchV2, searchV2Window } from '@amclub/shared'
import { searchPackages } from '@/lib/catalog/queries'
import { searchCatalogV2 } from '@/lib/catalog/search-v2'
import { isOnForEveryone } from '@/lib/experiments'
import { enforce, limiters, tooManyRequests, clientIp } from '@/lib/rate-limit'

const querySchema = z.object({
  query: z.string().trim().max(120).optional(),
  category: z.string().max(60).optional(),
  state: z.string().max(4).optional(),
  minPrice: z.coerce.number().int().nonnegative().optional(),
  maxPrice: z.coerce.number().int().nonnegative().optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  language: z.string().max(4).optional(),
  verifiedOnly: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
    .optional(),
  sort: z.enum(['rating', 'price_asc', 'price_desc', 'newest']).optional(),
  limit: z.coerce.number().int().min(1).max(48).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
})

export async function GET(request: NextRequest) {
  // Unauthenticated + DB-heavy → per-IP cap.
  const rl = await enforce(limiters.search, `search:${clientIp(request)}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const sp = request.nextUrl.searchParams

  // Experience v3 E2 (FR-2.1, flag `search`): the v2 parameters (service, city,
  // credential, responseMaxHours, deliveryMaxDays, price band, sort best /
  // fastest, page), facet counts and the weak-results flag. Invalid values are
  // dropped by the shared codec, never trusted.
  if (isOnForEveryone('search')) {
    const s = parseSearchV2(Object.fromEntries(sp.entries()))
    const r = await searchCatalogV2(s)
    const { limit, offset } = searchV2Window(s)
    return NextResponse.json(
      { results: r.results, total: r.total, nextOffset: offset + limit < r.total ? offset + limit : null, facets: r.facets, weak: r.weak },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } },
    )
  }

  const parsed = querySchema.safeParse(Object.fromEntries(sp.entries()))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }
  const q = parsed.data

  const result = await searchPackages({
    ...(q.query ? { query: q.query } : {}),
    ...(q.category ? { categorySlug: q.category } : {}),
    ...(q.state ? { state: q.state } : {}),
    ...(q.minPrice !== undefined ? { minPrice: q.minPrice } : {}),
    ...(q.maxPrice !== undefined ? { maxPrice: q.maxPrice } : {}),
    ...(q.minRating !== undefined ? { minRating: q.minRating } : {}),
    ...(q.language ? { language: q.language } : {}),
    ...(q.verifiedOnly ? { verifiedOnly: q.verifiedOnly === 'true' || q.verifiedOnly === '1' } : {}),
    ...(q.sort ? { sort: q.sort } : {}),
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.offset !== undefined ? { offset: q.offset } : {}),
  })

  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' },
  })
}
