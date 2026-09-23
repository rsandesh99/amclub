import { z } from 'zod'
import { computeGstInclusiveOrderAmounts, computeOrderAmounts, DEFAULT_GST_BPS, type OrderAmounts } from './money'

/**
 * PRD Experience v3 E11 FR-11.4 — quote form v3 and the server preview.
 *
 * "One number everywhere": for a services quote, what the buyer's compare
 * screen totals, what checkout charges and what the provider's preview says
 * are the SAME function of (price, gst_included). ADR-015 fixed "included"
 * (carve GST out); ADR-017 makes compare treat "unstated" as checkout always
 * has — GST on top — so an unstated quote is never shown cheaper than it
 * charges.
 */

/** The ONE rule for what a services quote charges (checkout's quote branch). */
export function quoteChargeAmounts(input: { pricePaise: number; gstIncluded: boolean | null; commissionBps: number; gstBps?: number }): OrderAmounts {
  const gstBps = input.gstBps ?? DEFAULT_GST_BPS
  return input.gstIncluded === true
    ? computeGstInclusiveOrderAmounts({ grossPaise: input.pricePaise, commissionBps: input.commissionBps, gstBps })
    : computeOrderAmounts({ pricePaise: input.pricePaise, discountBps: 0, commissionBps: input.commissionBps, gstBps })
}

export const QUOTE_GST_MODES = ['extra', 'included', 'unstated'] as const
export type QuoteGstMode = (typeof QUOTE_GST_MODES)[number]
export const gstModeOf = (gstIncluded: boolean | null): QuoteGstMode => (gstIncluded === true ? 'included' : gstIncluded === false ? 'extra' : 'unstated')

/** Payouts are scheduled this many days after the buyer accepts (schedulePayout: T+2). */
export const PAYOUT_DAYS_AFTER_ACCEPTANCE = 2

export const quotePreviewRequestSchema = z.object({
  price_paise: z.number().int().positive().max(10_000_000_000),
  gst_included: z.boolean().nullable(),
}).strict()

export const quotePreviewSchema = z.object({
  gstMode: z.enum(QUOTE_GST_MODES),
  /** What GST is charged on. */
  taxablePaise: z.number().int(),
  gstPaise: z.number().int(),
  gstBps: z.number().int(),
  /** "Buyer sees … all-in" = compare's normalised total = checkout's charge. */
  totalPaise: z.number().int(),
  /** "You receive ≈" = taxable − AMClub's commission at the provider's current rate. */
  earningPaise: z.number().int(),
  commissionBps: z.number().int(),
  payoutDaysAfterAcceptance: z.number().int(),
})
export type QuotePreview = z.infer<typeof quotePreviewSchema>

export function quotePreview(input: { pricePaise: number; gstIncluded: boolean | null; commissionBps: number; gstBps?: number }): QuotePreview {
  const a = quoteChargeAmounts(input)
  return {
    gstMode: gstModeOf(input.gstIncluded),
    taxablePaise: a.taxablePaise,
    gstPaise: a.gstPaise,
    gstBps: input.gstBps ?? DEFAULT_GST_BPS,
    totalPaise: a.totalPaise,
    earningPaise: a.providerEarningPaise,
    commissionBps: a.commissionBps,
    payoutDaysAfterAcceptance: PAYOUT_DAYS_AFTER_ACCEPTANCE,
  }
}

// ── the form's presets ──────────────────────────────────────────────────────────────
export const QUOTE_VALIDITY_PRESETS = [3, 7, 14] as const
export const QUOTE_ADVANCE_PRESETS = [0, 20, 50] as const

/** An IST calendar date `days` after `todayIst` (YYYY-MM-DD). */
export function validUntilFromPreset(todayIst: string, days: number): string {
  const t = Date.UTC(Number(todayIst.slice(0, 4)), Number(todayIst.slice(5, 7)) - 1, Number(todayIst.slice(8, 10))) + days * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}
