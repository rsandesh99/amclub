import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { writeAudit } from '@/lib/audit/log'
import { getPaymentGateway } from '@/lib/payments'
import { runPayouts } from '@/lib/payments/payout'
import { processRefund } from '@/lib/orders/transitions'
import { serverError } from '@/lib/api/errors'

/** GET — full order detail: timeline, payment, payout, refund, documents. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const { id } = await params
  const admin = await createAdminClient()
  const { data: order } = await admin.from('orders').select('*').eq('id', id).maybeSingle()
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [{ data: events }, { data: payment }, { data: payout }, { data: docs }] = await Promise.all([
    admin.from('order_events').select('id, event, payload, created_at').eq('order_id', id).order('created_at', { ascending: true }),
    admin.from('payments').select('id, status, amount_paise, razorpay_payment_id').eq('order_id', id).maybeSingle(),
    admin.from('payouts').select('id, status, amount_paise, scheduled_for, paid_at').eq('order_id', id).maybeSingle(),
    admin.from('order_documents').select('id, file_name, kind, created_at').eq('order_id', id),
  ])
  const { data: refund } = payment
    ? await admin.from('refunds').select('id, status, amount_paise, created_at').eq('payment_id', payment.id).maybeSingle()
    : { data: null }

  return NextResponse.json({ order, events: events ?? [], payment, payout, refund, documents: docs ?? [] })
}

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retry_payout') }),
  z.object({ action: z.literal('manual_refund'), amountPaise: z.number().int().positive(), reason: z.string().trim().max(1000).optional() }),
])

/** POST — explicit ops actions: retry a stuck payout, or trigger a manual refund.
 *  Both go through the proven payout/refund rails and are audit-logged. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const rl = await enforce(limiters.adminMutation, `admin:${gate.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const { id } = await params
  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const { data: order } = await admin.from('orders').select('*').eq('id', id).maybeSingle()
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let after: Record<string, unknown> = {}
  try {
    if (parsed.data.action === 'retry_payout') {
      // Reschedule a failed/held payout, then run the proven transfer path once.
      await admin.from('payouts').update({ status: 'scheduled', updated_at: new Date().toISOString() }).eq('order_id', id).in('status', ['failed', 'held'])
      const result = await runPayouts(admin, getPaymentGateway(), { orderId: id })
      after = { retried: true, processed: result.processed }
    } else {
      // manual_refund — explicit amount via the proven refund engine (idempotent
      // on the existing refunds row).
      const refunded = await processRefund(admin, order, order.status, 'refund_partial', parsed.data.amountPaise)
      await admin.from('order_events').insert({ order_id: id, actor_id: gate.userId, event: 'manual_refund', payload: { amount_paise: refunded, reason: parsed.data.reason ?? null } })
      after = { refundedPaise: refunded }
    }
  } catch (e) {
    return serverError('[admin/orders action]', e)
  }

  await writeAudit(admin, request, {
    actorId: gate.userId,
    action: `order_${parsed.data.action}`,
    entity: 'orders',
    entityId: id,
    before: { status: order.status },
    after,
  })

  return NextResponse.json({ ok: true, ...after })
}
