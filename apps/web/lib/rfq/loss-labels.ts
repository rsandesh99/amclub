import 'server-only'
import { QUOTE_STATUS, quoteLossLabel, type LossLabelQuote } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { QUOTE_GOODS_COLS } from '@/lib/mart/staged-columns'
import { isExperienceLive } from '@/lib/experiments'
import { captureServerEvent } from '@/lib/analytics/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/** The auto-decline stamp finalizeQuoteAcceptance puts on the quotes that were open when another won. */
export const PASSED_OVER_REASON = 'another_quote_accepted'

interface QuoteRow {
  id: string
  status: string
  decline_reason: string | null
  price_paise: number
  gst_included: boolean | null
  delivery_days: number | null
  unit_price_paise?: number | null
  qty?: number | null
  gst_rate_bps?: number | null
}

function asLabelQuote(q: QuoteRow): LossLabelQuote {
  const goods = q.unit_price_paise != null && q.qty != null && q.gst_rate_bps != null
    ? { unitPricePaise: Number(q.unit_price_paise), qty: Number(q.qty), gstRateBps: Number(q.gst_rate_bps) }
    : null
  return { pricePaise: Number(q.price_paise), gstIncluded: q.gst_included, deliveryDays: q.delivery_days, goods }
}

/**
 * PRD Experience v3 E7 FR-7.3 (N22). Every quote that was still open when
 * `acceptedQuoteId` won (auto-declined `another_quote_accepted`) gets ONE
 * `quote_events` row `lost` with its deltas against the winner (shared
 * `quoteLossLabel`). Called from finalizeQuoteAcceptance's pass and again on a
 * replay of the winning order, so an interrupted pass is completed; it only
 * writes labels that are missing, and the partial unique index
 * `quote_events_lost_once` (0058) makes a second row impossible.
 *
 * Best-effort and outside the money path: it never throws, and a failure is
 * logged and leaves the order, the quotes and the RFQ exactly as they are.
 * Dark until the `compare` experience is live (0058 must be applied first).
 */
export async function labelLostQuotes(admin: Admin, args: { rfqId: string; acceptedQuoteId: string; winnerTerms?: { pricePaise: number; deliveryDays: number } }): Promise<number> {
  if (!isExperienceLive('compare')) return 0
  try {
    const { data, error } = await admin
      .from('quotes')
      .select(`id, status, decline_reason, price_paise, gst_included, delivery_days${QUOTE_GOODS_COLS}`)
      .eq('rfq_id', args.rfqId)
    if (error || !data) {
      console.warn('[loss-labels] quotes read', error?.message)
      return 0
    }
    const rows = data as unknown as QuoteRow[]
    const winner = rows.find((r) => r.id === args.acceptedQuoteId)
    if (!winner || winner.status !== QUOTE_STATUS.accepted) return 0
    const losers = rows.filter((r) => r.id !== winner.id && r.status === QUOTE_STATUS.declined && r.decline_reason === PASSED_OVER_REASON)
    if (losers.length === 0) return 0

    const { data: have, error: haveErr } = await admin.from('quote_events').select('quote_id').eq('event_type', 'lost').in('quote_id', losers.map((l) => l.id))
    if (haveErr) {
      console.warn('[loss-labels] existing labels read', haveErr.message)
      return 0
    }
    const done = new Set((have ?? []).map((h) => h.quote_id as string))
    // E12b — deltas are against the option the buyer paid for (same GST mode), not the quote's Standard row.
    const w = { id: winner.id, ...asLabelQuote(winner), ...(args.winnerTerms ? { pricePaise: args.winnerTerms.pricePaise, deliveryDays: args.winnerTerms.deliveryDays } : {}) }
    const inserts = losers
      .filter((l) => !done.has(l.id))
      .map((l) => ({ quote_id: l.id, event_type: 'lost', actor: 'system', reason: PASSED_OVER_REASON, payload: quoteLossLabel(asLabelQuote(l), w) }))
    if (inserts.length === 0) return 0

    let written = inserts.length
    const { error: insErr } = await admin.from('quote_events').insert(inserts)
    if (insErr) {
      // 23505: a concurrent pass labelled one of them first — write the rest one by one (a conflict is that pass's row).
      if (insErr.code !== '23505') {
        console.error('[loss-labels] insert failed —', inserts.length, 'row(s):', insErr.message)
        return 0
      }
      written = 0
      for (const row of inserts) {
        const { error: e } = await admin.from('quote_events').insert(row)
        if (!e) written++
        else if (e.code !== '23505') console.error('[loss-labels] insert failed —', row.quote_id, e.message)
      }
    }
    if (written > 0) captureServerEvent(`rfq:${args.rfqId}`, 'quote_lost_labelled', { rfq_id: args.rfqId, n: written })
    return written
  } catch (e) {
    console.error('[loss-labels]', e)
    return 0
  }
}
