import 'server-only'
import {
  isValidOrderTransition,
  computeRefundPaise,
  PAYOUT_RELEASE_STATUSES,
  DISPUTABLE_STATUSES,
  type OrderStatus,
  type DisputeResolution,
} from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { getPaymentGateway } from '@/lib/payments'
import { generateInvoices } from '@/lib/invoices/generate'
import { notifyOrderTransition, notifyAutoCancelled, notifyAutoAccepted } from '@/lib/notifications/events'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export type OrderAction =
  | 'accept'
  | 'submit_requirements'
  | 'start'
  | 'deliver'
  | 'accept_delivery'
  | 'request_revision'
  | 'resume'
  | 'cancel'
  | 'raise_dispute'

type ActorKind = 'msme' | 'provider' | 'either'

interface Rule {
  from: OrderStatus[]
  to: OrderStatus
  actor: ActorKind
}

// The ONLY place app actions map to §3.7 transitions + who may perform them.
const ACTION_RULES: Record<OrderAction, Rule> = {
  accept: { from: ['placed'], to: 'accepted', actor: 'provider' },
  submit_requirements: { from: ['accepted'], to: 'requirements_submitted', actor: 'msme' },
  start: { from: ['requirements_submitted'], to: 'in_progress', actor: 'provider' },
  deliver: { from: ['in_progress'], to: 'delivered', actor: 'provider' },
  accept_delivery: { from: ['delivered'], to: 'completed', actor: 'msme' },
  request_revision: { from: ['delivered'], to: 'revision_requested', actor: 'msme' },
  resume: { from: ['revision_requested'], to: 'in_progress', actor: 'provider' },
  cancel: { from: ['placed', 'accepted'], to: 'cancelled_by_buyer', actor: 'msme' },
  raise_dispute: { from: [...DISPUTABLE_STATUSES] as OrderStatus[], to: 'disputed', actor: 'either' },
}

export interface Actor {
  userId: string
  msmeId: string | null
  providerId: string | null
  roles: string[]
}

