import 'server-only'
import {
  DISPUTE_SETTLEABLE_PAYOUT_STATUSES,
  isValidOrderTransition,
  planDisputeSettlement,
  type DisputeResolution,
  type DisputeSettlementConflict,
  type OrderStatus,
  type PayoutStatus,
} from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { getPaymentGateway } from '@/lib/payments'
import { processRefund } from '@/lib/orders/transitions'
import { runPayouts } from '@/lib/payments/payout'

type Admin = Awaited<ReturnType<typeof createAdminClient>>
/* eslint-disable @typescript-eslint/no-explicit-any */

/** 409 codes the console translates (admin_ops.money_err_<code>, components/admin/useMoneyError). */
export type ResolveErrorCode =
  | DisputeSettlementConflict
  | 'refund_mismatch'
  | 'no_payment'
  | 'resolution_in_progress'
  | 'resolution_conflict'

export interface ResolveResult {
  ok: boolean
  status?: number
  error?: string
  /** Amounts behind a 409, in paise, for the console message. */
  details?: { existingPaise?: number; settlementPaise?: number; refundPaise?: number; startedResolution?: string }
  /** True when the dispute was already resolved — no money moved (idempotent). */
  already?: boolean
  /** True when this call finished an attempt that had stopped part-way. */
  resumed?: boolean
  refundPaise?: number
  providerPaidPaise?: number
  orderStatus?: OrderStatus
}

const RESOLUTION_TO_STATUS: Record<DisputeResolution, OrderStatus> = {
  refund_full: 'resolved_refund',
  refund_partial: 'resolved_partial',
  release: 'resolved_release',
}

/** An attempt that claimed the order longer ago than this has stopped (well past
 *  any function timeout); a later call may finish it. Younger = still running. */
const RESUME_AFTER_MS = 10 * 60 * 1000

const conflict = (error: ResolveErrorCode, details: NonNullable<ResolveResult['details']>): ResolveResult => ({ ok: false, status: 409, error, details })

