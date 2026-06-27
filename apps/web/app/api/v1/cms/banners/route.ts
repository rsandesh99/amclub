import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getActiveBanners } from '@/lib/cms/queries'

/** GET — active banners for a slot + locale (public; for mobile + clients). */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const slot = url.searchParams.get('slot')
  const locale = url.searchParams.get('locale') === 'hi' ? 'hi' : 'en'
  if (!slot) return NextResponse.json({ error: 'slot is required' }, { status: 400 })

  const banners = await getActiveBanners(slot, locale)
  return NextResponse.json(
    { banners },
    { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' } },
  )
}
