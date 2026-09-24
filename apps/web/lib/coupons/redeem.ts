import 'server-only'
import { isCouponClaimResult, type CouponClaimResult } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * Record a coupon_redemption for a freshly materialised order and bump the
 * coupon's used_count — exactly once per order. The coupon code lives on the
 * checkout_session (frozen at checkout); we only act if a discount was actually
 * applied. materialize_order normally records it in the same transaction as the
 * order; this is the fallback the materialise path calls afterwards.
 *
 * Audit M10: the insert and the bump are ONE statement pair inside
 * `record_coupon_redemption` (0081, service role only) — the row lock on the
 * coupon and the (coupon_id, order_id) primary key make a replay a no-op, and the
 * old read-modify-write fallback (which could lose a concurrent bump) is gone.
 */
export async function recordCouponRedemption(admin: Admin, orderId: string): Promise<void> {
  const { error } = await admin.rpc('record_coupon_redemption', { p_order_id: orderId })
  if (error) console.error('[recordCouponRedemption]', orderId, error.message)
}

/**
 * Audit M10 — claim one use of the session's coupon (the session must carry the
 * code it applied). Decided in the database under the coupon's row lock: uses
 * already redeemed plus live claims of other unpaid sessions stay under the
 * usage limit, and the same for this buyer under the per-buyer limit. The
 * checkout opens a payment only for a held claim. A database error answers
 * `null`: the caller refuses the coupon (fail closed), never skips the claim.
 */
export async function claimCouponForSession(admin: Admin, sessionId: string): Promise<CouponClaimResult | null> {
  const { data, error } = await admin.rpc('claim_coupon_for_session', { p_session_id: sessionId })
  if (error) {
    console.error('[claimCouponForSession]', sessionId, error.message)
    return null
  }
  return isCouponClaimResult(data) ? data : null
}

/** How many times this buyer business has redeemed the coupon (the per-buyer pre-check). */
export async function buyerRedemptions(admin: Admin, couponId: string, msmeId: string): Promise<number> {
  const { count } = await admin.from('coupon_redemptions').select('order_id', { count: 'exact', head: true }).eq('coupon_id', couponId).eq('msme_id', msmeId)
  return count ?? 0
}