/**
 * Resolve a dispute (§5.4 / §9.2) by routing money through the EXISTING proven
 * rails — never a parallel path:
 *   • buyer refund   → processRefund() (gateway refund + refunds row, idempotent)
 *   • provider payout → payouts row + runPayouts() (gateway transfer)
 *
 * Settlement amounts: shared `disputeSettlementPaise` (the Phase 7 formula).
 * What may happen to the payout and refund rows: shared `planDisputeSettlement`
 * (ADR-014) — decided BEFORE anything is written:
 *   • a payout that is already paid is never re-sent or rewritten; if the
 *     resolution would settle the provider at a different amount → 409
 *     `provider_already_paid` (no clawback path exists);
 *   • a transfer in flight → 409 `payout_in_flight`;
 *   • an earlier refund on the order (one refund row per order) → 409
 *     `refund_exists` instead of a silent no-op.
 *
 * Concurrency: the order's `disputed → resolved_*` update is the claim — exactly
 * one caller wins it. A call that finds the order already in THIS resolution's
 * status with the dispute still open finishes that attempt, but only once the
 * claim is older than RESUME_AFTER_MS, and only after winning a compare-and-set
 * on `orders.updated_at` (so two resumers cannot both move money).
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

  const newStatus = RESOLUTION_TO_STATUS[resolution]
  if (!isValidOrderTransition('disputed', newStatus)) {
    return { ok: false, status: 409, error: `Illegal transition disputed → ${newStatus}` }
  }

  // An interrupted attempt of this same resolution may be finished; any other
  // non-disputed order status is the existing refusal.
  let resuming = false
  if (order.status !== 'disputed') {
    if (order.status !== newStatus) {
      return { ok: false, status: 409, error: `Order is '${order.status}', not 'disputed'` }
    }
    if (dispute.resolution && dispute.resolution !== resolution) {
      return conflict('resolution_conflict', { startedResolution: dispute.resolution })
    }
    const claimedAt = Date.parse(order.updated_at ?? '')
    if (!Number.isFinite(claimedAt) || Date.now() - claimedAt < RESUME_AFTER_MS) {
      return conflict('resolution_in_progress', {})
    }
    resuming = true
  }

  // A resumed partial settles the amount the first attempt recorded, never a new one.
  const recordedPaise = resuming && dispute.resolution_amount_paise != null ? Number(dispute.resolution_amount_paise) : null
  if (resolution === 'refund_partial' && recordedPaise != null && amountPaise !== recordedPaise) {
    return conflict('resolution_conflict', { startedResolution: resolution, refundPaise: recordedPaise })
  }

  // Read what already happened to the payout and refund rows, then plan.
  const [{ data: payout }, { data: payment }] = await Promise.all([
    admin.from('payouts').select('id, status, amount_paise').eq('order_id', order.id).maybeSingle(),
    admin.from('payments').select('id').eq('order_id', order.id).maybeSingle(),
  ])
  const { data: refundRow } = payment
    ? await admin.from('refunds').select('id, status, amount_paise').eq('payment_id', payment.id).maybeSingle()
    : { data: null }

  const plan = planDisputeSettlement({
    totalPaise: Number(order.total_paise),
    earningPaise: Number(order.provider_earning_paise),
    resolution,
    amountPaise,
    payout: payout ? { status: payout.status as PayoutStatus, amountPaise: Number(payout.amount_paise) } : null,
    refund: refundRow ? { amountPaise: Number(refundRow.amount_paise) } : null,
    resuming,
  })
  if (!plan.ok) {
    return conflict(plan.conflict, { existingPaise: plan.existingPaise, settlementPaise: plan.providerPaidPaise, refundPaise: plan.refundPaise })
  }
  const { refundPaise, providerPaidPaise } = plan
  // A refund needs the captured payment; refuse before anything is written.
  if (plan.refund && !payment) return conflict('no_payment', { refundPaise })
  const nowIso = new Date().toISOString()

  // 1. Claim. Fresh: move the order out of 'disputed' — exactly one caller wins.
  //    Resume: compare-and-set on updated_at — exactly one resumer wins.
  const claim = resuming
    ? admin.from('orders').update({ updated_at: nowIso }).eq('id', order.id).eq('status', newStatus).eq('updated_at', order.updated_at)
    : admin.from('orders').update({ status: newStatus, updated_at: nowIso }).eq('id', order.id).eq('status', 'disputed')
  const { data: claimed } = await claim.select('id')
  if (!claimed || claimed.length === 0) return conflict('resolution_in_progress', {})

  // Record the intended settlement on the still-open dispute, so an interrupted
  // attempt can only ever be finished with the same resolution and amount.
  await admin
    .from('disputes')
    .update({ resolution, resolution_amount_paise: refundPaise, updated_at: nowIso })
    .eq('id', disputeId)
    .eq('status', 'open')

  // 2. Provider payout settlement — BEFORE the buyer refund. Razorpay Route
  //    refuses a payment-linked transfer once a refund has been initiated on
  //    that payment (F1), so on a split resolution the provider leg must go
  //    first. Only rows no money has left for are ever rewritten (ADR-014).
  if (plan.payoutStep === 'schedule') {
    const fields = { amount_paise: providerPaidPaise, status: 'scheduled', scheduled_for: nowIso.slice(0, 10), updated_at: nowIso }
    const { data: written, error: writeErr } = payout
      ? await admin.from('payouts').update(fields).eq('id', payout.id).in('status', [...DISPUTE_SETTLEABLE_PAYOUT_STATUSES]).select('id')
      : await admin.from('payouts').insert({ provider_id: order.provider_id, order_id: order.id, ...fields }).select('id')
    if (writeErr || !written || written.length === 0) {
      // The row changed under us (a release click or a transfer started). Money
      // has not moved; the dispute stays open and a later call resumes it.
      return conflict('payout_in_flight', { settlementPaise: providerPaidPaise })
    }
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
  } else if (plan.payoutStep === 'void') {
    // refund_full: provider owed nothing. Neutralise a payout no money has left
    // for so the cron never picks it up (cron only processes 'scheduled').
    const { data: voided } = await admin
      .from('payouts')
      .update({ status: 'failed', amount_paise: 0, updated_at: nowIso })
      .eq('order_id', order.id)
      .in('status', [...DISPUTE_SETTLEABLE_PAYOUT_STATUSES])
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
  // 'keep' (already paid exactly the settlement) and 'none' move nothing.

  // 3. Buyer refund via the proven engine (insert-first, key-guarded, idempotent).
  //    Runs even if the transfer leg failed above: the buyer's refund never
  //    waits on provider readiness; a later provider retry is visible as a
  //    failed payout in /admin/payouts. The amount it reports is read back: a
  //    refund row that is not this resolution's leaves the dispute open (H4).
  if (plan.refund) {
    const refunded = await processRefund(admin, order, 'disputed', resolution, refundPaise)
    if (refunded !== refundPaise) {
      console.error('[resolveDispute] refund mismatch', { orderId: order.id, expected: refundPaise, refunded })
      return conflict('refund_mismatch', { existingPaise: refunded, refundPaise })
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
    payload: { resolution, refund_paise: refundPaise, provider_paid_paise: providerPaidPaise, ...(resuming ? { resumed: true } : {}) },
  })
  // AMC Mart: a goods dispute is a return (opened via 'return_opened'); close
  // it in the goods vocabulary too so the release gate sees return_resolved.
  if (order.kind === 'goods') {
    await admin.from('order_events').insert({
      order_id: order.id,
      actor_id: actorUserId,
      event: 'return_resolved',
      payload: { resolution, refund_paise: refundPaise, dispute_id: disputeId },
    })
  }

  return { ok: true, refundPaise, providerPaidPaise, orderStatus: newStatus, ...(resuming ? { resumed: true } : {}) }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
