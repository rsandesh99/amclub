import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getPackageDetail } from '@/lib/catalog/queries'

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
  return NextResponse.json(detail, {
    headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
  })
}
