import 'server-only'
import { perBuyerLimitReached, type CouponClaimResult } from '@amclub/shared'

/* eslint-disable @typescript-eslint/no-explicit-any */

export type CouponError =
  | 'not_found'
  | 'inactive'
  | 'not_started'
  | 'expired'
  | 'usage_exceeded'
  | 'per_buyer_exceeded'
  | 'category_mismatch'

export interface CouponEvaluation {
  /** Discount in paise, clamped to [0, taxableBeforeCoupon]. */
  discountPaise: number
  /** Set when the code is unusable. discountPaise is 0 in that case. */
  error?: CouponError
  code?: string
  kind?: 'percent' | 'fixed'
}

/**
 * Pure coupon math + validity (§5.5). Shared by the checkout route (to freeze
 * the discount) and the validate endpoint (to message the buyer). Money stays
 * integer paise throughout (§2.5 rule 6).
 *
 * `taxableBeforeCoupon` is the post-listing-discount, pre-GST base in paise.
 * `buyerRedemptions` is how many times this buyer has redeemed the coupon
 * (audit M10: `coupons.per_buyer_limit`). These are the pre-checks; the
 * checkout's claim (`claim_coupon_for_session`) is the atomic authority.
 */
export function evaluateCoupon(
  coupon: any | null,
  taxableBeforeCoupon: number,
  categoryId: string | null,
  opts: { now?: Date; buyerRedemptions?: number } = {},
): CouponEvaluation {
  const now = opts.now ?? new Date()
  if (!coupon) return { discountPaise: 0, error: 'not_found' }
  if (!coupon.is_active) return { discountPaise: 0, error: 'inactive', code: coupon.code }
  if (coupon.valid_from && new Date(coupon.valid_from) > now) return { discountPaise: 0, error: 'not_started', code: coupon.code }
  if (coupon.valid_to && new Date(coupon.valid_to) < now) return { discountPaise: 0, error: 'expired', code: coupon.code }
  if (coupon.usage_limit != null && coupon.used_count >= coupon.usage_limit) return { discountPaise: 0, error: 'usage_exceeded', code: coupon.code }
  if (perBuyerLimitReached(coupon.per_buyer_limit, opts.buyerRedemptions ?? 0)) return { discountPaise: 0, error: 'per_buyer_exceeded', code: coupon.code }
  if (coupon.category_id && categoryId && coupon.category_id !== categoryId) return { discountPaise: 0, error: 'category_mismatch', code: coupon.code }

  let discount = 0
  if (coupon.kind === 'percent') discount = Math.round((taxableBeforeCoupon * coupon.value_bps) / 10000)
  else if (coupon.kind === 'fixed') discount = coupon.value_bps // paise for fixed coupons
  if (coupon.max_discount_paise != null) discount = Math.min(discount, coupon.max_discount_paise)
  discount = Math.max(0, Math.min(discount, taxableBeforeCoupon))
  return { discountPaise: discount, code: coupon.code, kind: coupon.kind }
}

/** Human-facing (i18n key suffix) message for a rejection. */
export const COUPON_ERROR_KEY: Record<CouponError, string> = {
  not_found: 'coupon_not_found',
  inactive: 'coupon_inactive',
  not_started: 'coupon_not_started',
  expired: 'coupon_expired',
  usage_exceeded: 'coupon_usage_exceeded',
  per_buyer_exceeded: 'coupon_per_buyer_exceeded',
  category_mismatch: 'coupon_category_mismatch',
}

/**
 * Audit M10 — why the checkout's claim refused the coupon, as a key in the
 * `coupons` messages namespace (the checkout answers 409 `coupon_unavailable`
 * with it as `couponError`). `null` is a claim the database could not answer.
 */
export function couponClaimRefusalKey(r: CouponClaimResult | null): string {
  switch (r) {
    case 'usage_exceeded': return 'coupon_usage_exceeded'
    case 'per_buyer_exceeded': return 'coupon_per_buyer_exceeded'
    case 'per_buyer_pending': return 'coupon_in_checkout'
    case 'inactive': return 'coupon_inactive'
    case 'not_found': return 'coupon_not_found'
    default: return 'coupon_unavailable'
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
