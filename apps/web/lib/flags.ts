import 'server-only'

/**
 * Server-evaluated feature flags.
 *
 * COUPONS_ENABLED — master switch for the entire Phase-6 coupon path: the
 * checkout coupon input, the coupon branch in the money math, the
 * /coupons/validate + /admin/coupons endpoints, and the admin Coupons UI.
 * Default OFF (business decision — keep the payment path minimal). All coupon
 * code (tables, evaluator, redemption) stays in the repo, dormant; set
 * COUPONS_ENABLED=true to restore the full behaviour with no code change.
 */
export const COUPONS_ENABLED = process.env['COUPONS_ENABLED'] === 'true'
