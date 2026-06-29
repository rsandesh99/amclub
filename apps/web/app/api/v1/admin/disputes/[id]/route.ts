import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'

/** GET — full dispute detail: order, timeline, payment, payout, refund, messages. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const { id } = await params
  const admin = await createAdminClient()
  const { data: dispute } = await admin.from('disputes').select('*').eq('id', id).maybeSingle()
  if (!dispute) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: order } = await admin.from('orders').select('*').eq('id', dispute.order_id).maybeSingle()
  const [{ data: events }, { data: payment }, { data: payout }, { data: docs }] = await Promise.all([
    admin.from('order_events').select('id, event, payload, created_at').eq('order_id', dispute.order_id).order('created_at', { ascending: true }),
    admin.from('payments').select('id, status, amount_paise, razorpay_payment_id').eq('order_id', dispute.order_id).maybeSingle(),
    admin.from('payouts').select('id, status, amount_paise, paid_at').eq('order_id', dispute.order_id).maybeSingle(),
    admin.from('order_documents').select('id, file_name, kind, created_at').eq('order_id', dispute.order_id),
  ])
  const { data: refund } = payment
    ? await admin.from('refunds').select('id, status, amount_paise, created_at').eq('payment_id', payment.id).maybeSingle()
    : { data: null }

  return NextResponse.json({ dispute, order, events: events ?? [], payment, payout, refund, documents: docs ?? [] })
}
