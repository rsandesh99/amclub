import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { getPaymentGateway } from '@/lib/payments'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { prepareMemberCheckout } from '@/lib/mart/pools'
import { serverError } from '@/lib/api/errors'
import { accountSuspendedResponse } from '@/lib/auth/suspension'

/**
 * Pay-on-close: the member's goods order at the pool price. Same session →
 * gateway order → webhook → materialize_order flow as every other checkout;
 * the session is keyed on (pool, member) so replays return the same order.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = martApiGate()
  if (gate) return gate
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const rl = await enforce(limiters.checkout, `checkout:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const { id } = await params
  const admin = await createAdminClient()
  const { data: msme } = await admin.from('msme_profiles').select('id, deleted_at').eq('user_id', userId).maybeSingle()
  if (!msme) return NextResponse.json({ error: 'Complete your business profile first' }, { status: 403 })
  if (msme.deleted_at) return accountSuspendedResponse()
  const r = await prepareMemberCheckout(admin, { poolId: id, msmeId: msme.id })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  const c = r.checkout

  const { data: session } = await admin.from('checkout_sessions').select('id, razorpay_order_id, total_paise, order_id').eq('id', c.sessionId).maybeSingle()
  if (!session) return serverError('[pool/checkout] session missing', c.sessionId)
  if (session.order_id) return NextResponse.json({ error: 'already_paid', orderId: session.order_id }, { status: 409 })
  const gateway = getPaymentGateway()
  let razorpayOrderId = session.razorpay_order_id as string | null
  if (!razorpayOrderId) {
    try {
      const order = await gateway.createOrder({
        amountPaise: c.amounts.totalPaise,
        receipt: `cs_${session.id}`.slice(0, 40),
        notes: { checkout_session_id: session.id, source: 'catalog', msme_id: msme.id, kind: 'goods', pool_id: id },
        idempotencyKey: session.id,
      })
      razorpayOrderId = order.razorpayOrderId
      await admin.from('checkout_sessions').update({ razorpay_order_id: razorpayOrderId }).eq('id', session.id).is('razorpay_order_id', null)
    } catch (e) {
      return serverError('[pool/checkout] gateway order', e)
    }
  }
  return NextResponse.json({
    checkoutSessionId: session.id,
    razorpayOrderId,
    amountPaise: c.amounts.totalPaise,
    keyId: process.env['NEXT_PUBLIC_RAZORPAY_KEY_ID'] ?? '',
    simulated: !gateway.isReal,
    amounts: c.amounts,
    lineItems: c.lineItems,
    sellerName: c.sellerName,
    deliveryDays: c.deliveryDays,
    payBy: c.payBy,
  })
}
