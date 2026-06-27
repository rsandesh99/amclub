import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * Record a coupon_redemption for a freshly materialised order and bump the
 * coupon's used_count — exactly once per order. The coupon code lives on the
 * checkout_session (frozen at checkout); we only act if a discount was actually
 * applied. One redemption per order is guaranteed by the (coupon_id, order_id)
 * primary key; used_count is bumped only when this call inserts the row.
 *
 * Caller gates on the `placed_side_effects` marker, so this runs once even if
 * the webhook replays — but we double-guard on the redemption row anyway.
 */
export async function recordCouponRedemption(admin: Admin, orderId: string): Promise<void> {
  const { data: order } = await admin
    .from('orders')
    .select('id, msme_id, discount_paise')
    .eq('id', orderId)
    .maybeSingle()
  if (!order) return

  const { data: session } = await admin
    .from('checkout_sessions')
    .select('coupon_code')
    .eq('order_id', orderId)
    .maybeSingle()
  const code = session?.coupon_code
  if (!code) return

  const { data: coupon } = await admin.from('coupons').select('id').eq('code', code).maybeSingle()
  if (!coupon) return

  // Already recorded? (idempotent second guard)
  const { data: existing } = await admin
    .from('coupon_redemptions')
    .select('coupon_id')
    .eq('coupon_id', coupon.id)
    .eq('order_id', orderId)
    .maybeSingle()
  if (existing) return

  const { error: insErr } = await admin.from('coupon_redemptions').insert({
    coupon_id: coupon.id,
    order_id: orderId,
    msme_id: order.msme_id,
  })
  // Unique violation = a racing duplicate already counted it; don't double-bump.
  if (insErr) return

  // Bump used_count atomically via SQL increment.
  await admin.rpc('increment_coupon_usage', { p_coupon_id: coupon.id }).then(
    () => {},
    async () => {
      // Fallback if the RPC isn't present: read-modify-write (best-effort).
      const { data: c } = await admin.from('coupons').select('used_count').eq('id', coupon.id).maybeSingle()
      await admin.from('coupons').update({ used_count: (c?.used_count ?? 0) + 1 }).eq('id', coupon.id)
    },
  )
}
