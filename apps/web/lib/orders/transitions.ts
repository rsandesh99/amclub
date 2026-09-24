import 'server-only'
import {
  canRaiseDispute,
  isValidOrderTransition,
  computeRefundPaise,
  PAYOUT_RELEASE_STATUSES,
  ORDER_REFUND_OWED_STATUSES,
  DISPUTABLE_STATUSES,
  REFUND_STATUS,
  disputeSettlementPaise,
  type OrderStatus,
  type DisputeResolution,
} from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { getPaymentGateway } from '@/lib/payments'
import { moneyMovementBlock, MoneyPathBlockedError, paymentsAvailable } from '@/lib/payments/simulation'
import { PAYOUT_AUTO_RELEASE } from '@/lib/flags'
import { generateInvoices } from '@/lib/invoices/generate'
import { notifyOrderTransition, notifyAutoCancelled, notifyAutoAccepted } from '@/lib/notifications/events'
import { getGoodsDossier } from '@/lib/mart/release'
import { getTdsConfig } from '@/lib/mart/config'
import { getServicesEvidence } from '@/lib/orders/evidence'
import { maybeEnqueuePayoutDossier } from '@/lib/agent/dossier-trigger'
import { getAgentSetting } from '@/lib/agent/settings'
import { paymentForOrder, refundForOrder } from '@/lib/payments/order-payment'
import { captureServerEvent } from '@/lib/analytics/server'
import { reportOpsError } from '@/lib/observability'
import { SELF_DEALING, isSelfDealtOrder } from '@/lib/orders/self-dealing'
import { UNBOUNDED, type TimeBudget } from '@/lib/jobs/budget'

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
  /** ADR-014 (H2) — when the dispute window closed (with error 'dispute_window_closed'). */
  endsAt?: string
  order?: Record<string, unknown>
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function loadOrder(admin: Admin, orderId: string): Promise<any | null> {
  const { data } = await admin.from('orders').select('*').eq('id', orderId).maybeSingle()
  return data
}

