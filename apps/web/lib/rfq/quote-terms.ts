import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { redactContactInfo, type QuoteRevisionInput } from '@amclub/shared'
import { RFQ_GOODS_COLS, isGoodsRow } from '@/lib/mart/staged-columns'

/**
 * S1.3 — the ONE terms/price path for a quote. `POST /rfq/[id]/quote` (submit)
 * and `PATCH /rfq/[id]/quote` (revise) both call `resolveQuoteTerms`, so goods
 * validation and `price_paise` computation can never fork:
 *   services → price_paise is what the provider stated;
 *   goods    → price_paise = qty × unit price, computed HERE; the client's
 *              total is ignored; the linked listing must be the seller's own,
 *              live, and in the RFQ's Mart category (AMC Mart M2).
 * Staged Mart columns are read only through RFQ_GOODS_COLS (empty while dark).
 * No money movement — this shapes a quote row, nothing else.
 */

/** The quote fields a submit or a revision states (rfq_id / extraction_id are route concerns). */
export type QuoteTermsBody = QuoteRevisionInput

export interface RfqRowForQuote {
  id: string
  kind?: string
  goods_spec?: unknown
  mart_category_slug?: string | null
}

export interface GoodsQuoteColumns {
  unit_price_paise: number
  qty: number
  gst_rate_bps: number
  hsn_code: string
  product_id: string | null
}

export interface ResolvedQuoteTerms {
  pricePaise: number
  isGoods: boolean
  /** Goods columns for the row (null on a services quote). */
  goods: GoodsQuoteColumns | null
  /** Stated commercial terms as stored — absent → NULL = "not stated". */
  terms: {
    gst_included: boolean | null
    transport_included: boolean | null
    valid_until: string | null
    advance_percent: number | null
  }
}

export type ResolveQuoteTermsResult =
  | { ok: true; value: ResolvedQuoteTerms }
  | { ok: false; status: 403 | 422; error: 'goods_terms_required' | 'goods_terms_not_allowed' | 'listing_not_owned' | 'listing_mismatch' }

/** The RFQ row a quote route needs — `id` plus the staged goods fragment (empty while Mart is dark). */
export async function loadRfqRowForQuote(admin: SupabaseClient, rfqId: string): Promise<RfqRowForQuote | null> {
  const { data } = await admin.from('rfqs').select('id' + RFQ_GOODS_COLS).eq('id', rfqId).maybeSingle()
  return (data as unknown as RfqRowForQuote | null) ?? null
}

export async function resolveQuoteTerms(
  admin: SupabaseClient,
  args: { rfqRow: RfqRowForQuote; providerId: string; body: QuoteTermsBody },
): Promise<ResolveQuoteTermsResult> {
  const { rfqRow, providerId, body: d } = args
  const isGoods = isGoodsRow(rfqRow)
  let goods: GoodsQuoteColumns | null = null
  if (isGoods) {
    if (!d.goods) return { ok: false, status: 422, error: 'goods_terms_required' }
    const spec = (rfqRow.goods_spec ?? {}) as { qty?: number }
    const qty = d.goods.qty ?? Number(spec.qty ?? 0)
    if (!(qty > 0)) return { ok: false, status: 422, error: 'goods_terms_required' }
    if (d.goods.product_id) {
      // The linked listing must be the seller's own, live, and in the RFQ's Mart
      // category — the order line takes its name from it and its category from the RFQ.
      const { data: own } = await admin.from('products').select('id, status, category_slug').eq('id', d.goods.product_id).eq('seller_id', providerId).is('deleted_at', null).maybeSingle()
      if (!own) return { ok: false, status: 403, error: 'listing_not_owned' }
      if (own.status !== 'active' || own.category_slug !== rfqRow.mart_category_slug) return { ok: false, status: 422, error: 'listing_mismatch' }
    }
    goods = { unit_price_paise: d.goods.unit_price_paise, qty, gst_rate_bps: d.goods.gst_rate_bps, hsn_code: d.goods.hsn_code, product_id: d.goods.product_id ?? null }
  } else if (d.goods) {
    return { ok: false, status: 422, error: 'goods_terms_not_allowed' }
  }
  const pricePaise = goods ? goods.unit_price_paise * goods.qty : d.price_paise
  return {
    ok: true,
    value: {
      pricePaise,
      isGoods,
      goods,
      terms: {
        gst_included: d.gst_included ?? null,
        transport_included: d.transport_included ?? null,
        valid_until: d.valid_until ?? null,
        advance_percent: d.advance_percent ?? null,
      },
    },
  }
}

/**
 * The quote row columns a submit inserts or a revision restates, from ONE
 * resolution. Goods columns (staged, 0024) are written only when the RFQ is a
 * goods RFQ — never named on a services write.
 */
export function quoteRowColumns(resolved: ResolvedQuoteTerms, d: QuoteTermsBody): Record<string, unknown> {
  return {
    price_paise: resolved.pricePaise,
    delivery_days: d.delivery_days,
    // Audit M40 — a quote reaches the buyer before payment: contact details are
    // masked here, the ONE writer of quote rows (submit, revision, pool close).
    scope: redactContactInfo(d.scope).text,
    message: d.message ? redactContactInfo(d.message).text : null,
    ...resolved.terms,
    ...(resolved.goods
      ? { unit_price_paise: resolved.goods.unit_price_paise, qty: resolved.goods.qty, gst_rate_bps: resolved.goods.gst_rate_bps, hsn_code: resolved.goods.hsn_code, product_id: resolved.goods.product_id }
      : {}),
  }
}

/** The "stated terms" snapshot that quote_events carries (submitted + revised before/after). */
export function quoteTermsSnapshot(resolved: ResolvedQuoteTerms, d: QuoteTermsBody): Record<string, unknown> {
  return {
    price_paise: resolved.pricePaise,
    delivery_days: d.delivery_days,
    ...(resolved.goods ? { goods: resolved.goods } : {}),
    ...resolved.terms,
  }
}
