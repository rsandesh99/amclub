import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getPackageDetail } from '@/lib/catalog/queries'
import { getPackageExtras } from '@/lib/catalog/package-groups'
import { isOnForEveryone } from '@/lib/experiments'

/** Public package detail for mobile (and any client). */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ providerSlug: string; packageSlug: string }> },
) {
  const { providerSlug, packageSlug } = await params
  const detail = await getPackageDetail(providerSlug, packageSlug)
  if (!detail) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  // Experience v3 E4: tiers + the government line for clients that render them.
  const extras = isOnForEveryone('packages') ? await getPackageExtras(detail.pkg) : null
  return NextResponse.json({ ...detail, extras }, {
    headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
  })
}
