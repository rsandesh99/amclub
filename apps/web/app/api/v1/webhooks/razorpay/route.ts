/**
 * Razorpay webhook — the SINGLE SOURCE OF TRUTH for payment state (§2.5).
 * The client redirect is cosmetic; THIS handler creates the order.
 *
 * - Verifies the HMAC signature over the RAW request body (never re-serialized).
 * - payment.captured → materialize_order (atomic + idempotent). A replayed
 *   payload creates NO duplicate order (proven by the replay kill-test).
 * - payment.failed → no order created.
 *
 * Returns 400 only on a bad signature (so Razorpay doesn't retry a forgery);
 * 200 otherwise, including for events we ignore.
 */
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyWebhookSignature } from '@/lib/payments/signature'
import { materializeFromCapture } from '@/lib/payments/materialize'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-razorpay-signature')

  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn('[razorpay webhook] invalid signature — rejected')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  let body: {
    event?: string
    payload?: { payment?: { entity?: Record<string, unknown> } }
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
    const { orderId, error } = await materializeFromCapture(admin, {
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
    if (!orderId) {
      console.warn('[razorpay webhook] captured payment with no known checkout_session', entity['order_id'])
    }
    return NextResponse.json({ ok: true, orderId })
  }

  if (event === 'payment.failed') {
    // No order is created on failure (§3.8).
    return NextResponse.json({ ok: true, ignored: 'payment.failed' })
  }

  return NextResponse.json({ ok: true, ignored: event ?? 'unknown' })
}
