import { z } from 'zod'
import { computeOrderAmounts, DEFAULT_GST_BPS } from './money'

/**
 * N16 (PRD Experience v3 FR-4.3) — the ONE price shape every catalog, package
 * and checkout payload carries. Computed on the server by the same
 * computeOrderAmounts that prices the order, so a card, the package page and
 * checkout can never disagree. Clients render these numbers; they never add,
 * subtract or multiply money (lint: amclub/no-client-money-math).
 */
export const priceDisplaySchema = z.object({
  /** The list price before the package discount. */
  listPaise: z.number().int(),
  discountPaise: z.number().int(),
  /** What GST is charged on ("₹X" in "₹X + 18 % GST"). */
  taxablePaise: z.number().int(),
  gstPaise: z.number().int(),
  gstBps: z.number().int(),
  /** What the buyer pays ("= ₹Y"). */
  totalPaise: z.number().int(),
  /** Input tax credit a GST-registered buyer can claim; null when not known to apply. */
  itcPaise: z.number().int().nullable(),
  /** Whole-percent label for the "X% OFF" pill (from basis points, not money). */
  discountPct: z.number().int(),
  /** Member price (taxable, after the member extra discount); null when none is configured. */
  memberPaise: z.number().int().nullable(),
  memberExtraPct: z.number().int(),
})
export type PriceDisplay = z.infer<typeof priceDisplaySchema>

export function priceDisplay(input: {
  pricePaise: number
  discountBps: number
  memberExtraDiscountBps?: number
  gstBps?: number
  buyerHasGstin?: boolean
  /** A coupon (flat paise off the pre-GST price), exactly as checkout applies it. */
  extraDiscountPaise?: number
}): PriceDisplay {
  const gstBps = input.gstBps ?? DEFAULT_GST_BPS
  const a = computeOrderAmounts({
    pricePaise: input.pricePaise,
    discountBps: input.discountBps,
    commissionBps: 0,
    gstBps,
    ...(input.extraDiscountPaise ? { extraDiscountPaise: input.extraDiscountPaise } : {}),
  })
  const memberBps = input.memberExtraDiscountBps ?? 0
  return {
    listPaise: a.pricePaise,
    discountPaise: a.discountPaise,
    taxablePaise: a.taxablePaise,
    gstPaise: a.gstPaise,
    gstBps,
    totalPaise: a.totalPaise,
    itcPaise: input.buyerHasGstin ? a.gstPaise : null,
    discountPct: Math.round(input.discountBps / 100),
    memberPaise: memberBps > 0 ? a.taxablePaise - Math.round((a.taxablePaise * memberBps) / 10000) : null,
    memberExtraPct: Math.round(memberBps / 100),
  }
}

/** Percent for "18 % GST" from basis points (never money). */
export const gstPercent = (bps: number): number => Math.round(bps / 100)

/**
 * E9 (FR-9.3) — the same shape for what an order ACTUALLY charged, read from
 * its stored amounts (never recomputed): "₹1,000 last time" on Buy again.
 * `discountPaise` already includes any coupon the buyer used then.
 */
export function orderPriceDisplay(o: { pricePaise: number; discountPaise: number; gstPaise: number; totalPaise: number }): PriceDisplay {
  const taxablePaise = o.pricePaise - o.discountPaise
  return {
    listPaise: o.pricePaise,
    discountPaise: o.discountPaise,
    taxablePaise,
    gstPaise: o.gstPaise,
    gstBps: taxablePaise > 0 ? Math.round((o.gstPaise * 10000) / taxablePaise) : DEFAULT_GST_BPS,
    totalPaise: o.totalPaise,
    itcPaise: null,
    discountPct: o.pricePaise > 0 ? Math.round((o.discountPaise * 100) / o.pricePaise) : 0,
    memberPaise: null,
    memberExtraPct: 0,
  }
}
