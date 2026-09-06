import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { martApiGate } from '@/lib/mart/gate'
import { listPublicProducts, PRODUCT_SORTS } from '@/lib/mart/queries'
import { publicAssetUrl } from '@/lib/mart/assets'
import { enforce, limiters, tooManyRequests, clientIp } from '@/lib/rate-limit'

const querySchema = z.object({
  category: z.string().max(60).optional(),
  query: z.string().trim().max(120).optional(),
  seller: z.string().max(120).optional(),
  brand: z.string().trim().max(60).optional(),
  minPrice: z.coerce.number().int().nonnegative().optional(),
  maxPrice: z.coerce.number().int().nonnegative().optional(),
  sort: z.enum(PRODUCT_SORTS).optional(),
  limit: z.coerce.number().int().min(1).max(48).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
})

/** Public goods catalog — server-computed tier prices incl. GST + ITC-effective cost. */
export async function GET(request: NextRequest) {
  const gate = martApiGate()
  if (gate) return gate
  const rl = await enforce(limiters.search, `mart-search:${clientIp(request)}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const q = parsed.data
  const result = await listPublicProducts({
    ...(q.category ? { category: q.category } : {}),
    ...(q.query ? { query: q.query } : {}),
    ...(q.seller ? { sellerSlug: q.seller } : {}),
    ...(q.brand ? { brand: q.brand } : {}),
    ...(q.minPrice !== undefined ? { minPricePaise: q.minPrice } : {}),
    ...(q.maxPrice !== undefined ? { maxPricePaise: q.maxPrice } : {}),
    ...(q.sort ? { sort: q.sort } : {}),
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.offset !== undefined ? { offset: q.offset } : {}),
  })
  return NextResponse.json(
    { ...result, products: result.products.map((p) => ({ ...p, imageUrls: p.images.map(publicAssetUrl) })) },
    { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } },
  )
}
