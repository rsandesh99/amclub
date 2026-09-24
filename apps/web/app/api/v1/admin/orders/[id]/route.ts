import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { requireNotDelegated } from '@/lib/agent/scope'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { writeAudit } from '@/lib/audit/log'
import { getPaymentGateway } from '@/lib/payments'
import { runPayouts } from '@/lib/payments/payout'
import { finishRefund, processRefund } from '@/lib/orders/transitions'
import { serverError } from '@/lib/api/errors'
import { AGENT_ENABLED } from '@/lib/flags'
import { getLatestDossierForOrder } from '@/lib/agent/dossiers'
import { paymentForOrder, refundForOrder } from '@/lib/payments/order-payment'
import { moneyMovementBlock, PAYMENTS_UNAVAILABLE } from '@/lib/payments/simulation'
import { DISPUTE_SETTLEABLE_PAYOUT_STATUSES, planManualRefund, type PayoutStatus } from '@amclub/shared'

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
    // E12c — a bundle child shows its purchase's payment and its OWN refund row.
    paymentForOrder<{ id: string; status: string; amount_paise: number; razorpay_payment_id: string | null }>(admin, order, 'id, status, amount_paise, razorpay_payment_id').then((data) => ({ data })),
    admin.from('payouts').select('id, status, amount_paise, scheduled_for, paid_at').eq('order_id', id).maybeSingle(),
    admin.from('order_documents').select('id, file_name, kind, created_at').eq('order_id', id),
  ])
  const refund = payment ? await refundForOrder(admin, order, payment.id, 'id, status, amount_paise, created_at') : null

  // S1.4 — the latest payout dossier for the Dossier panel (agent surface: flag-gated, inert otherwise).
  const dossier = AGENT_ENABLED ? await getLatestDossierForOrder(admin, id).catch(() => null) : null
  return NextResponse.json({ order, events: events ?? [], payment, payout, refund, documents: docs ?? [], ...(AGENT_ENABLED ? { dossier } : {}) })
}

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retry_payout') }),
  z.object({
    action: z.literal('manual_refund'),
    amountPaise: z.number().int().positive(),
    reason: z.string().trim().max(1000).optional(),
    // ADR 027 (L1) — only for a payout already PAID: the founder confirms the platform bears
    // this refund (ADR-014 §2 interim path). Never relaxes an in-flight transfer or an earlier refund.
    platformAbsorbs: z.boolean().optional(),
  }),
  z.object({ action: z.literal('finish_refund') }),
])

