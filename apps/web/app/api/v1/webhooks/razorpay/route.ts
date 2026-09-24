/**
 * Razorpay webhook — the SINGLE SOURCE OF TRUTH for payment state (§2.5).
 * The client redirect is cosmetic; THIS handler creates the order.
 *
 * - Verifies the HMAC signature over the RAW request body (never re-serialized).
 * - payment.captured → capture_payment → materialize_order (atomic +
 *   idempotent). A replayed payload creates NO duplicate order (proven by the
 *   replay kill-test). ADR 027: a capture on an expired session or on a session
 *   another payment already paid creates no order and is refunded in full.
 * - payment.failed → no order created.
 * - ADR 027 (audit M20): refund.processed / refund.failed settle the refund row
 *   (or a capture exception's refund); transfer.processed / .failed / .reversed
 *   settle the payout; payment.dispute.created / .lost / .won / .closed record
 *   the chargeback and hold the payout. Each is idempotent (lib/payments/webhook-events).
 *
 * Returns 400 only on a bad signature (so Razorpay doesn't retry a forgery);
 * 500 on a transient failure (Razorpay retries — every handler is replay-safe);
 * 200 otherwise, including for events we ignore.
 */
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyWebhookSignature } from '@/lib/payments/signature'
import { materializeFromCapture } from '@/lib/payments/materialize'
import { CHARGEBACK_EVENTS, handleChargebackEvent, handleRefundEvent, handleTransferEvent, type ChargebackEvent } from '@/lib/payments/webhook-events'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Entity = Record<string, unknown>

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-razorpay-signature')

  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn('[razorpay webhook] invalid signature — rejected')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  let body: {
    event?: string
    payload?: {
      payment?: { entity?: Entity }
      refund?: { entity?: Entity }
      transfer?: { entity?: Entity }
      dispute?: { entity?: Entity }
    }
  }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const event = body.event
  const entity = body.payload?.payment?.entity

  if (event === 'payment.captured' && entity) {
    const admin = await createAdminClient()
    const { orderId, error, outcome } = await materializeFromCapture(admin, {
      razorpayOrderId: String(entity['order_id']),
      razorpayPaymentId: String(entity['id']),
      amountPaise: Number(entity['amount']),
      ...(entity['method'] ? { method: String(entity['method']) } : {}),
      payload: body,
    })
    if (error) {
      // 500 → Razorpay retries (transient DB issue). Idempotent, so retry is safe.
      return NextResponse.json({ error }, { status: 500 })
    }
    if (!orderId && outcome === 'unknown_session') {
      console.warn('[razorpay webhook] captured payment with no known checkout_session', entity['order_id'])
    }
    return NextResponse.json({ ok: true, orderId, ...(outcome && outcome !== 'materialized' && outcome !== 'existing' ? { outcome } : {}) })
  }

  if (event === 'payment.failed') {
    // No order is created on failure (§3.8). Deliberately NOT written to the
    // checkout session: Razorpay lets the buyer retry on the SAME order, and
    // materialize_order only claims a session in status 'created' — marking it
    // 'failed' here would strand a later successful capture. There is no
    // separate attempt/failure column to record into, so log it for ops only.
    console.warn('[razorpay webhook] payment.failed', entity?.['order_id'] ?? null, entity?.['error_code'] ?? null)
    return NextResponse.json({ ok: true, ignored: 'payment.failed' })
  }

  try {
    if ((event === 'refund.processed' || event === 'refund.failed') && body.payload?.refund?.entity) {
      const r = await handleRefundEvent(await createAdminClient(), event, body.payload.refund.entity)
      return NextResponse.json(r)
    }
    if ((event === 'transfer.processed' || event === 'transfer.failed' || event === 'transfer.reversed') && body.payload?.transfer?.entity) {
      const r = await handleTransferEvent(await createAdminClient(), event, body.payload.transfer.entity)
      return NextResponse.json(r)
    }
    if (event && Object.prototype.hasOwnProperty.call(CHARGEBACK_EVENTS, event) && body.payload?.dispute?.entity) {
      const r = await handleChargebackEvent(await createAdminClient(), event as ChargebackEvent, body.payload.dispute.entity)
      return NextResponse.json(r)
    }
  } catch (e) {
    // Transient (DB) failure: 500 so Razorpay retries; every handler is replay-safe.
    console.error('[razorpay webhook]', event, e)
    return NextResponse.json({ error: 'webhook_failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, ignored: event ?? 'unknown' })
}
