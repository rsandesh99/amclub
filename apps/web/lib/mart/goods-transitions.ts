/**
 * AMC Mart — goods order actions (MART_DESIGN.md §4.3) on the ONE order spine.
 *
 * Goods orders skip quotes and requirements: the delivery snapshot captured at
 * checkout IS the requirement. Every action below maps onto the canonical
 * §3.7 transitions exactly as they exist (never repurposed — RULES.md rule 11):
 *
 *   accept          placed → accepted                                   (seller)
 *   dispatch        accepted → requirements_submitted → in_progress     (seller; two legal
 *                   steps, both emitted; carries e-way-bill + inbound-invoice fields)
 *   deliver         in_progress → delivered (+72h auto-accept timer)    (seller; delivery photo)
 *   accept_delivery delivered → completed                               (buyer; 'buyer_received')
 *   open_return     delivered | completed → disputed                    (buyer; 'return_opened';
 *                   resolved through the existing dispute console → 'return_resolved')
 *   cancel          placed | accepted → cancelled_by_buyer (+refund)     (buyer)
 *
 * Money: schedulePayout / processRefund / generateInvoices are the services
 * functions — no goods money path exists (§0). The goods release gate lives
 * in lib/mart/release.ts and is enforced at payout release.
 */
import 'server-only'
import {
  isValidOrderTransition,
  goodsDispatchSchema,
  goodsDeliverSchema,
  goodsReturnSchema,
  type OrderStatus,
  type GoodsOrderAction,
} from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { schedulePayout, processRefund, type Actor, type TransitionResult } from '@/lib/orders/transitions'
import { generateInvoices } from '@/lib/invoices/generate'
import { notifyOrderTransition } from '@/lib/notifications/events'
import { getEwayBillThresholdPaise } from './config'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

interface Rule {
  from: OrderStatus[]
  to: OrderStatus
  actor: 'msme' | 'provider'
}

const RULES: Record<GoodsOrderAction, Rule> = {
  accept: { from: ['placed'], to: 'accepted', actor: 'provider' },
  // dispatch passes THROUGH requirements_submitted (auto) to in_progress.
  dispatch: { from: ['accepted'], to: 'in_progress', actor: 'provider' },
  deliver: { from: ['in_progress'], to: 'delivered', actor: 'provider' },
  accept_delivery: { from: ['delivered'], to: 'completed', actor: 'msme' },
  open_return: { from: ['delivered', 'completed'], to: 'disputed', actor: 'msme' },
  cancel: { from: ['placed', 'accepted'], to: 'cancelled_by_buyer', actor: 'msme' },
}

/** Notification copy reuse — goods actions borrow the nearest services copy (M0). */
const NOTIFY_AS: Record<GoodsOrderAction, string> = {
  accept: 'accept',
  dispatch: 'start',
  deliver: 'deliver',
  accept_delivery: 'accept_delivery',
  open_return: 'raise_dispute',
  cancel: 'cancel',
}

