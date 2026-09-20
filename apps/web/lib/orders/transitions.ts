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
import { PAYOUT_AUTO_RELEASE } from '@/lib/flags'
import { generateInvoices } from '@/lib/invoices/generate'
import { notifyOrderTransition, notifyAutoCancelled, notifyAutoAccepted } from '@/lib/notifications/events'
import { getGoodsDossier } from '@/lib/mart/release'
import { getTdsConfig } from '@/lib/mart/config'
import { getServicesEvidence } from '@/lib/orders/evidence'
import { maybeEnqueuePayoutDossier } from '@/lib/agent/dossier-trigger'

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
  // Founder control gate: unless PAYOUT_AUTO_RELEASE=true, EVERY payout is
  // created 'held' — money moves only when an admin explicitly releases it
  // from /admin/payouts after checking the delivered work.
  const holdReasons = [
    ...(!PAYOUT_AUTO_RELEASE ? ['approval_gate'] : []),
    ...(dispute ? ['dispute_open'] : []),
    ...(provider?.status === 'suspended' ? ['provider_suspended'] : []),
    ...(!bank?.penny_drop_verified ? ['bank_unverified'] : []),
  ]
  // AMC Mart (kind='goods' ONLY — services orders never enter this branch):
  // the goods release gate (delivery photo + receipt + return window clear)
  // adds its hold reasons, and TDS fields are recorded from config (§2).
  let tds: { tds_section: string; tds_bps: number; tds_paise: number } | null = null
  if (order.kind === 'goods') {
    const dossier = await getGoodsDossier(admin, order)
    holdReasons.push(...dossier.gate.reasons)
    const cfg = await getTdsConfig(admin)
    const applies = cfg.rate_bps > 0 && Number(order.provider_earning_paise) >= cfg.threshold_paise
    tds = {
      tds_section: cfg.section,
      tds_bps: applies ? cfg.rate_bps : 0,
      tds_paise: applies ? Math.round((Number(order.provider_earning_paise) * cfg.rate_bps) / 10000) : 0,
    }
  }
  // Services evidence gate (S0.3): a services order placed on/after the
  // evidence_required_from cutover is held until a work-complete photo +
  // buyer confirmation exist and no dispute is open. Inert (no reasons) until
  // the cutover is set — byte-identical to today for every existing order.
  if (order.kind !== 'goods') {
    const ev = await getServicesEvidence(admin, order)
    if (ev.enforced && !ev.gate.ok) holdReasons.push(...ev.gate.reasons)
  }
  const held = holdReasons.length > 0

  const scheduledFor = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString().slice(0, 10) // T+2
  const { data: inserted } = await admin
    .from('payouts')
    .upsert(
      {
        provider_id: order.provider_id,
        order_id: order.id,
        amount_paise: order.provider_earning_paise,
        status: held ? 'held' : 'scheduled',
        scheduled_for: scheduledFor,
        ...(tds ?? {}),
      },
      { onConflict: 'order_id', ignoreDuplicates: true },
    )
    .select('id')
  // ignoreDuplicates returns rows only when this call created the payout, so
  // the timeline event is written exactly once per order.
  const payoutId = inserted?.[0]?.id
  if (payoutId) {
    await addEvent(admin, order.id, held ? 'payout_held' : 'payout_scheduled', null, {
      payout_id: payoutId,
      amount_paise: order.provider_earning_paise,
      scheduled_for: scheduledFor,
      ...(held ? { reasons: holdReasons } : {}),
    })
    // S1.4 — Payout-Evidence agent: assemble a dossier for a payout born HELD.
    // Best-effort, after the money write, never inside it; a no-op unless
    // AGENT_ENABLED + agents_enabled.payout_dossier + ops_user_id (+ cohort).
    if (held) await maybeEnqueuePayoutDossier(admin, order, payoutId)
  }
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

  // Phase 2f — money truth. ONE refund per order, keyed deterministically, and
  // the row is written BEFORE the gateway call (status 'pending'). A crash
  // between the two therefore leaves a pending row; the retry finds it, asks
  // the gateway for a refund carrying our receipt, and completes the row
  // instead of creating a second refund. (Insert-first, key-guarded.)
  const key = `rfnd_${order.id}`
  const nowIso = new Date().toISOString()
  let rowId: string
  let amountPaise = refundPaise
  const { data: existing } = await admin
    .from('refunds')
    .select('id, status, amount_paise')
    .eq('payment_id', payment.id)
    .maybeSingle()
  if (existing) {
    if (existing.status === 'processed') return Number(existing.amount_paise)
    rowId = existing.id // pending from an earlier attempt → complete it
    amountPaise = Number(existing.amount_paise)
  } else {
    const { data: inserted, error: insErr } = await admin
      .from('refunds')
      .insert({
        payment_id: payment.id,
        amount_paise: refundPaise,
        reason: resolution ?? 'cancellation',
        status: 'pending',
        idempotency_key: key,
      })
      .select('id')
      .single()
    if (insErr || !inserted) {
      // Unique-key race: a concurrent caller inserted first — re-read and defer to it.
      const { data: again } = await admin
        .from('refunds')
        .select('id, status, amount_paise')
        .eq('payment_id', payment.id)
        .maybeSingle()
      if (!again) throw new Error(`refund insert failed: ${insErr?.message ?? 'unknown'}`)
      if (again.status === 'processed') return Number(again.amount_paise)
      rowId = again.id
      amountPaise = Number(again.amount_paise)
    } else {
      rowId = inserted.id
    }
  }

  const gateway = getPaymentGateway()
  const razorpayPaymentId = payment.razorpay_payment_id ?? `pay_sim_${order.id}`
  // Retry path: reuse a refund the gateway already created for this key.
  const prior = (await gateway.listRefunds(razorpayPaymentId)).find((r) => r.receipt === key)
  const r =
    prior ??
    (await gateway.createRefund({
      razorpayPaymentId,
      amountPaise,
      receipt: key,
      notes: { order_id: order.id },
    }))
  await admin
    .from('refunds')
    .update({ status: 'processed', razorpay_refund_id: r.razorpayRefundId, updated_at: nowIso })
    .eq('id', rowId)
    .eq('status', 'pending')
  return amountPaise
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
  // AMC Mart: goods orders have their own action set (lib/mart/goods-transitions);
  // services orders (kind='service') never hit this line's branch.
  if (order.kind === 'goods') return { ok: false, status: 409, error: 'Goods orders use the Mart order actions' }

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
    const { data: heldRows } = await admin
      .from('payouts')
      .update({ status: 'held' })
      .eq('order_id', orderId)
      .eq('status', 'scheduled')
      .select('id, amount_paise')
    if (heldRows && heldRows.length > 0) {
      await addEvent(admin, orderId, 'payout_held', actor.userId, {
        payout_id: heldRows[0]!.id,
        amount_paise: heldRows[0]!.amount_paise,
        reasons: ['dispute_open'],
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
