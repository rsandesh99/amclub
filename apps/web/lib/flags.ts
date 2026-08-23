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

/**
 * GATEWAY_ENABLED — Phase 8a two-door gateway at `/` for anonymous visitors.
 * Default ON (founder-approved scope, DESIGN.md §6 Phase 8a); set
 * GATEWAY_ENABLED=false as the kill switch to serve the previous
 * "Confident Marketplace" landing page unchanged.
 */
export const GATEWAY_ENABLED = process.env['GATEWAY_ENABLED'] !== 'false'

/**
 * PAYOUT_AUTO_RELEASE — founder control gate on provider payouts (launch
 * decision, 2026-08-23). Default OFF: every payout is created 'held' and money
 * can only move after an admin explicitly releases it from /admin/payouts,
 * having checked the delivered work. Set PAYOUT_AUTO_RELEASE=true to restore
 * the automatic buyer-acceptance → T+2 → cron flow once trust is established.
 */
export const PAYOUT_AUTO_RELEASE = process.env['PAYOUT_AUTO_RELEASE'] === 'true'
