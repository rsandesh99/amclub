/**
 * AMC Mart — catalog data layer. Public reads go through the cookie-less anon
 * client (RLS: active products of goods-activated active sellers only).
 * Seller/admin reads use the service role behind explicit ownership/role
 * checks in the route. All price DISPLAY values are computed HERE (server) —
 * clients render them (FRONTEND.md §8: no client money arithmetic).
 */
import 'server-only'
import { effectiveCostAfterItcPaise, resolveTier } from '@amclub/shared'
import { createPublicClient } from '@/lib/supabase/server'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export interface TierRow {
  min_qty: number
  unit_price_paise: number
}

/** Server-computed display prices for one tier (all paise). */
export interface TierDisplay extends TierRow {
  unit_gst_paise: number
  unit_incl_gst_paise: number
  /** For GST-registered buyers: cost after input credit = taxable value. */
  unit_after_itc_paise: number
}

export interface ProductSummary {
  id: string
  name: string
  description: string | null
  categorySlug: string
  hsnCode: string
  gstRateBps: number
  unit: string
  images: string[]
  minOrderQty: number
  countryOfOrigin: string
  status: string
  seller: { id: string; displayName: string; slug: string; city: string | null; state: string }
  tiers: TierDisplay[]
  /** The min_qty=1 (list) tier display, or the lowest tier if none at 1. */
  list: TierDisplay | null
  createdAt: string
}

export function tierDisplay(t: TierRow, gstRateBps: number): TierDisplay {
  const unitGst = Math.round((t.unit_price_paise * gstRateBps) / 10000)
  return {
    min_qty: t.min_qty,
    unit_price_paise: t.unit_price_paise,
    unit_gst_paise: unitGst,
    unit_incl_gst_paise: t.unit_price_paise + unitGst,
    unit_after_itc_paise: effectiveCostAfterItcPaise({ taxablePaise: t.unit_price_paise }),
  }
}

const SELECT =
  'id, name, description, category_slug, hsn_code, gst_rate_bps, unit, images, min_order_qty, country_of_origin, status, created_at, ' +
  'seller:provider_profiles!inner(id, display_name, slug, city, state), tiers:price_tiers(min_qty, unit_price_paise)'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapProduct(r: any): ProductSummary {
  const tiers: TierRow[] = [...((r.tiers ?? []) as TierRow[])]
    .map((t) => ({ min_qty: Number(t.min_qty), unit_price_paise: Number(t.unit_price_paise) }))
    .sort((a, b) => a.min_qty - b.min_qty)
  const gst = Number(r.gst_rate_bps)
  const displays = tiers.map((t) => tierDisplay(t, gst))
  const seller = Array.isArray(r.seller) ? r.seller[0] : r.seller
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    categorySlug: r.category_slug,
    hsnCode: r.hsn_code,
    gstRateBps: gst,
    unit: r.unit,
    images: r.images ?? [],
    minOrderQty: Number(r.min_order_qty ?? 1),
    countryOfOrigin: r.country_of_origin ?? 'IN',
    status: r.status,
    seller: {
      id: seller?.id,
      displayName: seller?.display_name ?? '',
      slug: seller?.slug ?? '',
      city: seller?.city ?? null,
      state: seller?.state ?? '',
    },
    tiers: displays,
    list: displays[0] ?? null,
    createdAt: r.created_at,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface ProductListFilters {
  category?: string
  query?: string
  sellerSlug?: string
  limit?: number
  offset?: number
}

/** Public catalog list (anon client → RLS = active listings only). */
export async function listPublicProducts(f: ProductListFilters): Promise<{ products: ProductSummary[]; total: number; nextOffset: number | null }> {
  const supabase = createPublicClient()
  const limit = Math.min(f.limit ?? 24, 48)
  const offset = f.offset ?? 0
  let q = supabase
    .from('products')
    .select(SELECT, { count: 'exact' })
    .eq('status', 'active')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (f.category) q = q.eq('category_slug', f.category)
  if (f.sellerSlug) q = q.eq('seller.slug', f.sellerSlug)
  if (f.query) {
    // Postgres FTS over the generated search_tsv (name + description + HSN);
    // hybrid dense search is a later trigger (MART_DESIGN.md §6).
    q = q.textSearch('search_tsv', f.query, { type: 'plain', config: 'simple' })
  }
  const { data, count, error } = await q
  if (error) {
    console.error('[listPublicProducts]', error.message)
    return { products: [], total: 0, nextOffset: null }
  }
  const products = (data ?? []).map(mapProduct)
  const total = count ?? products.length
  return { products, total, nextOffset: offset + products.length < total ? offset + products.length : null }
}

/** One public product (anon client; null when not visible). */
export async function getPublicProduct(id: string): Promise<ProductSummary | null> {
  const { data } = await createPublicClient().from('products').select(SELECT).eq('id', id).is('deleted_at', null).maybeSingle()
  return data ? mapProduct(data) : null
}

/** Seller's own catalog (service role; caller has verified ownership of sellerId). */
export async function listSellerProducts(admin: Admin, sellerId: string): Promise<ProductSummary[]> {
  const { data } = await admin
    .from('products')
    .select(SELECT)
    .eq('seller_id', sellerId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  return (data ?? []).map(mapProduct)
}

export async function getSellerProduct(admin: Admin, sellerId: string, id: string): Promise<ProductSummary | null> {
  const { data } = await admin.from('products').select(SELECT).eq('id', id).eq('seller_id', sellerId).is('deleted_at', null).maybeSingle()
  return data ? mapProduct(data) : null
}

/** Resolve the tier + display for a quantity (server; used by cart/checkout previews). */
export function priceForQty(product: ProductSummary, qty: number): TierDisplay | null {
  const t = resolveTier(product.tiers, qty)
  return t ?? null
}
