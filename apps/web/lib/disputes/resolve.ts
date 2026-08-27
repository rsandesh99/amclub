import 'server-only'
import {
  isValidOrderTransition,
  type DisputeResolution,
  type OrderStatus,
} from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { getPaymentGateway } from '@/lib/payments'
import { processRefund } from '@/lib/orders/transitions'
import { runPayouts } from '@/lib/payments/payout'

type Admin = Awaited<ReturnType<typeof createAdminClient>>
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ResolveResult {
  ok: boolean
  status?: number
  error?: string
  /** True when the dispute was already resolved — no money moved (idempotent). */
  already?: boolean
  refundPaise?: number
  providerPaidPaise?: number
  orderStatus?: OrderStatus
}

const RESOLUTION_TO_STATUS: Record<DisputeResolution, OrderStatus> = {
  refund_full: 'resolved_refund',
  refund_partial: 'resolved_partial',
  release: 'resolved_release',
}

/**
 * Resolve a dispute (§5.4 / §9.2) by routing money through the EXISTING proven
 * rails — never a parallel path:
 *   • buyer refund   → processRefund() (gateway refund + refunds row, idempotent)
 *   • provider payout → payouts row + runPayouts() (gateway transfer)
 *
 * Settlement (paise-exact against order.total_paise / provider_earning_paise):
 *   • refund_full    → buyer refunded total; provider paid 0
 *   • release        → buyer refunded 0; provider paid full provider_earning_paise
 *   • refund_partial → buyer refunded `amountPaise`; provider paid the retained
 *                      share of their earning, i.e.
 *                      round(earning × (total − refund) / total). This smoothly
 *                      interpolates: refund=0 ⇒ full earning (release),
 *                      refund=total ⇒ 0 (refund_full).
 *
 * Idempotent: a dispute already 'resolved' is a no-op (no double refund/pay).
 * Releases the §9.2 payout hold as part of settlement.
 */
export async function resolveDispute(
  admin: Admin,
  disputeId: string,
  resolution: DisputeResolution,
  amountPaise: number | undefined,
  actorUserId: string,
): Promise<ResolveResult> {
  const { data: dispute } = await admin.from('disputes').select('*').eq('id', disputeId).maybeSingle()
  if (!dispute) return { ok: false, status: 404, error: 'Dispute not found' }

  // Idempotency: already resolved → return prior outcome, move no money.
  if (dispute.status === 'resolved') {
    return { ok: true, already: true, refundPaise: dispute.resolution_amount_paise ?? 0 }
  }

  const { data: order } = await admin.from('orders').select('*').eq('id', dispute.order_id).maybeSingle()
  if (!order) return { ok: false, status: 404, error: 'Order not found' }
  if (order.status !== 'disputed') {
    return { ok: false, status: 409, error: `Order is '${order.status}', not 'disputed'` }
  }

  const newStatus = RESOLUTION_TO_STATUS[resolution]
  if (!isValidOrderTransition('disputed', newStatus)) {
    return { ok: false, status: 409, error: `Illegal transition disputed → ${newStatus}` }
  }

  const total = Number(order.total_paise)
  const earning = Number(order.provider_earning_paise)

  // Buyer refund amount per resolution (clamped). processRefund recomputes the
  // same value via computeRefundPaise — we pass amountPaise for partial.
  const refundPaise =
    resolution === 'refund_full' ? total : resolution === 'release' ? 0 : Math.max(0, Math.min(amountPaise ?? 0, total))

  // Provider settlement.
  const providerPaidPaise =
    resolution === 'release'
      ? earning
      : resolution === 'refund_full'
        ? 0
        : Math.round((earning * (total - refundPaise)) / Math.max(1, total))

  // 1. Move the order out of 'disputed' first so re-entry is blocked (the
  //    idempotency guard above also covers a racing second call).
  await admin
    .from('orders')
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', order.id)
    .eq('status', 'disputed')

  // 2. Buyer refund via the proven engine (idempotent on the existing refunds row).
  if (refundPaise > 0) {
    await processRefund(admin, order, 'disputed', resolution, refundPaise)
  }

  // 3. Provider payout settlement.
  if (providerPaidPaise > 0) {
    // Release the §9.2 hold + set the exact amount, then pay via the proven cron
    // path (gateway transfer). Upsert covers disputes raised pre-completion
    // (no payout row yet) as well as held rows.
    await admin.from('payouts').upsert(
      {
        provider_id: order.provider_id,
        order_id: order.id,
        amount_paise: providerPaidPaise,
        status: 'scheduled',
        scheduled_for: new Date().toISOString().slice(0, 10),
      },
      { onConflict: 'order_id' },
    )
    await admin.from('order_events').insert({
      order_id: order.id,
      actor_id: actorUserId,
      event: 'payout_scheduled',
      payload: { amount_paise: providerPaidPaise, reason: 'dispute_resolution', resolution },
    })
    try {
      await runPayouts(admin, getPaymentGateway(), { orderId: order.id })
    } catch (e) {
      console.error('[resolveDispute] payout', e)
    }
  } else {
    // refund_full: provider owed nothing. Neutralise any held payout so it is
    // never picked up (cron only processes 'scheduled').
    const { data: voided } = await admin
      .from('payouts')
      .update({ status: 'failed', amount_paise: 0, updated_at: new Date().toISOString() })
      .eq('order_id', order.id)
      .select('id')
    if (voided && voided.length > 0) {
      await admin.from('order_events').insert({
        order_id: order.id,
        actor_id: actorUserId,
        event: 'payout_voided',
        payload: { payout_id: voided[0]!.id, reason: 'refund_full' },
      })
    }
  }

  // 4. Mark the dispute resolved (records the buyer refund as the resolution amount).
  await admin
    .from('disputes')
    .update({
      status: 'resolved',
      resolution,
      resolution_amount_paise: refundPaise,
      resolved_by: actorUserId,
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', disputeId)

  // 5. Order event timeline.
  await admin.from('order_events').insert({
    order_id: order.id,
    actor_id: actorUserId,
    event: newStatus,
    payload: { resolution, refund_paise: refundPaise, provider_paid_paise: providerPaidPaise },
  })

  return { ok: true, refundPaise, providerPaidPaise, orderStatus: newStatus }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
