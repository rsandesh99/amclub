import { z } from 'zod'
import { goodsQuoteMoney } from './compare'
import { quoteChargeAmounts } from './quote-v3'

/**
 * PRD Experience v3 E7 FR-7.3 (N22) — quote loss labels.
 *
 * When a quote is accepted, every other open quote on the RFQ gets ONE
 * `quote_events` row `lost` whose payload says how it compared with the
 * winner: `price_delta_paise` (mine − winner, on the normalised total the
 * buyer compared — what checkout charges, ADR-017) and `days_delta`
 * (mine − winner delivery days; null when either is unstated). Positive =
 * dearer / slower. Written by finalizeQuoteAcceptance, once per quote.
 *
 * The payload lets anyone who reads it rebuild the winner's price, so the row
 * is NOT readable by the losing provider (migration 0058 narrows the provider
 * read policy). Provider surfaces show only the n-gated aggregates of
 * insights-v3 (lossInsight), never a single label.
 */

export const LOSS_LABEL_VERSION = 1

export interface LossLabelQuote {
  pricePaise: number
  gstIncluded: boolean | null
  deliveryDays: number | null
  /** Goods quote terms (Mart); absent / null on a services quote. */
  goods?: { unitPricePaise: number; qty: number; gstRateBps: number } | null
}

/** The normalised total the buyer compared: compareQuotes' number, which is checkout's charge (ADR-017). */
export function quoteNormalizedTotal(q: LossLabelQuote): number {
  if (q.goods) return goodsQuoteMoney(q.goods).totalInclGstPaise
  return quoteChargeAmounts({ pricePaise: q.pricePaise, gstIncluded: q.gstIncluded, commissionBps: 0 }).totalPaise
}

export const quoteLostPayloadSchema = z.object({
  v: z.literal(LOSS_LABEL_VERSION),
  accepted_quote_id: z.string().uuid(),
  /** Mine − winner on the normalised total, integer paise. */
  price_delta_paise: z.number().int(),
  /** Mine − winner delivery days; null when either quote left it unstated. */
  days_delta: z.number().int().nullable(),
}).strict()
export type QuoteLostPayload = z.infer<typeof quoteLostPayloadSchema>

const days = (d: number | null | undefined): number | null => (d != null && Number.isInteger(d) && d > 0 ? d : null)

export function quoteLossLabel(loser: LossLabelQuote, winner: LossLabelQuote & { id: string }): QuoteLostPayload {
  const mine = days(loser.deliveryDays)
  const theirs = days(winner.deliveryDays)
  return {
    v: LOSS_LABEL_VERSION,
    accepted_quote_id: winner.id,
    price_delta_paise: quoteNormalizedTotal(loser) - quoteNormalizedTotal(winner),
    days_delta: mine != null && theirs != null ? mine - theirs : null,
  }
}

/**
 * A stored label back into the insights pair (insights-v3 LossPair): the
 * winner is rebuilt server-side from my own total and the delta, and only the
 * n-gated aggregate ever leaves the server.
 */
export function lossPairFromLabel(mine: { totalPaise: number; deliveryDays: number | null }, label: QuoteLostPayload): { mine: { totalPaise: number; deliveryDays: number | null }; winner: { totalPaise: number; deliveryDays: number | null } } {
  const myDays = days(mine.deliveryDays)
  return {
    mine: { totalPaise: mine.totalPaise, deliveryDays: myDays },
    winner: {
      totalPaise: mine.totalPaise - label.price_delta_paise,
      deliveryDays: myDays != null && label.days_delta != null ? myDays - label.days_delta : null,
    },
  }
}