export interface TransitionResult {
  ok: boolean
  status?: number
  error?: string
  order?: Record<string, unknown>
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function loadOrder(admin: Admin, orderId: string): Promise<any | null> {
  const { data } = await admin.from('orders').select('*').eq('id', orderId).maybeSingle()
  return data
}

async function addEvent(admin: Admin, orderId: string, event: string, actorId: string | null, payload?: unknown) {
  await admin.from('order_events').insert({ order_id: orderId, actor_id: actorId, event, payload: payload ?? null })
}

/** Schedule a provider payout (idempotent on order_id). Auto-holds per §9.2. */
export async function schedulePayout(admin: Admin, order: any): Promise<void> {
  if (!PAYOUT_RELEASE_STATUSES.includes(order.status)) return

  // Holds: dispute open, provider suspended, or bank not verified.
  const [{ data: dispute }, { data: provider }, { data: bank }] = await Promise.all([
    admin.from('disputes').select('id').eq('order_id', order.id).eq('status', 'open').maybeSingle(),
    admin.from('provider_profiles').select('status').eq('id', order.provider_id).maybeSingle(),
    admin.from('provider_bank_accounts').select('penny_drop_verified').eq('provider_id', order.provider_id).maybeSingle(),
  ])
  const held = Boolean(dispute) || provider?.status === 'suspended' || !bank?.penny_drop_verified

  const scheduledFor = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString().slice(0, 10) // T+2
  await admin.from('payouts').upsert(
    {
      provider_id: order.provider_id,
      order_id: order.id,
      amount_paise: order.provider_earning_paise,
      status: held ? 'held' : 'scheduled',
      scheduled_for: scheduledFor,
    },
    { onConflict: 'order_id', ignoreDuplicates: true },
  )
}

/** Issue a refund for an order via the gateway + refunds row (idempotent-ish). */
export async function processRefund(
  admin: Admin,
  order: any,
  fromStatus: OrderStatus,
  resolution?: DisputeResolution,
  resolutionAmountPaise?: number,
): Promise<number> {
  const refundPaise = computeRefundPaise({
    totalPaise: order.total_paise,
    fromStatus,
    ...(resolution ? { resolution } : {}),
    ...(resolutionAmountPaise !== undefined ? { resolutionAmountPaise } : {}),
  })
  if (refundPaise <= 0) return 0

  const { data: payment } = await admin
    .from('payments')
    .select('id, razorpay_payment_id')
    .eq('order_id', order.id)
    .maybeSingle()
  if (!payment) return 0

  // Don't double-refund.
  const { data: existing } = await admin.from('refunds').select('id').eq('payment_id', payment.id).maybeSingle()
  if (existing) return refundPaise

  const gateway = getPaymentGateway()
  const r = await gateway.createRefund({
    razorpayPaymentId: payment.razorpay_payment_id ?? `pay_sim_${order.id}`,
    amountPaise: refundPaise,
    notes: { order_id: order.id },
  })
  await admin.from('refunds').insert({
    payment_id: payment.id,
    amount_paise: refundPaise,
    reason: resolution ?? 'cancellation',
    razorpay_refund_id: r.razorpayRefundId,
    status: 'processed',
  })
  return refundPaise
}

/**
 * Apply an order action: enforce actor role + the §3.7 transition, run side
 * effects (deliver → set 72h auto-accept; complete → schedule payout; cancel →
 * refund), and append an order_event. Server-side authz: the actor must be a
 * party to the order and permitted for the action.
 */
export async function applyTransition(
  admin: Admin,
  orderId: string,
  action: OrderAction,
  actor: Actor,
  extra?: { revisionNote?: string; disputeReason?: string },
): Promise<TransitionResult> {
  const order = await loadOrder(admin, orderId)
  if (!order) return { ok: false, status: 404, error: 'Order not found' }

  const isMsme = actor.msmeId != null && order.msme_id === actor.msmeId
  const isProvider = actor.providerId != null && order.provider_id === actor.providerId
  if (!isMsme && !isProvider) return { ok: false, status: 403, error: 'Not a party to this order' }

  const rule = ACTION_RULES[action]
  if (!rule) return { ok: false, status: 400, error: 'Unknown action' }

  const actorOk =
    rule.actor === 'either' ? isMsme || isProvider : rule.actor === 'msme' ? isMsme : isProvider
  if (!actorOk) return { ok: false, status: 403, error: `Only the ${rule.actor} can ${action}` }

  const from = order.status as OrderStatus
  if (!rule.from.includes(from)) {
    return { ok: false, status: 409, error: `Cannot ${action} from status '${from}'` }
  }
  if (!isValidOrderTransition(from, rule.to)) {
    return { ok: false, status: 409, error: `Illegal transition ${from} → ${rule.to}` }
  }

  // Revision cap.
  if (action === 'request_revision') {
    const max = order.revision_max ?? 0
    if (order.revision_used >= max) {
      return { ok: false, status: 409, error: `Revision limit reached (${max})` }
    }
  }

  const patch: Record<string, unknown> = { status: rule.to, updated_at: new Date().toISOString() }
  if (action === 'deliver') patch['auto_accept_at'] = new Date(Date.now() + 72 * 3600 * 1000).toISOString()
  if (action === 'accept_delivery') patch['completed_at'] = new Date().toISOString()
  if (action === 'request_revision') {
    patch['revision_used'] = order.revision_used + 1
    patch['auto_accept_at'] = null
  }
  if (action === 'cancel') patch['cancelled_reason'] = 'buyer_cancelled'

  const { error: updErr } = await admin.from('orders').update(patch).eq('id', orderId)
  if (updErr) return { ok: false, status: 500, error: updErr.message }

  await addEvent(admin, orderId, action, actor.userId, extra ?? null)

  const updated = { ...order, ...patch }

  // Side effects after the state change.
  if (action === 'accept_delivery') {
    await schedulePayout(admin, updated)
    await generateInvoices(admin, orderId)
  }
  if (action === 'raise_dispute') {
    await admin.from('disputes').upsert(
      { order_id: orderId, raised_by: actor.userId, reason: extra?.disputeReason ?? 'unspecified', status: 'open' },
      { onConflict: 'order_id', ignoreDuplicates: true },
    )
    // Hold any scheduled payout.
    await admin.from('payouts').update({ status: 'held' }).eq('order_id', orderId).eq('status', 'scheduled')
  }
  if (action === 'cancel') {
    const refunded = await processRefund(admin, updated, from)
    if (refunded > 0) {
      await admin.from('orders').update({ status: 'refunded' }).eq('id', orderId)
      await addEvent(admin, orderId, 'refunded', null, { amount_paise: refunded })
      updated.status = 'refunded'
    }
  }

  // Notify the counterparty (+ review prompt on completion). Never block the txn.
  try {
    await notifyOrderTransition(admin, updated, action)
  } catch (e) {
    console.error('[notifyOrderTransition]', e)
  }

  return { ok: true, order: updated }
}

// ── System (job-driven) transitions — no party actor, validated by the machine ──

/** 24h no-accept → auto_cancelled → refunded (100%). Idempotent on status. */
export async function autoCancelOrder(admin: Admin, order: any): Promise<boolean> {
  if (order.status !== 'placed') return false
  if (!isValidOrderTransition('placed', 'auto_cancelled')) return false
  await admin.from('orders').update({ status: 'auto_cancelled', cancelled_reason: 'no_accept_24h', updated_at: new Date().toISOString() }).eq('id', order.id)
  await addEvent(admin, order.id, 'auto_cancelled', null, { reason: 'no_accept_24h' })
  const refunded = await processRefund(admin, order, 'placed')
  if (refunded > 0) {
    await admin.from('orders').update({ status: 'refunded' }).eq('id', order.id)
    await addEvent(admin, order.id, 'refunded', null, { amount_paise: refunded })
  }
  try { await notifyAutoCancelled(admin, order) } catch (e) { console.error('[notifyAutoCancelled]', e) }
  return true
}

/** 72h after delivery → completed; schedule payout + invoices. Idempotent. */
export async function autoAcceptOrder(admin: Admin, order: any): Promise<boolean> {
  if (order.status !== 'delivered') return false
  if (!isValidOrderTransition('delivered', 'completed')) return false
  const completedAt = new Date().toISOString()
  await admin.from('orders').update({ status: 'completed', completed_at: completedAt, updated_at: completedAt }).eq('id', order.id)
  await addEvent(admin, order.id, 'auto_accepted', null, { reason: '72h_auto_accept' })
  const updated = { ...order, status: 'completed', completed_at: completedAt }
  await schedulePayout(admin, updated)
  await generateInvoices(admin, order.id)
  try { await notifyAutoAccepted(admin, updated) } catch (e) { console.error('[notifyAutoAccepted]', e) }
  return true
}
/* eslint-enable @typescript-eslint/no-explicit-any */