/** POST — explicit ops actions: retry a FAILED payout, trigger a manual refund,
 *  or finish a cancellation refund that failed. All go through the proven
 *  payout/refund rails and are audit-logged. Money: no delegated agent token.
 *  ADR 027 (audit M2): all three refuse (503 payments_unavailable, 409
 *  payment_simulated) before writing anything when money cannot really move. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error
  const delegated = await requireNotDelegated('POST /admin/orders/[id]')
  if (delegated) return delegated

  const rl = await enforce(limiters.adminMutation, `admin:${gate.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const { id } = await params
  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const { data: order } = await admin.from('orders').select('*').eq('id', id).maybeSingle()
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // ADR 027 (audit M2) — no payout or refund through the simulation gateway on
  // production, and none against a simulated payment: refused before any write.
  const gateway = getPaymentGateway()
  const orderPayment = await paymentForOrder<{ id: string; razorpay_payment_id: string | null; simulated: unknown }>(admin, order, 'id, razorpay_payment_id, simulated:webhook_payload->simulated')
  const blocked = moneyMovementBlock(gateway.isReal, orderPayment)
  if (blocked) return NextResponse.json({ error: blocked }, { status: blocked === PAYMENTS_UNAVAILABLE ? 503 : 409 })

  let after: Record<string, unknown> = {}
  try {
    if (parsed.data.action === 'retry_payout') {
      // ADR 026 — retries FAILED payouts only. A held payout is released from
      // /admin/payouts, where its gates and dossier are shown; runPayouts
      // re-applies the release rule either way.
      const { data: payout } = await admin.from('payouts').select('id, status').eq('order_id', id).maybeSingle()
      if (!payout) return NextResponse.json({ error: 'no_payout' }, { status: 404 })
      if (payout.status === 'held') return NextResponse.json({ error: 'payout_held_use_release', payoutId: payout.id }, { status: 409 })
      if (payout.status !== 'failed') return NextResponse.json({ error: 'payout_not_failed', status: payout.status }, { status: 409 })
      const { data: moved } = await admin.from('payouts').update({ status: 'scheduled', updated_at: new Date().toISOString() }).eq('id', payout.id).eq('status', 'failed').select('id')
      if (!moved?.length) return NextResponse.json({ error: 'payout_changed' }, { status: 409 })
      const result = await runPayouts(admin, gateway, { orderId: id })
      const { data: afterRow } = await admin.from('payouts').select('status').eq('id', payout.id).maybeSingle()
      after = { retried: true, processed: result.processed, status: afterRow?.status ?? null }
    } else if (parsed.data.action === 'finish_refund') {
      // ADR 026 — complete a cancellation refund that failed (same engine as the sweeper).
      const r = await finishRefund(admin, order)
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 })
      after = { refundedPaise: r.refundedPaise, status: r.status }
    } else {
      // manual_refund — explicit amount via the proven refund engine. ADR-014:
      // one refund row per order, so an existing refund is a 409 (processRefund
      // would return the old row's amount and move nothing), and the amount the
      // engine reports is read back before anything is recorded.
      // ADR 027 (audit L1): planned by the same ADR-014 rules as a refunding
      // dispute resolution (shared planManualRefund), so a refund and a full
      // payout never both go out: a transfer in flight → 409 payout_in_flight; a
      // paid payout → 409 provider_already_paid unless the founder confirms the
      // platform absorbs it; otherwise the payout is cut to the provider's share
      // (or voided) and HELD in this same audited action, BEFORE the refund.
      const amountPaise = parsed.data.amountPaise
      const totalPaise = Number(order.total_paise)
      if (amountPaise > totalPaise) return NextResponse.json({ error: 'refund_over_total', totalPaise }, { status: 422 })
      const payment = orderPayment
      if (!payment) return NextResponse.json({ error: 'no_payment' }, { status: 409 })
      const existing = await refundForOrder<{ amount_paise: number }>(admin, order, payment.id, 'amount_paise')
      if (existing) return NextResponse.json({ error: 'refund_exists', existingPaise: Number(existing.amount_paise) }, { status: 409 })
      const { data: payout } = await admin.from('payouts').select('id, status, amount_paise').eq('order_id', id).maybeSingle()
      const plan = planManualRefund({
        totalPaise,
        earningPaise: Number(order.provider_earning_paise),
        amountPaise,
        payout: payout ? { status: payout.status as PayoutStatus, amountPaise: Number(payout.amount_paise) } : null,
        refund: null,
        platformAbsorbs: parsed.data.platformAbsorbs === true,
      })
      if (!plan.ok) {
        return NextResponse.json({ error: plan.conflict, existingPaise: plan.existingPaise, settlementPaise: plan.providerPaidPaise, refundPaise: plan.refundPaise }, { status: 409 })
      }

      // The payout leg first (as a dispute settlement does): only a row no money has left for is rewritten.
      let payoutAfter: Record<string, unknown> = { step: plan.payoutStep }
      if (payout && (plan.payoutStep === 'schedule' || plan.payoutStep === 'void')) {
        const nowIso = new Date().toISOString()
        // void = the ADR-014 representation (failed, amount 0). A cut payout is held; a failed one keeps
        // its status (failed → held is no edge) and moves only on an explicit retry, through the release rule.
        const fields =
          plan.payoutStep === 'void'
            ? { status: 'failed', amount_paise: 0, updated_at: nowIso }
            : { status: payout.status === 'failed' ? 'failed' : 'held', amount_paise: plan.providerPaidPaise, updated_at: nowIso }
        const { data: written } = await admin.from('payouts').update(fields).eq('id', payout.id).in('status', [...DISPUTE_SETTLEABLE_PAYOUT_STATUSES]).select('id')
        if (!written?.length) return NextResponse.json({ error: 'payout_changed' }, { status: 409 })
        await admin.from('order_events').insert(
          plan.payoutStep === 'void'
            ? { order_id: id, actor_id: gate.userId, event: 'payout_voided', payload: { payout_id: payout.id, reason: 'manual_refund_full' } }
            : { order_id: id, actor_id: gate.userId, event: 'payout_held', payload: { payout_id: payout.id, amount_paise: plan.providerPaidPaise, previous_amount_paise: Number(payout.amount_paise), reasons: ['manual_refund'] } },
        )
        payoutAfter = { step: plan.payoutStep, payoutId: payout.id, fromStatus: payout.status, fromPaise: Number(payout.amount_paise), toPaise: plan.payoutStep === 'void' ? 0 : plan.providerPaidPaise }
      }

      const refunded = await processRefund(admin, order, order.status, 'refund_partial', amountPaise)
      if (refunded !== amountPaise) {
        console.error('[admin/orders manual_refund] refund mismatch', { orderId: id, expected: amountPaise, refunded })
        return NextResponse.json({ error: 'refund_mismatch', existingPaise: refunded, refundPaise: amountPaise }, { status: 409 })
      }
      await admin.from('order_events').insert({
        order_id: id,
        actor_id: gate.userId,
        event: 'manual_refund',
        payload: { amount_paise: refunded, reason: parsed.data.reason ?? null, ...(plan.payoutStep === 'keep' && parsed.data.platformAbsorbs ? { platform_absorbs: true } : {}) },
      })
      after = { refundedPaise: refunded, payout: payoutAfter, ...(parsed.data.platformAbsorbs ? { platformAbsorbs: true } : {}) }
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
