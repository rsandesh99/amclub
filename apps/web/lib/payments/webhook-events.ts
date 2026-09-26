import 'server-only'
import { CAPTURE_EXCEPTION_STATUS, REFUND_STATUS } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { stableEntityId, writeAudit } from '@/lib/audit/log'
import { deadTransferIds, markPaid } from './payout'
import { notifyRefund } from '@/lib/notifications/events'
import { CHARGEBACK_EVENTS, type ChargebackEvent } from './release-gate'

export { CHARGEBACK_EVENTS, type ChargebackEvent }

type Admin = Awaited<ReturnType<typeof createAdminClient>>
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * ADR 027 (audit M20) — the Razorpay webhook is the payment truth for refunds,
 * transfers and chargebacks too, not only captures. Every handler here is:
 *  • idempotent — each write is compare-and-set on the status it expects, and
 *    each event it records is written once (a marker keyed on the gateway id),
 *    so a replayed or out-of-order webhook changes nothing twice;
 *  • narrow — it only moves a row in the direction the gateway reports and never
 *    moves money itself (no refund, no transfer is created here);
 *  • quiet about unknown ids (200, logged): a refund or transfer made on the
 *    Razorpay dashboard is not ours to settle.
 * The route keeps HMAC verification over the raw body exactly as before.
 */

