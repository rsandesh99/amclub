/**
 * Money math for orders. All amounts are integer paise (§2.5 rule 6) — never
 * floats. Every rounding is explicit and centralised here so the buyer total,
 * provider earning, and refunds are computed one way across web + mobile + jobs.
 *
 * PROVISIONAL TAX STRUCTURE — §9.1 requires CA sign-off on the marketplace GST
 * structure (SAC 9985/9997) before go-live. Rates are configurable; the split
 * below (commission on the taxable value; GST added on top; provider earns
 * taxable − commission) is the working model for TEST MODE, not tax advice.
 */

/** Standard services GST. 18% = 1800 bps. Override per-call if needed. */
export const DEFAULT_GST_BPS = 1800

export interface OrderAmounts {
  pricePaise: number
  discountPaise: number
  /** price − discount; the taxable service value. */
  taxablePaise: number
  gstPaise: number
  /** What the buyer pays = taxable + GST. */
  totalPaise: number
  commissionBps: number
  commissionPaise: number
  /** What the provider earns = taxable − commission. */
  providerEarningPaise: number
}

/**
 * Compute all order money columns from the listing price, discount, the
 * category commission (frozen at order time), and the GST rate.
 */
export function computeOrderAmounts(input: {
  pricePaise: number
  discountBps: number
  commissionBps: number
  gstBps?: number
  /** Additional flat discount in paise (e.g. a coupon), applied after the
   *  package's percentage discount. Clamped so taxable never goes negative. */
  extraDiscountPaise?: number
}): OrderAmounts {
  const gstBps = input.gstBps ?? DEFAULT_GST_BPS
  const pricePaise = Math.round(input.pricePaise)
  const pkgDiscount = Math.round((pricePaise * input.discountBps) / 10000)
  const extra = Math.max(0, Math.round(input.extraDiscountPaise ?? 0))
  const discountPaise = Math.min(pricePaise, pkgDiscount + extra)
  const taxablePaise = pricePaise - discountPaise
  const gstPaise = Math.round((taxablePaise * gstBps) / 10000)
  const totalPaise = taxablePaise + gstPaise
  const commissionPaise = Math.round((taxablePaise * input.commissionBps) / 10000)
  const providerEarningPaise = taxablePaise - commissionPaise
  return {
    pricePaise,
    discountPaise,
    taxablePaise,
    gstPaise,
    totalPaise,
    commissionBps: input.commissionBps,
    commissionPaise,
    providerEarningPaise,
  }
}

/**
 * ADR-015 — order money for a services quote whose price the provider marked
 * "GST included". The quoted figure IS what the buyer pays: GST is carved out
 * of it rather than added on top, so `totalPaise === grossPaise` always.
 *   taxable = round(gross × 10000 / (10000 + gstBps)); gst = gross − taxable
 * Commission and the provider's earning are on the taxable value, as for every
 * other order. `pricePaise` is the pre-GST price (= taxable, no discount), so the
 * order columns mean the same thing whichever way the provider quoted.
 */
export function computeGstInclusiveOrderAmounts(input: {
  grossPaise: number
  commissionBps: number
  gstBps?: number
}): OrderAmounts {
  const gstBps = input.gstBps ?? DEFAULT_GST_BPS
  const grossPaise = Math.max(0, Math.round(input.grossPaise))
  const taxablePaise = Math.round((grossPaise * 10000) / (10000 + gstBps))
  const gstPaise = grossPaise - taxablePaise
  const commissionPaise = Math.round((taxablePaise * input.commissionBps) / 10000)
  return {
    pricePaise: taxablePaise,
    discountPaise: 0,
    taxablePaise,
    gstPaise,
    totalPaise: grossPaise,
    commissionBps: input.commissionBps,
    commissionPaise,
    providerEarningPaise: taxablePaise - commissionPaise,
  }
}

// ── Refund policy matrix (§9.2) ────────────────────────────────────────────────
//
// "pre-accept 100%, in-progress per-policy, disputed per-resolution" — encoded
// here as ONE function, unit-tested. The in-progress percentages are AMClub
// policy defaults (the doc leaves the exact % to policy); tune in one place.

import type { OrderStatus } from './state-machines'

/** Percent (bps) of the buyer total refunded when an order in `fromStatus` is
 *  cancelled by the buyer / auto-cancelled. 10000 = 100%. */
export const REFUND_POLICY_BPS: Partial<Record<OrderStatus, number>> = {
  placed: 10000, // pre-accept — full refund
  accepted: 10000, // accepted but no requirements/work yet — full refund
  requirements_submitted: 10000, // work not started — full refund
  in_progress: 5000, // work underway — 50%
  delivered: 0, // work delivered — no auto-refund (dispute only)
}

export type DisputeResolution = 'refund_full' | 'refund_partial' | 'release'

/**
 * Single source of refund truth. Returns the paise to refund to the buyer.
 *
 * - cancellation/auto-cancel: matrix percentage of `totalPaise` by `fromStatus`
 * - dispute resolution: refund_full = total, refund_partial = resolutionAmount,
 *   release = 0
 */
export function computeRefundPaise(params: {
  totalPaise: number
  fromStatus: OrderStatus
  resolution?: DisputeResolution
  resolutionAmountPaise?: number
}): number {
  const { totalPaise, fromStatus, resolution, resolutionAmountPaise } = params

  if (resolution) {
    if (resolution === 'refund_full') return totalPaise
    if (resolution === 'release') return 0
    // refund_partial — clamp to [0, total]
    const amt = resolutionAmountPaise ?? 0
    return Math.max(0, Math.min(amt, totalPaise))
  }

  const bps = REFUND_POLICY_BPS[fromStatus] ?? 0
  return Math.round((totalPaise * bps) / 10000)
}
