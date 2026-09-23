import { createAdminClient } from '@/lib/supabase/server'
import type { PaymentGateway, GatewayPayment } from './types'
import { finalizeQuoteAcceptance, type FinalizeResult } from '@/lib/rfq/finalize'
import { notifyOrderPlaced } from '@/lib/notifications/events'
import { recordCouponRedemption } from '@/lib/coupons/redeem'

export interface CaptureInput {
  razorpayOrderId: string
  razorpayPaymentId: string
  amountPaise: number
  method?: string
  payload: unknown
}

/**
 * Idempotently materialise an order from a captured payment by calling the
 * atomic `materialize_order` Postgres function. Used by BOTH the webhook and
 * the reconciliation cron — one path for normal + dropped-webhook recovery.
 * Returns the order id (existing or newly created), or null if the
 * checkout_session is unknown.
 */
export async function materializeFromCapture(
  admin: Awaited<ReturnType<typeof createAdminClient>>,
  capture: CaptureInput,
): Promise<{ orderId: string | null; error?: string }> {
  // F5 (defence-in-depth): the captured amount must equal the FROZEN session
  // total. Orders are built from frozen amounts regardless, but a mismatch
  // means someone paid a different amount than the session was created for —
  // refuse to materialise and surface it loudly instead of quietly building
  // an order the payment doesn't cover.
  const { data: session } = await admin
    .from('checkout_sessions')
    .select('total_paise')
    .eq('razorpay_order_id', capture.razorpayOrderId)
    .maybeSingle()
  if (session && Number(session.total_paise) !== Number(capture.amountPaise)) {
    console.error(
      '[materializeFromCapture] AMOUNT MISMATCH: session total',
      session.total_paise,
      'vs captured',
      capture.amountPaise,
      'for razorpay order',
      capture.razorpayOrderId,
    )
    return { orderId: null, error: 'amount_mismatch' }
  }

  const { data, error } = await admin.rpc('materialize_order', {
    p_razorpay_order_id: capture.razorpayOrderId,
    p_razorpay_payment_id: capture.razorpayPaymentId,
    p_amount_paise: capture.amountPaise,
    p_method: capture.method ?? null,
    p_payload: capture.payload ?? {},
  })
  if (error) {
    console.error('[materializeFromCapture]', error)
    return { orderId: null, error: error.message }
  }
  const orderId = (data as string | null) ?? null
  if (orderId) {
    // Quote-sourced orders: accept the quote, auto-decline siblings, close the
    // RFQ. Idempotent + best-effort — must never fail order creation.
    let finalized: FinalizeResult = 'noop'
    try {
      finalized = await finalizeQuoteAcceptance(admin, orderId)
    } catch (e) {
      console.error('[finalizeQuoteAcceptance]', e)
    }
    // One-time placed side effects (coupon redemption + notifications). The
    // webhook can replay, so gate on an order_events marker — these run once.
    // A duplicate RFQ order that finalize already cancelled + refunded (P0-5)
    // gets the marker but no "new order" notice / coupon redemption — the
    // provider must never be told to start work on it.
    const { data: already } = await admin
      .from('order_events')
      .select('id')
      .eq('order_id', orderId)
      .eq('event', 'placed_side_effects')
      .maybeSingle()
    if (!already) {
      await admin.from('order_events').insert({ order_id: orderId, event: 'placed_side_effects' })
      if (finalized !== 'duplicate_refunded') {
        try {
          await recordCouponRedemption(admin, orderId)
        } catch (e) {
          console.error('[recordCouponRedemption]', e)
        }
        try {
          await notifyOrderPlaced(admin, orderId)
        } catch (e) {
          console.error('[notifyOrderPlaced]', e)
        }
      }
    }
  }
  return { orderId }
}

/**
 * Reconciliation: compare Razorpay's captured payments against the local
 * payments table and materialise any that are missing (dropped-webhook
 * recovery). Idempotent — re-running recovers nothing new.
 */
export async function reconcileCapturedPayments(
  gateway: PaymentGateway,
  sinceUnixSeconds: number,
  admin?: Awaited<ReturnType<typeof createAdminClient>>,
): Promise<{ checked: number; recovered: number; orderIds: string[] }> {
  const db = admin ?? (await createAdminClient())
  const captured: GatewayPayment[] = await gateway.listCapturedPayments(sinceUnixSeconds)

  const orderIds: string[] = []
  for (const pay of captured) {
    const { data: existing } = await db
      .from('payments')
      .select('id')
      .eq('razorpay_payment_id', pay.razorpayPaymentId)
      .maybeSingle()
    if (existing) continue

    const { orderId } = await materializeFromCapture(db, {
      razorpayOrderId: pay.razorpayOrderId,
      razorpayPaymentId: pay.razorpayPaymentId,
      amountPaise: pay.amountPaise,
      ...(pay.method ? { method: pay.method } : {}),
      payload: { source: 'reconciliation', payment: pay },
    })
    if (orderId) orderIds.push(orderId)
  }
  return { checked: captured.length, recovered: orderIds.length, orderIds }
}