export async function addEvent(admin: Admin, orderId: string, event: string, actorId: string | null, payload?: unknown) {
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

  // ADR 027 (audit L1) — a refund already made on this order (an admin manual
  // refund before completion) leaves the provider only their share of what the
  // buyer kept (the ADR-014 formula), and the payout is held for a release: a
  // refund and a full payout never both go out.
  let amountPaise = Number(order.provider_earning_paise)
  const payment = await paymentForOrder<{ id: string }>(admin, order, 'id')
  const refund = payment ? await refundForOrder<{ amount_paise: number }>(admin, order, payment.id, 'amount_paise') : null
  const refundedPaise = Number(refund?.amount_paise ?? 0)
  if (refundedPaise > 0) {
    const totalPaise = Number(order.total_paise)
    amountPaise = disputeSettlementPaise({ totalPaise, earningPaise: amountPaise, resolution: refundedPaise >= totalPaise ? 'refund_full' : 'refund_partial', amountPaise: refundedPaise }).providerPaidPaise
    holdReasons.push('refund_exists')
    if (amountPaise <= 0) {
      // Refunded in full: the provider is owed nothing, so no payout row (as a refund_full resolution voids it).
      const { data: prior } = await admin.from('order_events').select('id').eq('order_id', order.id).eq('event', 'payout_voided').limit(1)
      if (!(prior ?? []).length) await addEvent(admin, order.id, 'payout_voided', null, { reason: 'refund_full', refunded_paise: refundedPaise })
      return
    }
  }
  const held = holdReasons.length > 0

  const scheduledFor = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString().slice(0, 10) // T+2
  const { data: inserted } = await admin
    .from('payouts')
    .upsert(
      {
        provider_id: order.provider_id,
        order_id: order.id,
        amount_paise: amountPaise,
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
      amount_paise: amountPaise,
      scheduled_for: scheduledFor,
      ...(held ? { reasons: holdReasons } : {}),
      ...(refundedPaise > 0 ? { refunded_paise: refundedPaise } : {}),
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

  // E12c — a bundle child refunds against its purchase's ONE payment; its refund row is its own (by key).
  const payment = await paymentForOrder<{ id: string; razorpay_payment_id: string | null; simulated: unknown }>(admin, order, 'id, razorpay_payment_id, simulated:webhook_payload->simulated')
  if (!payment) return 0

  // ADR 027 (audit M2) — no refund through the simulation gateway on production,
  // and no real refund of a simulated payment. Refused BEFORE anything is
  // written: the row (if any) stays as it is, and the callers record the failure
  // (refund_failed) for the sweeper / ops once payments are available again.
  const gateway = getPaymentGateway()
  const blocked = moneyMovementBlock(gateway.isReal, payment)
  if (blocked) throw new MoneyPathBlockedError(blocked)

  // Phase 2f — money truth. ONE refund per order, keyed deterministically, and
  // the row is written BEFORE the gateway call (status 'pending'). A crash
  // between the two therefore leaves a pending row; the retry finds it, asks
  // the gateway for a refund carrying our receipt, and completes the row
  // instead of creating a second refund. (Insert-first, key-guarded.)
  const key = `rfnd_${order.id}`
  const nowIso = new Date().toISOString()
  let rowId: string
  let amountPaise = refundPaise
  const existing = await refundForOrder<{ id: string; status: string; amount_paise: number }>(admin, order, payment.id, 'id, status, amount_paise')
  if (existing) {
    if (existing.status === REFUND_STATUS.processed) return Number(existing.amount_paise)
    // ADR 027 — the gateway reported this refund failed (refund.failed webhook): the
    // buyer did not get it. Never re-read it as done and never re-send it blind; ops re-sends.
    if (existing.status === REFUND_STATUS.failed) throw new Error('refund_failed_at_gateway')
    rowId = existing.id // pending from an earlier attempt → complete it
    amountPaise = Number(existing.amount_paise)
  } else {
    const { data: inserted, error: insErr } = await admin
      .from('refunds')
      .insert({
        payment_id: payment.id,
        amount_paise: refundPaise,
        reason: resolution ?? 'cancellation',
        status: REFUND_STATUS.pending,
        idempotency_key: key,
      })
      .select('id')
      .single()
    if (insErr || !inserted) {
      // Unique-key race: a concurrent caller inserted first — re-read and defer to it.
      const again = await refundForOrder<{ id: string; status: string; amount_paise: number }>(admin, order, payment.id, 'id, status, amount_paise')
      if (!again) throw new Error(`refund insert failed: ${insErr?.message ?? 'unknown'}`)
      if (again.status === REFUND_STATUS.processed) return Number(again.amount_paise)
      if (again.status === REFUND_STATUS.failed) throw new Error('refund_failed_at_gateway')
      rowId = again.id
      amountPaise = Number(again.amount_paise)
    } else {
      rowId = inserted.id
    }
  }

  const razorpayPaymentId = payment.razorpay_payment_id ?? `pay_sim_${order.id}`
  // Retry path: reuse a refund the gateway already created for this key (a failed one is not a refund).
  const prior = (await gateway.listRefunds(razorpayPaymentId)).find((r) => r.receipt === key && r.status !== REFUND_STATUS.failed)
  const r =
    prior ??
    (await gateway.createRefund({
      razorpayPaymentId,
      amountPaise,
      receipt: key,
      notes: { order_id: order.id },
    }))
  // A refund the gateway itself reports failed is not recorded as processed (the row stays pending for the retry).
  if (r.status === REFUND_STATUS.failed) throw new Error('refund_failed_at_gateway')
  await admin
    .from('refunds')
    .update({ status: REFUND_STATUS.processed, razorpay_refund_id: r.razorpayRefundId, updated_at: nowIso })
    .eq('id', rowId)
    .eq('status', REFUND_STATUS.pending)
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

  // Audit M22 (ADR 027) — one person on both sides of an order acts on neither side
  // (checkout refuses such an order now; this covers any made before). The buyer's
  // cancel stays open: it only refunds the payer, and an unaccepted order also
  // auto-cancels in full after 24 h.
  if (action !== 'cancel' && (await isSelfDealtOrder(admin, order, actor.userId))) {
    return { ok: false, status: 409, error: SELF_DEALING }
  }

  const from = order.status as OrderStatus
  if (!rule.from.includes(from)) {
    return { ok: false, status: 409, error: `Cannot ${action} from status '${from}'` }
  }
  if (!isValidOrderTransition(from, rule.to)) {
    return { ok: false, status: 409, error: `Illegal transition ${from} → ${rule.to}` }
  }

  // ADR-014 (H2): after completion a dispute is accepted only inside the
  // post-completion window (agent_settings.dispute_window_days, from completed_at).
  if (action === 'raise_dispute' && from === 'completed') {
    const windowDays = Number(await getAgentSetting(admin, 'dispute_window_days'))
    const check = canRaiseDispute({ status: from, completedAt: order.completed_at ?? null, windowDays })
    if (!check.ok) {
      const endsAt = check.reason === 'window_closed' ? check.endsAt : null
      return { ok: false, status: 409, error: 'dispute_window_closed', ...(endsAt ? { endsAt } : {}) }
    }
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

  // ADR 026 (H6) — compare-and-set: the write lands only if the order is still
  // in the status this action was validated against. The loser of a race (a
  // cron, the other party) gets 409 and runs no side effect.
  const { data: moved, error: updErr } = await admin.from('orders').update(patch).eq('id', orderId).eq('status', from).select('id')
  if (updErr) return { ok: false, status: 500, error: updErr.message }
  if (!moved?.length) return { ok: false, status: 409, error: 'order_changed' }

  // A cancel records the status it left: the refund policy % depends on it, and a
  // re-driven refund (finishRefund) reads it back.
  await addEvent(admin, orderId, action, actor.userId, action === 'cancel' ? { ...(extra ?? {}), from } : extra ?? null)

  const updated = { ...order, ...patch }

  // Side effects after the state change.
  if (action === 'accept_delivery') {
    await schedulePayout(admin, updated)
    await safeGenerateInvoices(admin, orderId)
    // E12c — a bundle child's completion (its own payout above, like any order).
    if (updated.bundle_seq) captureServerEvent(actor.userId, 'bundle_milestone_completed', { seq: updated.bundle_seq })
  }
  if (action === 'raise_dispute') {
    await admin.from('disputes').upsert(
      { order_id: orderId, raised_by: actor.userId, reason: extra?.disputeReason ?? 'unspecified', status: 'open' },
      { onConflict: 'order_id', ignoreDuplicates: true },
    )
    // S1.7 — ask the Dispute-Triage agent for a card (gated; a no-op while dark; never throws).
    try {
      const { data: disp } = await admin.from('disputes').select('id').eq('order_id', orderId).maybeSingle()
      if (disp?.id) {
        const { maybeEnqueueDisputeTriage } = await import('@/lib/agent/triage-trigger')
        await maybeEnqueueDisputeTriage(admin, { orderId, disputeId: disp.id as string })
      }
    } catch (e) {
      console.error('[raise_dispute triage trigger]', (e as Error).message)
    }
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
    const r = await settleCancellationRefund(admin, updated, from)
    updated.status = r.status
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

/**
 * The placed orders past the 24 h accept window. E12c — a bundle child counts
 * from when it becomes actionable (`available_at`), not from the purchase; the
 * filter names a 0067 column, so before that migration it falls back to the
 * original query (no child exists then).
 */
export async function staleOrdersForAutoCancel(admin: Admin, cutoffIso: string): Promise<any[]> {
  const withAvail = await admin.from('orders').select('*').eq('status', 'placed').lt('created_at', cutoffIso).or(`available_at.is.null,available_at.lt.${cutoffIso}`).limit(200)
  if (!withAvail.error) return withAvail.data ?? []
  const { data } = await admin.from('orders').select('*').eq('status', 'placed').lt('created_at', cutoffIso).limit(200)
  return data ?? []
}

/** 24h no-accept → auto_cancelled → refunded (100%). Idempotent on status. */
export async function autoCancelOrder(admin: Admin, order: any): Promise<boolean> {
  if (order.status !== 'placed') return false
  // E12c — a bundle child's 24 h starts when it becomes actionable.
  if (order.available_at && new Date(order.available_at).getTime() > Date.now() - 24 * 3600 * 1000) return false
  if (!isValidOrderTransition('placed', 'auto_cancelled')) return false
  // ADR 026 (H6) — compare-and-set: a provider who accepted a moment ago wins.
  const { data: moved } = await admin
    .from('orders')
    .update({ status: 'auto_cancelled', cancelled_reason: 'no_accept_24h', updated_at: new Date().toISOString() })
    .eq('id', order.id)
    .eq('status', 'placed')
    .select('id')
  if (!moved?.length) return false
  await addEvent(admin, order.id, 'auto_cancelled', null, { reason: 'no_accept_24h', from: 'placed' })
  await settleCancellationRefund(admin, { ...order, status: 'auto_cancelled' }, 'placed')
  try { await notifyAutoCancelled(admin, order) } catch (e) { console.error('[notifyAutoCancelled]', e) }
  return true
}

/** 72h after delivery → completed; schedule payout + invoices. Idempotent. */
export async function autoAcceptOrder(admin: Admin, order: any): Promise<boolean> {
  if (order.status !== 'delivered') return false
  if (!isValidOrderTransition('delivered', 'completed')) return false
  const completedAt = new Date().toISOString()
  // ADR 026 (H6) — compare-and-set: a dispute or revision raised since the cron
  // read this row wins; the cron completes nothing and schedules no payout.
  const { data: moved } = await admin
    .from('orders')
    .update({ status: 'completed', completed_at: completedAt, updated_at: completedAt })
    .eq('id', order.id)
    .eq('status', 'delivered')
    .select('id')
  if (!moved?.length) return false
  await addEvent(admin, order.id, 'auto_accepted', null, { reason: '72h_auto_accept' })
  const updated = { ...order, status: 'completed', completed_at: completedAt }
  await schedulePayout(admin, updated)
  await safeGenerateInvoices(admin, order.id)
  if (order.bundle_seq) captureServerEvent('system', 'bundle_milestone_completed', { seq: order.bundle_seq })
  try { await notifyAutoAccepted(admin, updated) } catch (e) { console.error('[notifyAutoAccepted]', e) }
  return true
}

// ── ADR 026 — durable refunds and invoices ───────────────────────────────────


/**
 * Refund a cancelled order and move it to 'refunded'. Never throws: a refund
 * failure leaves the order in its cancelled status with a 'refund_failed' event,
 * and finishRefund (the auto-cancel cron's sweeper, or ops) completes it later.
 * processRefund is key-guarded and finds a refund the gateway already made, so a
 * re-drive never refunds twice.
 */
export async function settleCancellationRefund(
  admin: Admin,
  order: any,
  fromStatus: OrderStatus,
): Promise<{ status: string; refundedPaise: number; error?: string }> {
  let refunded = 0
  try {
    refunded = await processRefund(admin, order, fromStatus)
  } catch (e) {
    const reason = e instanceof Error ? e.message.slice(0, 200) : 'refund_error'
    console.error('[settleCancellationRefund] refund failed', order.id, reason)
    reportOpsError(e, 'refund_failed', { tags: { order_id: order.id, from: fromStatus } })
    await addEvent(admin, order.id, 'refund_failed', null, { reason, from: fromStatus })
    return { status: order.status, refundedPaise: 0, error: 'refund_failed' }
  }
  if (refunded <= 0) return { status: order.status, refundedPaise: 0 }
  const { data: moved } = await admin
    .from('orders')
    .update({ status: 'refunded', updated_at: new Date().toISOString() })
    .eq('id', order.id)
    .eq('status', order.status)
    .select('id')
  if (moved?.length) {
    await addEvent(admin, order.id, 'refunded', null, { amount_paise: refunded })
    return { status: 'refunded', refundedPaise: refunded }
  }
  const { data: now } = await admin.from('orders').select('status').eq('id', order.id).maybeSingle()
  return { status: (now?.status as string) ?? order.status, refundedPaise: refunded }
}

/** The status a cancelled order left: the cancel event records it; older rows fall back to the timeline. */
async function cancelledFrom(admin: Admin, order: any): Promise<OrderStatus> {
  if (order.status !== 'cancelled_by_buyer') return 'placed' // auto_cancelled / cancelled_duplicate leave 'placed'
  const { data: ev } = await admin.from('order_events').select('payload').eq('order_id', order.id).eq('event', 'cancel').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const recorded = (ev?.payload as { from?: string } | null)?.from
  if (recorded === 'placed' || recorded === 'accepted') return recorded
  const { data: accepted } = await admin.from('order_events').select('id').eq('order_id', order.id).eq('event', 'accept').limit(1)
  return (accepted ?? []).length > 0 ? 'accepted' : 'placed'
}

/** Complete the refund a cancelled order is still owed (ops "Finish refund", and the sweeper). */
export async function finishRefund(
  admin: Admin,
  order: any,
): Promise<{ ok: boolean; error?: string; refundedPaise?: number; status?: string }> {
  if (!ORDER_REFUND_OWED_STATUSES.includes(order.status)) return { ok: false, error: 'not_refund_owed' }
  const r = await settleCancellationRefund(admin, order, await cancelledFrom(admin, order))
  if (r.error) return { ok: false, error: r.error }
  return { ok: true, refundedPaise: r.refundedPaise, status: r.status }
}

/** Sweeper (auto-cancel cron): cancelled orders from the last 30 days still owed a refund, idle ≥ 10 minutes. */
export async function redriveCancellationRefunds(admin: Admin, budget: TimeBudget = UNBOUNDED): Promise<{ checked: number; refunded: number; failed: number; unavailable?: true }> {
  // ADR 027 (audit M2): no re-drive through the simulation gateway on production;
  // the refunds stay owed (and visible) until real keys are configured.
  if (!paymentsAvailable(getPaymentGateway().isReal)) return { checked: 0, refunded: 0, failed: 0, unavailable: true }
  const idle = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  const { data: rows } = await admin
    .from('orders')
    .select('*')
    .in('status', [...ORDER_REFUND_OWED_STATUSES])
    .lt('updated_at', idle)
    .gt('updated_at', since)
    .order('updated_at', { ascending: true })
    .limit(100)
  let refunded = 0
  let failed = 0
  for (const o of rows ?? []) {
    if (budget.spent()) break // audit M38 — the next run takes the rest
    const payment = await paymentForOrder<{ id: string; razorpay_payment_id: string | null; simulated: unknown }>(admin, o, 'id, razorpay_payment_id, simulated:webhook_payload->simulated')
    if (!payment) continue
    // ADR 027 — a simulated payment is never refunded by a real gateway; the cutover voids those orders.
    if (moneyMovementBlock(getPaymentGateway().isReal, payment)) continue
    // A processed refund whose order never moved is healed too: processRefund
    // returns the processed amount without calling the gateway again.
    const r = await finishRefund(admin, o)
    if (r.ok && (r.refundedPaise ?? 0) > 0) refunded++
    else if (!r.ok) failed++
  }
  return { checked: (rows ?? []).length, refunded, failed }
}

/** Invoices never fail an order action (ADR 026 / H8): a failure is recorded and swept later. */
export async function safeGenerateInvoices(admin: Admin, orderId: string): Promise<void> {
  try {
    await generateInvoices(admin, orderId)
  } catch (e) {
    const reason = e instanceof Error ? e.message.slice(0, 200) : 'invoice_error'
    console.error('[generateInvoices]', orderId, reason)
    reportOpsError(e, 'invoice_failed', { tags: { order_id: orderId } })
    await addEvent(admin, orderId, 'invoice_failed', null, { reason })
  }
}

/** Sweeper (reconcile cron): orders completed in the last 30 days with no invoice yet. */
export async function generateMissingInvoices(admin: Admin, budget: TimeBudget = UNBOUNDED): Promise<{ checked: number; generated: number }> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  const { data: rows } = await admin
    .from('orders')
    .select('id')
    .in('status', [...PAYOUT_RELEASE_STATUSES, 'reviewed'])
    .gt('completed_at', since)
    .order('completed_at', { ascending: false })
    .limit(500)
  const ids = (rows ?? []).map((r) => r.id as string)
  if (ids.length === 0) return { checked: 0, generated: 0 }
  const { data: have } = await admin.from('invoices').select('order_id').in('order_id', ids)
  const invoiced = new Set((have ?? []).map((r) => r.order_id as string))
  let generated = 0
  for (const id of ids) {
    if (invoiced.has(id)) continue
    if (budget.spent()) break // audit M38 — the next run takes the rest
    await safeGenerateInvoices(admin, id)
    generated++
  }
  return { checked: ids.length, generated }
}

/**
 * Sweeper (reconcile cron; audit M38, ADR 027): a completed order whose payout row
 * was never written. The status is written first and the payout after it
 * (accept-delivery, the auto-accept cron, the goods receipt), so a crash or a
 * timeout in between left the provider unpaid with nothing for ops to release.
 * schedulePayout is idempotent (one row per order, the event written once) and
 * applies every hold — with PAYOUT_AUTO_RELEASE off a swept payout is born held,
 * so no money moves without the founder's release. Bounded: completed in the
 * last 30 days and idle 10 minutes, newest first, pages of 500 (at most 10),
 * inside the cron's time budget.
 *
 * resolved_release / resolved_partial orders are never swept here: their payout
 * amount is the dispute settlement (ADR 014; schedulePayout would pay the full
 * earning), and a settlement of zero writes no row at all. An interrupted
 * resolution (order resolved, dispute still open) is finished only by the
 * resolve route's resume, so the sweeper counts those for ops instead.
 */
export async function sweepMissingPayouts(
  admin: Admin,
  budget: TimeBudget = UNBOUNDED,
): Promise<{ checked: number; scheduled: number; stalledResolutions: number }> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  const idle = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const completed: OrderStatus = 'completed'
  const PAGE = 500
  let checked = 0
  let scheduled = 0
  for (let page = 0; page < 10 && !budget.spent(); page++) {
    const { data: rows } = await admin
      .from('orders')
      .select('id')
      .eq('status', completed)
      .gt('completed_at', since)
      .lt('completed_at', idle)
      .order('completed_at', { ascending: false })
      .order('id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    const ids = (rows ?? []).map((r) => r.id as string)
    if (ids.length === 0) break
    checked += ids.length
    const paid = new Set<string>()
    for (let i = 0; i < ids.length; i += 100) {
      const { data: have } = await admin.from('payouts').select('order_id').in('order_id', ids.slice(i, i + 100))
      for (const r of have ?? []) paid.add(r.order_id as string)
    }
    for (const id of ids) {
      if (paid.has(id)) continue
      if (budget.spent()) break
      // Re-read the full row: it must still be completed when the payout is written.
      const order = await loadOrder(admin, id)
      if (!order || order.status !== completed) continue
      try {
        await schedulePayout(admin, order)
        scheduled++
      } catch (e) {
        console.error('[sweepMissingPayouts]', id, e instanceof Error ? e.message : e)
      }
    }
    if (ids.length < PAGE) break
  }
  const resolved: OrderStatus[] = PAYOUT_RELEASE_STATUSES.filter((st) => st !== completed)
  const { count: stalled } = await admin
    .from('disputes')
    .select('id, order:orders!inner(status, updated_at)', { count: 'exact', head: true })
    .eq('status', 'open')
    .in('order.status', resolved)
    .lt('order.updated_at', idle)
    .gt('order.updated_at', since)
  return { checked, scheduled, stalledResolutions: stalled ?? 0 }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
