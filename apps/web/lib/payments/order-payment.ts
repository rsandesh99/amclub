import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * E12c / ADR 021 — which payment an order was paid by, and its refund row.
 *
 * An ordinary order has its own payment (payments.order_id) and at most one
 * refund row on it (ADR-014), and these helpers run EXACTLY the queries the
 * callers ran before. A bundle child shares its purchase's ONE payment with
 * its siblings, so for it the payment comes from bundle_purchases and the
 * refund row is its OWN (keyed rfnd_<order id>, the key processRefund writes)
 * — one refund row per child, several partial refunds on one payment.
 * `order` is a row read with select('*') (bundle_purchase_id is absent before
 * migration 0067, which is the ordinary branch).
 */
export interface OrderRef {
  id: string
  bundle_purchase_id?: string | null
}

export async function paymentForOrder<T = Record<string, unknown>>(admin: SupabaseClient, order: OrderRef, cols: string): Promise<T | null> {
  if (order.bundle_purchase_id) {
    const { data: bp } = await admin.from('bundle_purchases').select('payment_id').eq('id', order.bundle_purchase_id).maybeSingle()
    const paymentId = (bp as { payment_id?: string | null } | null)?.payment_id
    if (!paymentId) return null
    const { data } = await admin.from('payments').select(cols).eq('id', paymentId).maybeSingle()
    return (data as T | null) ?? null
  }
  const { data } = await admin.from('payments').select(cols).eq('order_id', order.id).maybeSingle()
  return (data as T | null) ?? null
}

/** The order's refund row (ordinary: the one on its payment; bundle child: its own by key). */
export async function refundForOrder<T = Record<string, unknown>>(admin: SupabaseClient, order: OrderRef, paymentId: string, cols: string): Promise<T | null> {
  const q = admin.from('refunds').select(cols)
  const { data } = order.bundle_purchase_id ? await q.eq('idempotency_key', `rfnd_${order.id}`).maybeSingle() : await q.eq('payment_id', paymentId).maybeSingle()
  return (data as T | null) ?? null
}
