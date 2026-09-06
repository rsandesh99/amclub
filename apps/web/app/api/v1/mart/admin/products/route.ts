import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { PRODUCT_STATUSES } from '@amclub/shared'
import { martApiGate } from '@/lib/mart/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { mapProduct } from '@/lib/mart/queries'
import { publicAssetUrl } from '@/lib/mart/assets'

/** Listing-approval worklist (default: pending_approval, oldest first). */
export async function GET(request: NextRequest) {
  const gate = martApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const status = request.nextUrl.searchParams.get('status') ?? 'pending_approval'
  if (!(PRODUCT_STATUSES as readonly string[]).includes(status)) return NextResponse.json({ error: 'Invalid status' }, { status: 422 })
  const admin = await createAdminClient()
  const { data } = await admin
    .from('products')
    .select(
      'id, name, description, category_slug, hsn_code, gst_rate_bps, unit, images, min_order_qty, country_of_origin, status, created_at, approved_at, ' +
        'seller:provider_profiles!inner(id, display_name, slug, city, state, gstin, sells_goods), tiers:price_tiers(min_qty, unit_price_paise)',
    )
    .eq('status', status)
    .is('deleted_at', null)
    .order('created_at', { ascending: status === 'pending_approval' })
    .limit(200)
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const products = (data ?? []).map((r: any) => ({
    ...mapProduct(r),
    imageUrls: (r.images ?? []).map(publicAssetUrl),
    sellerGstin: (Array.isArray(r.seller) ? r.seller[0] : r.seller)?.gstin ?? null,
    sellerSellsGoods: !!(Array.isArray(r.seller) ? r.seller[0] : r.seller)?.sells_goods,
    approvedAt: r.approved_at ?? null,
  }))
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return NextResponse.json({ products }, { headers: { 'Cache-Control': 'private, no-store' } })
}
