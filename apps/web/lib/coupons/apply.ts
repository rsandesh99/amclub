import 'server-only'

/* eslint-disable @typescript-eslint/no-explicit-any */

export type CouponError =
  | 'not_found'
  | 'inactive'
  | 'not_started'
  | 'expired'
  | 'usage_exceeded'
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
 */
export function evaluateCoupon(
  coupon: any | null,
  taxableBeforeCoupon: number,
  categoryId: string | null,
  now: Date = new Date(),
): CouponEvaluation {
  if (!coupon) return { discountPaise: 0, error: 'not_found' }
  if (!coupon.is_active) return { discountPaise: 0, error: 'inactive', code: coupon.code }
  if (coupon.valid_from && new Date(coupon.valid_from) > now) return { discountPaise: 0, error: 'not_started', code: coupon.code }
  if (coupon.valid_to && new Date(coupon.valid_to) < now) return { discountPaise: 0, error: 'expired', code: coupon.code }
  if (coupon.usage_limit != null && coupon.used_count >= coupon.usage_limit) return { discountPaise: 0, error: 'usage_exceeded', code: coupon.code }
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
  category_mismatch: 'coupon_category_mismatch',
}
/* eslint-enable @typescript-eslint/no-explicit-any */