export type WebhookResult = { ok: true; handled: string; changed: boolean; note?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

async function eventOnce(admin: Admin, orderId: string, event: string, key: string, keyValue: string, payload: Record<string, unknown>): Promise<boolean> {
  const { data: prior } = await admin.from('order_events').select('id').eq('order_id', orderId).eq('event', event).eq(`payload->>${key}`, keyValue).limit(1)
  if ((prior ?? []).length > 0) return false
  await admin.from('order_events').insert({ order_id: orderId, actor_id: null, event, payload: { [key]: keyValue, ...payload } })
  return true
}

/** The order a refund row belongs to: a bundle child's row is keyed rfnd_<order id>; otherwise the payment's order. */
async function orderIdForRefund(admin: Admin, refund: { payment_id: string; idempotency_key?: string | null }): Promise<string | null> {
  const fromKey = refund.idempotency_key?.startsWith('rfnd_') ? refund.idempotency_key.slice(5) : null
  if (fromKey && UUID.test(fromKey)) return fromKey
  const { data: pay } = await admin.from('payments').select('order_id').eq('id', refund.payment_id).maybeSingle()
  return (pay as { order_id?: string } | null)?.order_id ?? null
}

// ── refund.processed / refund.failed ─────────────────────────────────────────

export async function handleRefundEvent(admin: Admin, event: 'refund.processed' | 'refund.failed', entity: Record<string, unknown>): Promise<WebhookResult> {
  const refundId = str(entity['id'])
  const receipt = str(entity['receipt'])
  const amountPaise = Number(entity['amount'] ?? 0)
  if (!refundId) return { ok: true, handled: event, changed: false, note: 'no_refund_id' }
  const failed = event === 'refund.failed'

  // (a) An order's refund row — by gateway id, else by our receipt (a crash between the gateway call and our update).
  let { data: row } = await admin.from('refunds').select('id, payment_id, status, amount_paise, idempotency_key, razorpay_refund_id').eq('razorpay_refund_id', refundId).maybeSingle()
  if (!row && receipt) {
    ;({ data: row } = await admin.from('refunds').select('id, payment_id, status, amount_paise, idempotency_key, razorpay_refund_id').eq('idempotency_key', receipt).maybeSingle())
  }
  if (row) {
    const r = row as { id: string; payment_id: string; status: string; amount_paise: number; idempotency_key: string | null; razorpay_refund_id: string | null }
    // A different refund than the one this row records (e.g. an older, failed attempt): not this row's truth.
    if (r.razorpay_refund_id && r.razorpay_refund_id !== refundId) return { ok: true, handled: event, changed: false, note: 'other_refund' }
    const orderId = await orderIdForRefund(admin, r)
    if (!failed) {
      // pending → processed (healing a crash). A processed row is already right; a failed one stays for ops.
      const { data: moved } = await admin
        .from('refunds')
        .update({ status: REFUND_STATUS.processed, razorpay_refund_id: refundId, updated_at: new Date().toISOString() })
        .eq('id', r.id)
        .eq('status', REFUND_STATUS.pending)
        .select('id')
      if (moved?.length && orderId) {
        await eventOnce(admin, orderId, 'refund_confirmed', 'razorpay_refund_id', refundId, { amount_paise: Number(r.amount_paise), source: 'gateway' })
        // ADR-030 §4 — the buyer hears it (once per order; a settlement that already announced it stays quiet).
        try { await notifyRefund(admin, orderId, 'processed', Number(r.amount_paise)) } catch (e) { console.error('[webhook] notify refund', e) }
      }
      return { ok: true, handled: event, changed: Boolean(moved?.length) }
    }
    // failed: the buyer did not get it. pending | processed → failed, an ops marker once, never an automatic re-send.
    const { data: moved } = await admin
      .from('refunds')
      .update({ status: REFUND_STATUS.failed, razorpay_refund_id: refundId, updated_at: new Date().toISOString() })
      .eq('id', r.id)
      .in('status', [REFUND_STATUS.pending, REFUND_STATUS.processed])
      .select('id')
    if (moved?.length) {
      const detail = { amount_paise: Number(r.amount_paise), gateway_amount_paise: amountPaise, reason: 'gateway_refund_failed', source: 'gateway' }
      if (orderId) await eventOnce(admin, orderId, 'refund_failed', 'razorpay_refund_id', refundId, detail)
      await writeAudit(admin, null, { actorId: null, action: 'refund_failed_at_gateway', entity: 'refunds', entityId: r.id, after: { razorpay_refund_id: refundId, order_id: orderId, ...detail } })
      console.error('[webhook] refund.failed — ops must re-send', { refundId, orderId })
      // ADR-030 §4 — the buyer hears the refund is delayed and being re-sent (once per order).
      if (orderId) try { await notifyRefund(admin, orderId, 'failed', Number(r.amount_paise)) } catch (e) { console.error('[webhook] notify refund', e) }
    }
    return { ok: true, handled: event, changed: Boolean(moved?.length) }
  }

  // (b) A capture exception's refund (no order): by gateway id, else by its receipt.
  let { data: exc } = await admin.from('capture_exceptions').select('id, status, razorpay_refund_id').eq('razorpay_refund_id', refundId).maybeSingle()
  if (!exc && receipt) ({ data: exc } = await admin.from('capture_exceptions').select('id, status, razorpay_refund_id').eq('refund_key', receipt).maybeSingle())
  if (exc) {
    const x = exc as { id: string; status: string; razorpay_refund_id: string | null }
    if (x.razorpay_refund_id && x.razorpay_refund_id !== refundId) return { ok: true, handled: event, changed: false, note: 'other_refund' }
    const nowIso = new Date().toISOString()
    const { data: moved } = failed
      ? await admin
          .from('capture_exceptions')
          .update({ status: CAPTURE_EXCEPTION_STATUS.refund_failed, razorpay_refund_id: null, last_error: 'gateway_refund_failed', updated_at: nowIso })
          .eq('id', x.id)
          .in('status', [CAPTURE_EXCEPTION_STATUS.refunding, CAPTURE_EXCEPTION_STATUS.refunded])
          .select('id')
      : await admin
          .from('capture_exceptions')
          .update({ status: CAPTURE_EXCEPTION_STATUS.refunded, razorpay_refund_id: refundId, refunded_at: nowIso, last_error: null, updated_at: nowIso })
          .in('status', [CAPTURE_EXCEPTION_STATUS.refund_pending, CAPTURE_EXCEPTION_STATUS.refunding, CAPTURE_EXCEPTION_STATUS.refund_failed])
          .eq('id', x.id)
          .select('id')
    if (failed && moved?.length) await writeAudit(admin, null, { actorId: null, action: 'capture_exception_refund_failed', entity: 'capture_exceptions', entityId: x.id, after: { razorpay_refund_id: refundId, source: 'gateway' } })
    return { ok: true, handled: event, changed: Boolean(moved?.length) }
  }
  console.warn('[webhook] refund event for an unknown refund', event, refundId)
  return { ok: true, handled: event, changed: false, note: 'unknown_refund' }
}

// ── transfer.processed / transfer.failed / transfer.reversed ─────────────────

export async function handleTransferEvent(
  admin: Admin,
  event: 'transfer.processed' | 'transfer.failed' | 'transfer.reversed',
  entity: Record<string, unknown>,
): Promise<WebhookResult> {
  const transferId = str(entity['id'])
  if (!transferId) return { ok: true, handled: event, changed: false, note: 'no_transfer_id' }
  const notes = (entity['notes'] ?? {}) as Record<string, unknown>
  const notedPayout = str(notes['payout_id'])

  let { data: payout } = await admin.from('payouts').select('*').eq('razorpay_transfer_id', transferId).maybeSingle()
  if (!payout && notedPayout && UUID.test(notedPayout)) ({ data: payout } = await admin.from('payouts').select('*').eq('id', notedPayout).maybeSingle())
  if (!payout) {
    console.warn('[webhook] transfer event for an unknown payout', event, transferId)
    return { ok: true, handled: event, changed: false, note: 'unknown_payout' }
  }
  const p = payout as any
  // A transfer the gateway already reported dead never settles or re-fails the payout (replay / out of order).
  const dead = await deadTransferIds(admin, p)
  if (dead.includes(transferId)) return { ok: true, handled: event, changed: false, note: 'dead_transfer' }
  // Another transfer than the one this payout records: an older attempt, not this payout's truth.
  if (p.razorpay_transfer_id && p.razorpay_transfer_id !== transferId) return { ok: true, handled: event, changed: false, note: 'other_transfer' }

  const amountPaise = Number(entity['amount'] ?? p.amount_paise)
  if (event === 'transfer.processed') {
    // processing (an unconfirmed transfer, ADR 026) → paid with this transfer. Paid already → nothing.
    if (p.status !== 'processing') return { ok: true, handled: event, changed: false }
    const changed = await markPaid(admin, p, { razorpayTransferId: transferId, amountPaise, status: 'processed', simulated: false }, true, { source: 'gateway' })
    return { ok: true, handled: event, changed }
  }

  // A partial reversal leaves part of the money with the provider: record it for ops, never re-open the payout.
  const reversedPaise = Number(entity['amount_reversed'] ?? 0)
  if (event === 'transfer.reversed' && reversedPaise > 0 && reversedPaise < amountPaise) {
    const first = await eventOnce(admin, p.order_id, 'payout_partially_reversed', 'razorpay_transfer_id', transferId, { payout_id: p.id, amount_paise: amountPaise, reversed_paise: reversedPaise, source: 'gateway' })
    if (first) await writeAudit(admin, null, { actorId: null, action: 'payout_partially_reversed', entity: 'payouts', entityId: p.id, after: { razorpay_transfer_id: transferId, reversed_paise: reversedPaise } })
    return { ok: true, handled: event, changed: first }
  }

  // failed / fully reversed: the money is back with the platform. processing | paid → failed, once.
  // The dead transfer id moves to the event (deadTransferIds); the row forgets it, so a retry's
  // new transfer is this payout's truth from then on.
  const { data: moved } = await admin
    .from('payouts')
    .update({ status: 'failed', razorpay_transfer_id: null, paid_at: null, updated_at: new Date().toISOString() })
    .eq('id', p.id)
    .in('status', ['processing', 'paid'])
    .select('id')
  if (!moved?.length) return { ok: true, handled: event, changed: false }
  const reason = event === 'transfer.failed' ? 'transfer_failed' : 'transfer_reversed'
  await admin.from('order_events').insert({
    order_id: p.order_id,
    actor_id: null,
    event: 'payout_failed',
    payload: { payout_id: p.id, amount_paise: Number(p.amount_paise), razorpay_transfer_id: transferId, reason, source: 'gateway', from_status: p.status },
  })
  await writeAudit(admin, null, { actorId: null, action: `payout_${reason}`, entity: 'payouts', entityId: p.id, after: { razorpay_transfer_id: transferId, from_status: p.status, order_id: p.order_id } })
  console.error('[webhook] payout transfer came back — ops decides the retry', { payoutId: p.id, transferId, reason })
  return { ok: true, handled: event, changed: true }
}

// ── payment.dispute.* (chargebacks) ───────────────────────────────────────────

export async function handleChargebackEvent(admin: Admin, event: ChargebackEvent, dispute: Record<string, unknown>): Promise<WebhookResult> {
  const disputeId = str(dispute['id'])
  const paymentId = str(dispute['payment_id'])
  if (!disputeId || !paymentId) return { ok: true, handled: event, changed: false, note: 'no_dispute' }
  const marker = CHARGEBACK_EVENTS[event]
  const { data: pay } = await admin.from('payments').select('id, order_id').eq('razorpay_payment_id', paymentId).maybeSingle()
  if (!pay) {
    // A chargeback on a capture with no order (a capture exception) or an unknown payment: ops only.
    await writeAudit(admin, null, { actorId: null, action: `${marker}_no_order`, entity: 'payments', entityId: stableEntityId('razorpay_dispute', `${disputeId}:${marker}`), after: { razorpay_dispute_id: disputeId, razorpay_payment_id: paymentId } })
    return { ok: true, handled: event, changed: false, note: 'no_order' }
  }
  const carrierId = (pay as { order_id: string }).order_id
  // A bundle's ONE payment carries several child orders (ADR 021): the chargeback touches all of them.
  const { data: carrier } = await admin.from('orders').select('*').eq('id', carrierId).maybeSingle()
  const bundle = (carrier as { bundle_purchase_id?: string | null } | null)?.bundle_purchase_id
  const orderIds = bundle ? (((await admin.from('orders').select('id').eq('bundle_purchase_id', bundle)).data ?? []) as { id: string }[]).map((o) => o.id) : [carrierId]

  const detail = {
    razorpay_payment_id: paymentId,
    amount_paise: Number(dispute['amount'] ?? 0),
    reason_code: str(dispute['reason_code']),
    phase: str(dispute['phase']),
    source: 'gateway',
  }
  let changed = false
  for (const orderId of orderIds) {
    const first = await eventOnce(admin, orderId, marker, 'razorpay_dispute_id', disputeId, detail)
    if (!first) continue
    changed = true
    // Opened or lost: hold what has not left (scheduled → held). A failed or held payout
    // cannot move while the chargeback is open (payoutRunBlockers); a transfer in flight
    // or a paid payout is left to ops (audited below).
    let held: { id: string; amount_paise: number }[] | null = null
    if (marker === 'chargeback_opened' || marker === 'chargeback_lost') {
      ;({ data: held } = await admin
        .from('payouts')
        .update({ status: 'held', updated_at: new Date().toISOString() })
        .eq('order_id', orderId)
        .eq('status', 'scheduled')
        .select('id, amount_paise'))
    }
    const { data: payout } = await admin.from('payouts').select('id, status').eq('order_id', orderId).maybeSingle()
    if (held?.length) {
      await admin.from('order_events').insert({ order_id: orderId, actor_id: null, event: 'payout_held', payload: { payout_id: held[0]!.id, amount_paise: held[0]!.amount_paise, reasons: ['chargeback'] } })
    }
    await writeAudit(admin, null, {
      actorId: null,
      action: marker,
      entity: 'orders',
      entityId: orderId,
      after: { razorpay_dispute_id: disputeId, ...detail, payout_status: (payout as { status?: string } | null)?.status ?? null },
    })
  }
  if (changed) console.error('[webhook] chargeback — ops must respond', { event, disputeId, orderIds })
  return { ok: true, handled: event, changed }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
