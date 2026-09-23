/**
 * AMC Mart — goods checkout preparation (MART_DESIGN.md §2, §4.3).
 * Loads the live listings, enforces the gates (active + goods-activated
 * seller, BIS-blocked category, min order qty, one seller per order),
 * resolves bulk tiers, snapshots line items and computes every money column
 * server-side with computeGoodsOrderAmounts. The client sends product ids +
 * quantities ONLY — never a price.
 */
import 'server-only'
import {
  computeGoodsOrderAmounts,
  goodsItcSplit,
  resolveTier,
  type GoodsLineItem,
  type GoodsOrderAmounts,
} from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { getMartCategory, type MartCategoryRow } from './config'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export interface GoodsPrep {
  sellerId: string
  sellerName: string
  title: string
  lineItems: GoodsLineItem[]
  amounts: GoodsOrderAmounts
  /** Longest return window across the order's RETURNABLE categories (hours; 0 when none is returnable). */
  returnWindowHours: number
  categories: string[]
  /** E16 N43 — GST a registered buyer can claim (eligible lines only) and the cost after it. Server-computed. */
  itcPaise: number
  afterItcPaise: number
  /** E16 N43 — lines whose category is not returnable / not ITC-eligible (product ids). */
  nonReturnableProductIds: string[]
  itcIneligibleProductIds: string[]
}

export type GoodsPrepError =
  | { code: 'product_unavailable'; productId: string }
  | { code: 'multiple_sellers' }
  | { code: 'below_min_qty'; productId: string; minOrderQty: number }
  | { code: 'category_blocked'; productId: string }
  | { code: 'no_tier'; productId: string }

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function prepareGoodsCheckout(
  admin: Admin,
  items: { product_id: string; qty: number }[],
): Promise<{ ok: true; prep: GoodsPrep } | { ok: false; status: number; error: GoodsPrepError }> {
  // Merge duplicate lines.
  const qtyById = new Map<string, number>()
  for (const it of items) qtyById.set(it.product_id, (qtyById.get(it.product_id) ?? 0) + it.qty)
  const ids = [...qtyById.keys()]

  const { data: rows } = await admin
    .from('products')
    .select(
      'id, seller_id, category_slug, name, hsn_code, gst_rate_bps, unit, min_order_qty, status, deleted_at, ' +
        'seller:provider_profiles!inner(id, display_name, status, sells_goods, deleted_at), tiers:price_tiers(min_qty, unit_price_paise)',
    )
    .in('id', ids)
  const byId = new Map<string, any>((rows ?? []).map((r: any) => [r.id, r]))

  let sellerId: string | null = null
  let sellerName = ''
  const lineItems: GoodsLineItem[] = []
  const lineInputs: { qty: number; unitPricePaise: number; gstRateBps: number; commissionBps: number }[] = []
  const categoryCache = new Map<string, MartCategoryRow | null>()
  let returnWindowHours = 0
  const categories = new Set<string>()
  const nonReturnable: string[] = []
  const itcIneligible: string[] = []
  const lineItcEligible: boolean[] = []

  for (const id of ids) {
    const qty = qtyById.get(id)!
    const p = byId.get(id)
    const seller = Array.isArray(p?.seller) ? p.seller[0] : p?.seller
    if (!p || p.status !== 'active' || p.deleted_at || !seller || seller.status !== 'active' || !seller.sells_goods || seller.deleted_at) {
      return { ok: false, status: 404, error: { code: 'product_unavailable', productId: id } }
    }
    if (sellerId && sellerId !== p.seller_id) return { ok: false, status: 422, error: { code: 'multiple_sellers' } }
    sellerId = p.seller_id
    sellerName = seller.display_name
    if (qty < Number(p.min_order_qty ?? 1)) {
      return { ok: false, status: 422, error: { code: 'below_min_qty', productId: id, minOrderQty: Number(p.min_order_qty ?? 1) } }
    }
    let cat = categoryCache.get(p.category_slug)
    if (cat === undefined) {
      cat = await getMartCategory(admin, p.category_slug)
      categoryCache.set(p.category_slug, cat)
    }
    if (!cat || !cat.is_active || cat.bis_blocked) return { ok: false, status: 422, error: { code: 'category_blocked', productId: id } }
    const tiers = ((p.tiers ?? []) as { min_qty: number; unit_price_paise: number }[]).map((t) => ({
      min_qty: Number(t.min_qty),
      unit_price_paise: Number(t.unit_price_paise),
    }))
    const tier = resolveTier(tiers, qty)
    if (!tier) return { ok: false, status: 422, error: { code: 'no_tier', productId: id } }

    const gstRateBps = Number(p.gst_rate_bps)
    const taxable = qty * tier.unit_price_paise
    lineItems.push({
      product_id: p.id,
      name: p.name,
      unit: p.unit,
      qty,
      tier_min_qty: tier.min_qty,
      tier_unit_price_paise: tier.unit_price_paise,
      hsn_code: p.hsn_code,
      gst_rate_bps: gstRateBps as GoodsLineItem['gst_rate_bps'],
      line_taxable_paise: taxable,
      line_gst_paise: Math.round((taxable * gstRateBps) / 10000),
    })
    lineInputs.push({ qty, unitPricePaise: tier.unit_price_paise, gstRateBps, commissionBps: cat.commission_bps })
    if (cat.returnable !== false) returnWindowHours = Math.max(returnWindowHours, cat.return_window_hours)
    else nonReturnable.push(p.id)
    if (cat.itc_eligible === false) itcIneligible.push(p.id)
    lineItcEligible.push(cat.itc_eligible !== false)
    categories.add(cat.slug)
  }
  if (!sellerId || lineItems.length === 0) {
    return { ok: false, status: 422, error: { code: 'product_unavailable', productId: ids[0] ?? '' } }
  }

  // Order-level commission = the category commission of the first line; lines
  // in other categories carry their own bps (mixed carts stay paise-exact).
  const amounts = computeGoodsOrderAmounts({ lines: lineInputs, commissionBps: lineInputs[0]!.commissionBps })
  // Cross-check the snapshot against the money math (same rounding, same inputs).
  for (let i = 0; i < lineItems.length; i++) {
    if (lineItems[i]!.line_gst_paise !== amounts.lines[i]!.gstPaise) throw new Error('goods line GST mismatch')
  }

  const first = lineItems[0]!
  const title = lineItems.length === 1 ? `${first.qty} ${first.unit} ${first.name}` : `${first.name} + ${lineItems.length - 1} more`
  const itc = goodsItcSplit(
    amounts.lines.map((l, i) => ({ gstPaise: l.gstPaise, itcEligible: lineItcEligible[i]! })),
    amounts.totalPaise,
  )
  return {
    ok: true,
    prep: {
      sellerId, sellerName, title, lineItems, amounts, returnWindowHours, categories: [...categories],
      itcPaise: itc.itcPaise, afterItcPaise: itc.afterItcPaise, nonReturnableProductIds: nonReturnable, itcIneligibleProductIds: itcIneligible,
    },
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
