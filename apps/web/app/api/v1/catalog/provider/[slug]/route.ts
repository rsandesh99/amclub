import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getProviderBySlug, getPackagesForProvider, getReviews } from '@/lib/catalog/queries'
import { isOnForEveryone } from '@/lib/experiments'
import { getProviderTrust } from '@/lib/trust/provider-trust'

/** Public provider profile for mobile (and any client). Badges resolved
 *  server-side; never exposes gstin/pan/bank. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const provider = await getProviderBySlug(slug)
  if (!provider) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const [packages, reviews, trust] = await Promise.all([
    getPackagesForProvider(provider.id),
    getReviews(provider.id, 10, 0),
    // Experience v3 E3: verification method + date, activity, availability and
    // the gated measured stats (null while D1 is off). Never the AMC Score.
    isOnForEveryone('trust') ? getProviderTrust(provider.id) : Promise.resolve(null),
  ])
  return NextResponse.json(
    { provider, packages, reviews: reviews.reviews, reviewTotal: reviews.total, trust },
    { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
  )
}
