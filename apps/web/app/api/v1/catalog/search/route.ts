import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { searchPackages } from '@/lib/catalog/queries'

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
  const sp = request.nextUrl.searchParams
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