export interface GoodsActionExtra {
  dispatch?: unknown
  deliver?: unknown
  return?: unknown
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function addEvent(admin: Admin, orderId: string, event: string, actorId: string | null, payload?: unknown) {
  await admin.from('order_events').insert({ order_id: orderId, actor_id: actorId, event, payload: payload ?? null })
}

/** A document id must belong to THIS order and carry the expected kind. */
async function docOnOrder(admin: Admin, orderId: string, docId: string, kinds: string[]): Promise<boolean> {
  const { data } = await admin.from('order_documents').select('id, kind').eq('id', docId).eq('order_id', orderId).maybeSingle()
  return !!data && kinds.includes(data.kind as string)
}

export async function applyGoodsTransition(
  admin: Admin,
  orderId: string,
  action: GoodsOrderAction,
  actor: Actor,
  extra: GoodsActionExtra = {},
): Promise<TransitionResult> {
  const { data: order } = await admin.from('orders').select('*').eq('id', orderId).maybeSingle()
  if (!order) return { ok: false, status: 404, error: 'Order not found' }
  if (order.kind !== 'goods') return { ok: false, status: 409, error: 'Not a goods order' }

  const isMsme = actor.msmeId != null && order.msme_id === actor.msmeId
  const isProvider = actor.providerId != null && order.provider_id === actor.providerId
  if (!isMsme && !isProvider) return { ok: false, status: 403, error: 'Not a party to this order' }

  const rule = RULES[action]
  if (!rule) return { ok: false, status: 400, error: 'Unknown action' }
  if (!(rule.actor === 'msme' ? isMsme : isProvider)) {
    return { ok: false, status: 403, error: `Only the ${rule.actor === 'msme' ? 'buyer' : 'seller'} can ${action}` }
  }
  const from = order.status as OrderStatus
  if (!rule.from.includes(from)) return { ok: false, status: 409, error: `Cannot ${action} from status '${from}'` }

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { status: rule.to, updated_at: now }
  let eventName: string = action
  let eventPayload: unknown = null

  // ── per-action validation + side-effect preparation ─────────────────────
  if (action === 'dispatch') {
    const parsed = goodsDispatchSchema.safeParse(extra.dispatch)
    if (!parsed.success) return { ok: false, status: 422, error: 'Dispatch details invalid' }
    const d = parsed.data
    if (!(await docOnOrder(admin, orderId, d.dispatch_photo_doc_id, ['dispatch_photo']))) {
      return { ok: false, status: 422, error: 'Dispatch photo not found on this order' }
    }
    if (d.seller_invoice_doc_id && !(await docOnOrder(admin, orderId, d.seller_invoice_doc_id, ['other', 'dispatch_photo', 'deliverable']))) {
      return { ok: false, status: 422, error: 'Seller invoice document not found on this order' }
    }
    // E-way bill fields are mandatory above the configured consignment value (§2).
    const threshold = await getEwayBillThresholdPaise(admin)
    if (Number(order.total_paise) >= threshold && (!d.eway_bill_number || !d.vehicle_number)) {
      return { ok: false, status: 422, error: 'eway_bill_required' }
    }
    eventName = 'dispatched'
    eventPayload = d
    // Two legal steps: accepted → requirements_submitted (auto; the checkout
    // delivery snapshot is the requirement) → in_progress.
    if (!isValidOrderTransition('accepted', 'requirements_submitted') || !isValidOrderTransition('requirements_submitted', 'in_progress')) {
      return { ok: false, status: 409, error: 'Illegal transition' }
    }
    const { error: e1 } = await admin
      .from('orders')
      .update({ status: 'requirements_submitted', updated_at: now })
      .eq('id', orderId)
      .eq('status', 'accepted')
    if (e1) return { ok: false, status: 500, error: e1.message }
    await addEvent(admin, orderId, 'requirements_submitted', actor.userId, { auto: true, source: 'goods_delivery_snapshot' })
    // Fall through with from = requirements_submitted for the final leg.
    const { error: e2 } = await admin.from('orders').update(patch).eq('id', orderId).eq('status', 'requirements_submitted')
    if (e2) return { ok: false, status: 500, error: e2.message }
    await addEvent(admin, orderId, eventName, actor.userId, eventPayload)
    const updated = { ...order, ...patch }
    try { await notifyOrderTransition(admin, updated, NOTIFY_AS[action]) } catch (e) { console.error('[notifyOrderTransition]', e) }
    return { ok: true, order: updated }
  }

  if (action === 'deliver') {
    const parsed = goodsDeliverSchema.safeParse(extra.deliver)
    if (!parsed.success) return { ok: false, status: 422, error: 'Delivery photo required' }
    if (!(await docOnOrder(admin, orderId, parsed.data.delivery_photo_doc_id, ['delivery_photo']))) {
      return { ok: false, status: 422, error: 'Delivery photo not found on this order' }
    }
    patch['auto_accept_at'] = new Date(Date.now() + 72 * 3600 * 1000).toISOString()
    eventName = 'delivered_photo'
    eventPayload = parsed.data
  }

  if (action === 'accept_delivery') {
    patch['completed_at'] = now
    eventName = 'buyer_received'
  }

  if (action === 'open_return') {
    const parsed = goodsReturnSchema.safeParse(extra.return)
    if (!parsed.success) return { ok: false, status: 422, error: 'Return reason required' }
    if (parsed.data.photo_doc_id && !(await docOnOrder(admin, orderId, parsed.data.photo_doc_id, ['delivery_photo', 'other']))) {
      return { ok: false, status: 422, error: 'Return photo not found on this order' }
    }
    eventName = 'return_opened'
    eventPayload = parsed.data
  }

  if (action === 'cancel') patch['cancelled_reason'] = 'buyer_cancelled'

  if (!isValidOrderTransition(from, rule.to)) return { ok: false, status: 409, error: `Illegal transition ${from} → ${rule.to}` }
  const { error: updErr } = await admin.from('orders').update(patch).eq('id', orderId).eq('status', from)
  if (updErr) return { ok: false, status: 500, error: updErr.message }
  await addEvent(admin, orderId, eventName, actor.userId, eventPayload)
  const updated = { ...order, ...patch }

  // ── side effects (services functions only) ──────────────────────────────
  if (action === 'accept_delivery') {
    await schedulePayout(admin, updated) // goods branch inside: hold reasons from the release gate + TDS fields
    await generateInvoices(admin, orderId)
  }
  if (action === 'open_return') {
    const r = extra.return as { reason: string; details?: string }
    await admin.from('disputes').upsert(
      { order_id: orderId, raised_by: actor.userId, reason: `return:${r.reason}`, details: r.details ?? null, status: 'open' },
      { onConflict: 'order_id', ignoreDuplicates: true },
    )
    const { data: heldRows } = await admin
      .from('payouts')
      .update({ status: 'held', updated_at: now })
      .eq('order_id', orderId)
      .eq('status', 'scheduled')
      .select('id, amount_paise')
    if (heldRows && heldRows.length > 0) {
      await addEvent(admin, orderId, 'payout_held', actor.userId, {
        payout_id: heldRows[0]!.id,
        amount_paise: heldRows[0]!.amount_paise,
        reasons: ['return_open'],
      })
    }
  }
  if (action === 'cancel') {
    const refunded = await processRefund(admin, updated, from)
    if (refunded > 0) {
      await admin.from('orders').update({ status: 'refunded' }).eq('id', orderId)
      await addEvent(admin, orderId, 'refunded', null, { amount_paise: refunded })
      updated.status = 'refunded'
    }
  }

  try { await notifyOrderTransition(admin, updated, NOTIFY_AS[action]) } catch (e) { console.error('[notifyOrderTransition]', e) }
  return { ok: true, order: updated }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
