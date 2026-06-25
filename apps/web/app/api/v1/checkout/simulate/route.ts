import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { getPaymentGateway } from '@/lib/payments'
import { materializeFromCapture } from '@/lib/payments/materialize'

const bodySchema = z.object({ checkoutSessionId: z.string().uuid() })

/**
 * SIMULATION ONLY. When real Razorpay keys are absent, this stands in for the
 * captured-payment webhook so Buy Now completes end-to-end in test/dev. It calls
 * the SAME idempotent materialize path the webhook uses. Refuses once a real
 * gateway is configured — production uses the actual Razorpay webhook.
 */
export async function POST(request: NextRequest) {
  const gateway = getPaymentGateway()
  if (gateway.isReal) {
    return NextResponse.json({ error: 'Simulation disabled — real Razorpay webhook is in use.' }, { status: 400 })
  }

  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 422 })

  const admin = await createAdminClient()
  const { data: session } = await admin
    .from('checkout_sessions')
    .select('id, razorpay_order_id, total_paise, order_id, msme_id')
    .eq('id', parsed.data.checkoutSessionId)
    .maybeSingle()
  if (!session?.razorpay_order_id) {
    return NextResponse.json({ error: 'Checkout session not found' }, { status: 404 })
  }
  if (session.order_id) {
    return NextResponse.json({ orderId: session.order_id, alreadyPaid: true })
  }

  const { orderId, error } = await materializeFromCapture(admin, {
    razorpayOrderId: session.razorpay_order_id,
    razorpayPaymentId: `pay_sim_${session.id}`,
    amountPaise: session.total_paise,
    method: 'upi',
    payload: { simulated: true },
  })
  if (error || !orderId) {
    return NextResponse.json({ error: error ?? 'Materialization failed' }, { status: 500 })
  }
  return NextResponse.json({ orderId, simulated: true })
}
