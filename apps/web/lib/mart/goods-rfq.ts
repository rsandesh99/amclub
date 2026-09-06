/**
 * AMC Mart M2 — goods RFQ helpers. An accepted goods quote becomes an
 * ordinary goods checkout session: ONE line at the quoted unit price and
 * quantity, the buyer's delivery snapshot from the request, commission from
 * the Mart category. Nothing here touches money after the session — the
 * unchanged webhook → materialize_order → payout.ts path does.
 */
import 'server-only'
import { computeGoodsOrderAmounts, goodsQuoteLineItem, goodsRfqSpecSchema, type GoodsLineItem, type GoodsOrderAmounts } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { getMartCategory } from './config'

type Admin = Awaited<ReturnType<typeof createAdminClient>>
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface GoodsQuotePrep {
  title: string
  sellerName: string
  lineItems: GoodsLineItem[]
  delivery: Record<string, unknown>
  amounts: GoodsOrderAmounts
  returnWindowHours: number
}

export async function prepareGoodsQuoteCheckout(
  admin: Admin,
  quote: any,
): Promise<{ ok: true; prep: GoodsQuotePrep } | { ok: false; status: number; error: string }> {
  const rfq = quote.rfq
  const spec = goodsRfqSpecSchema.safeParse(rfq.goods_spec)
  if (!spec.success || !rfq.mart_category_slug) return { ok: false, status: 422, error: 'goods_spec_invalid' }
  if (quote.unit_price_paise == null || quote.qty == null || quote.gst_rate_bps == null || !quote.hsn_code) {
    return { ok: false, status: 422, error: 'goods_terms_missing' }
  }
  const cat = await getMartCategory(admin, rfq.mart_category_slug)
  if (!cat || !cat.is_active || cat.bis_blocked) return { ok: false, status: 422, error: 'category_blocked' }
  const [{ data: seller }, { data: product }] = await Promise.all([
    admin.from('provider_profiles').select('display_name, status, sells_goods, deleted_at').eq('id', quote.provider_id).maybeSingle(),
    quote.product_id ? admin.from('products').select('name, status').eq('id', quote.product_id).maybeSingle() : Promise.resolve({ data: null as any }),
  ])
  if (!seller || seller.status !== 'active' || !seller.sells_goods || seller.deleted_at) return { ok: false, status: 409, error: 'seller_unavailable' }
  const line = goodsQuoteLineItem({
    spec: spec.data,
    terms: { unit_price_paise: Number(quote.unit_price_paise), qty: Number(quote.qty), gst_rate_bps: Number(quote.gst_rate_bps) as GoodsLineItem['gst_rate_bps'], hsn_code: quote.hsn_code, product_id: quote.product_id ?? undefined },
    productName: product?.name ?? null,
    categorySlug: cat.slug,
  })
  const amounts = computeGoodsOrderAmounts({
    lines: [{ qty: line.qty, unitPricePaise: line.tier_unit_price_paise, gstRateBps: line.gst_rate_bps, commissionBps: cat.commission_bps }],
    commissionBps: cat.commission_bps,
  })
  if (amounts.lines[0]!.gstPaise !== line.line_gst_paise) throw new Error('goods quote line GST mismatch')
  return {
    ok: true,
    prep: {
      title: `${line.qty} ${line.unit} ${line.name}`,
      sellerName: seller.display_name,
      lineItems: [line],
      delivery: spec.data.delivery,
      amounts,
      returnWindowHours: cat.return_window_hours,
    },
  }
}
