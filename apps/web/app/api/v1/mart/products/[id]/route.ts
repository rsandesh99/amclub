import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { getPublicProduct } from '@/lib/mart/queries'
import { publicAssetUrl } from '@/lib/mart/assets'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = martApiGate()
  if (gate) return gate
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const product = await getPublicProduct(id)
  if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(
    { product: { ...product, imageUrls: product.images.map(publicAssetUrl) } },
    { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } },
  )
}
