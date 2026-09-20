import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { QUOTE_GOODS_COLS, RFQ_GOODS_COLS, isGoodsRow } from '@/lib/mart/staged-columns'

/**
 * Provider price-book intake (S1.1 §6). Called for EVERY submitted quote (typed
 * or extracted) — but only while AGENT_ENABLED (the caller gates), so flag-off
 * behaviour is byte-identical. Services: category slug via rfqs.category_id,
 * unit 'job', price = the quote total. Goods: category = mart_category_slug and
 * unit = goods_spec.unit read ONLY through RFQ_GOODS_COLS, price = the unit
 * price. source_quote_id is UNIQUE → idempotent on replay. Nothing reads this
 * table in S1.1 (S2.2 Digital Munshi is the first reader). Failures are logged,
 * never returned to the provider. Data, not money movement.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function recordPriceBookEntry(admin: SupabaseClient, args: { quoteId: string }): Promise<{ ok: boolean; reason?: string }> {
  try {
    const { data: q } = await admin
      .from('quotes')
      .select('id, rfq_id, provider_id, price_paise, delivery_days, gst_included, transport_included, created_at, revised_at' + QUOTE_GOODS_COLS)
      .eq('id', args.quoteId)
      .maybeSingle()
    const quote = q as any
    if (!quote) return { ok: false, reason: 'quote_missing' }
    const { data: r } = await admin.from('rfqs').select('id, category_id' + RFQ_GOODS_COLS).eq('id', quote.rfq_id).maybeSingle()
    const rfq = r as any
    if (!rfq) return { ok: false, reason: 'rfq_missing' }

    let row: Record<string, unknown>
    if (isGoodsRow(rfq)) {
      const unit = typeof rfq.goods_spec?.unit === 'string' ? rfq.goods_spec.unit : null
      const unitPrice = quote.unit_price_paise != null ? Number(quote.unit_price_paise) : null
      if (!rfq.mart_category_slug || !unit || !unitPrice || unitPrice <= 0) return { ok: false, reason: 'goods_terms_incomplete' }
      row = { kind: 'goods', category_slug: rfq.mart_category_slug, unit, price_paise: unitPrice }
    } else {
      const { data: cat } = rfq.category_id ? await admin.from('categories').select('slug').eq('id', rfq.category_id).maybeSingle() : { data: null }
      const slug = (cat as any)?.slug as string | undefined
      const price = Number(quote.price_paise)
      if (!slug || !price || price <= 0) return { ok: false, reason: 'services_terms_incomplete' }
      // rfqs has no specialization column today (S1.1 note in FOLLOWUPS) → null.
      row = { kind: 'services', category_slug: slug, specialization: null, unit: 'job', price_paise: price }
    }
    const { error } = await admin.from('provider_price_book').upsert(
      {
        provider_id: quote.provider_id,
        ...row,
        delivery_days: quote.delivery_days ?? null,
        gst_included: quote.gst_included ?? null,
        transport_included: quote.transport_included ?? null,
        source_quote_id: quote.id,
        // S1.3 — a revision restates the price: the row is UPDATED in place (ON CONFLICT DO
        // UPDATE), so the book tracks the latest stated price; confirmed_at = the revision time.
        confirmed_at: quote.revised_at ?? quote.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'source_quote_id' },
    )
    if (error) {
      console.error('[price-book] insert failed', error.message)
      return { ok: false, reason: error.message }
    }
    return { ok: true }
  } catch (e) {
    console.error('[price-book]', (e as Error).message)
    return { ok: false, reason: 'error' }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
