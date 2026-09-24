import { z } from 'zod'

/**
 * Coupons (§5.5; audit M10, ADR 027).
 *
 * The admin form's schema lives here (Zod first): `value` is in human units — a
 * percentage (10 → 1000 bps) or rupees (500 → 50,000 paise) — and the admin route
 * normalises it to integers before storage (§2.5 rule 6).
 */
export const adminCouponCreateSchema = z
  .object({
    code: z.string().trim().min(3).max(40).transform((s) => s.toUpperCase()),
    kind: z.enum(['percent', 'fixed']),
    value: z.number().positive(),
    maxDiscountRupees: z.number().nonnegative().optional(),
    categorySlug: z.string().optional(),
    validFrom: z.string().datetime(),
    validTo: z.string().datetime(),
    /** Total uses across every buyer (absent = unlimited). */
    usageLimit: z.number().int().positive().optional(),
    /** Uses per buyer business (absent = unlimited). */
    perBuyerLimit: z.number().int().positive().max(1000).optional(),
  })
  .refine((d) => d.kind !== 'percent' || d.value <= 100, { message: 'Percentage cannot exceed 100', path: ['value'] })
  .refine((d) => d.perBuyerLimit == null || d.usageLimit == null || d.perBuyerLimit <= d.usageLimit, {
    message: 'The per-buyer limit cannot exceed the usage limit',
    path: ['perBuyerLimit'],
  })

export type AdminCouponCreate = z.infer<typeof adminCouponCreateSchema>

/**
 * What `claim_coupon_for_session` (migration 0081) answers. The checkout claims a
 * use for its frozen session under the coupon's row lock; only `claimed` /
 * `already_claimed` let the payment be opened.
 */
export const COUPON_CLAIM_RESULTS = [
  'claimed',
  'already_claimed',
  'no_coupon',
  'session_closed',
  'not_found',
  'inactive',
  'usage_exceeded',
  'per_buyer_exceeded',
  'per_buyer_pending',
] as const
export type CouponClaimResult = (typeof COUPON_CLAIM_RESULTS)[number]

export function isCouponClaimResult(v: unknown): v is CouponClaimResult {
  return typeof v === 'string' && (COUPON_CLAIM_RESULTS as readonly string[]).includes(v)
}

/** The session holds a use of its coupon (a fresh claim or a replay of one). */
export function couponClaimHeld(r: CouponClaimResult): boolean {
  return r === 'claimed' || r === 'already_claimed'
}

/**
 * The per-buyer rule the checkout and the validate route apply before the claim,
 * from the buyer's recorded redemptions (the claim is the atomic authority).
 */
export function perBuyerLimitReached(perBuyerLimit: number | null | undefined, buyerRedemptions: number): boolean {
  return perBuyerLimit != null && buyerRedemptions >= perBuyerLimit
}
