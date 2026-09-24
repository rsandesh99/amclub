import { createAdminClient } from '@/lib/supabase/server'
import type { PaymentGateway, GatewayPayment } from './types'
import { finalizeQuoteAcceptance, type FinalizeResult } from '@/lib/rfq/finalize'
import { notifyOrderPlaced } from '@/lib/notifications/events'
import { recordCouponRedemption } from '@/lib/coupons/redeem'
import { copyAttributionToOrder } from '@/lib/search/attribution'
import { captureServerEvent } from '@/lib/analytics/server'
import { getPaymentGateway } from './index'
import { paymentsAvailable } from './simulation'
import { announceCaptureException, isCaptureException, refundCaptureException, type CaptureOutcome } from './capture-exceptions'

export interface CaptureInput {
  razorpayOrderId: string
  razorpayPaymentId: string
  amountPaise: number
  method?: string
  payload: unknown
}

/**
 * ADR 027 (audit M21) — a capture this long after the session's expires_at is
 * still honoured: the Razorpay sheet closes at expires_at (Checkout `timeout`),
 * but a payment authorised just before can capture a few minutes later.
 */
export const CAPTURE_GRACE_SECONDS = 15 * 60

/**
 * Idempotently materialise an order from a captured payment by calling the
 * atomic `capture_payment` Postgres function (migration 0078), which runs
 * `materialize_order` for a live session. Used by the webhook, the simulate
 * route AND the reconciliation cron — one path for normal + dropped-webhook
 * recovery. Returns the order id (existing or newly created), or null if the
 * checkout_session is unknown or the capture created no order.
 *
 * ADR 027: a capture on a session past expires_at + CAPTURE_GRACE_SECONDS
 * (M21), or on a session another payment already paid (M39), is recorded as a
 * capture exception — never an order — and refunded in full right here
 * (best-effort; the auto-cancel cron's sweeper retries). `outcome` says which.
 */
export async function materializeFromCapture(
  admin: Awaited<ReturnType<typeof createAdminClient>>,
  capture: CaptureInput,
): Promise<{ orderId: string | null; error?: string; outcome?: CaptureOutcome['outcome']; exceptionId?: string }> {
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

  const { data, error } = await admin.rpc('capture_payment', {
    p_razorpay_order_id: capture.razorpayOrderId,
    p_razorpay_payment_id: capture.razorpayPaymentId,
    p_amount_paise: capture.amountPaise,
    p_method: capture.method ?? null,
    p_payload: capture.payload ?? {},
    p_grace_seconds: CAPTURE_GRACE_SECONDS,
  })
  if (error) {
    console.error('[materializeFromCapture]', error)
    return { orderId: null, error: error.message }
  }
  const result = (data ?? { outcome: 'unknown_session' }) as CaptureOutcome

  // ADR 027 — the money is recorded, no order exists for it: refund it in full.
  if (isCaptureException(result)) {
    if (result.created) await announceCaptureException(admin, result.exception_id)
    const gateway = getPaymentGateway()
    if (paymentsAvailable(gateway.isReal)) {
      try {
        await refundCaptureException(admin, gateway, result.exception_id)
      } catch (e) {
        console.error('[materializeFromCapture] capture refund', result.exception_id, e)
      }
    }
    return { orderId: null, outcome: result.outcome, exceptionId: result.exception_id }
  }

  const orderId = result.order_id ?? null
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
    // A duplicate RFQ order (P0-5; finalize cancels and refunds it, ADR-014 §7)
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
      // E15 F5 — the search that led to this order (best-effort; never affects the order).
      await copyAttributionToOrder(admin, orderId)
      // E12c — a bundle's children were created with the order (trigger); count the purchase once.
      try {
        const { data: carrier } = await admin.from('orders').select('*').eq('id', orderId).maybeSingle()
        const bp = (carrier as { bundle_purchase_id?: string | null; msme_id?: string } | null)?.bundle_purchase_id
        if (bp) captureServerEvent('system', 'bundle_purchased', { bundle_purchase_id: bp })
      } catch {
        /* telemetry only */
      }
      if (finalized !== 'duplicate_flagged') {
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
  return { orderId, outcome: result.outcome }
}

/**
 * Reconciliation: compare Razorpay's captured payments against the local
 * payments table and materialise any that are missing (dropped-webhook
 * recovery). Idempotent — re-running recovers nothing new.
 *
 * ADR 027 (audit M39): a second captured payment on a session that another
 * payment already paid is recorded as a `duplicate_capture` exception and
 * refunded in full (capture_payment decides; one path with the webhook), and
 * only orders created by THIS run count as recovered.
 */
export async function reconcileCapturedPayments(
  gateway: PaymentGateway,
  sinceUnixSeconds: number,
  admin?: Awaited<ReturnType<typeof createAdminClient>>,
): Promise<{ checked: number; recovered: number; orderIds: string[]; exceptions: number; unavailable?: true }> {
  // ADR 027 (audit M2): the simulation mock has no captured payments to report;
  // on production without real keys there is nothing to reconcile against.
  if (!paymentsAvailable(gateway.isReal)) return { checked: 0, recovered: 0, orderIds: [], exceptions: 0, unavailable: true }
  const db = admin ?? (await createAdminClient())
  const captured: GatewayPayment[] = await gateway.listCapturedPayments(sinceUnixSeconds)

  const orderIds: string[] = []
  let exceptions = 0
  for (const pay of captured) {
    const { data: existing } = await db
      .from('payments')
      .select('id')
      .eq('razorpay_payment_id', pay.razorpayPaymentId)
      .maybeSingle()
    if (existing) continue
    // Already recorded as a capture exception: its refund is the sweeper's job.
    const { data: known } = await db.from('capture_exceptions').select('id').eq('razorpay_payment_id', pay.razorpayPaymentId).maybeSingle()
    if (known) continue

    const r = await materializeFromCapture(db, {
      razorpayOrderId: pay.razorpayOrderId,
      razorpayPaymentId: pay.razorpayPaymentId,
      amountPaise: pay.amountPaise,
      ...(pay.method ? { method: pay.method } : {}),
      payload: { source: 'reconciliation', payment: pay },
    })
    if (r.orderId && r.outcome === 'materialized') orderIds.push(r.orderId)
    if (r.exceptionId) exceptions++
  }
  return { checked: captured.length, recovered: orderIds.length, orderIds, exceptions }
}
