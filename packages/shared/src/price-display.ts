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
}): PriceDisplay {
  const gstBps = input.gstBps ?? DEFAULT_GST_BPS
  const a = computeOrderAmounts({ pricePaise: input.pricePaise, discountBps: input.discountBps, commissionBps: 0, gstBps })
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
