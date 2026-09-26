import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DisputeResolution, MilestoneKind, NotificationKind } from '@amclub/shared'
import { createNotification } from './create'
import { formatPaise, istDateTime } from './format'
import { claimOnce } from './store'
import { notifyText } from '@/lib/i18n/notify'

/**
 * The order, payment and outcome notices (§5.9, ADR-030 §4). Each names its KIND; the registry decides the channels.
 * Copy is the `notify` namespace of the message files; typed `values` (ref, amount, deadline …) feed the WhatsApp and
 * SMS templates. Money is formatted here from integer paise (formatPaise), deadlines in IST.
 */

type Admin = SupabaseClient
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Resolve both parties' user ids for an order (for notification targeting). */
async function parties(admin: Admin, order: any): Promise<{ msmeUserId: string | null; providerUserId: string | null }> {
  const [{ data: m }, { data: p }] = await Promise.all([
    admin.from('msme_profiles').select('user_id').eq('id', order.msme_id).maybeSingle(),
    admin.from('provider_profiles').select('user_id').eq('id', order.provider_id).maybeSingle(),
  ])
  return { msmeUserId: m?.user_id ?? null, providerUserId: p?.user_id ?? null }
}

const ref = (o: any): string => o.order_number ?? o.title ?? 'your order'
const isGoods = (o: any): boolean => o?.kind === 'goods'
const buyerLink = (orderId: string) => `/app/orders/${orderId}`
const providerLink = (orderId: string) => `/partner/orders/${orderId}`

/**
 * Order placed (payment captured → order materialised). The provider hears "new order, accept within 24 h"; the buyer
 * gets their own payment receipt (on WhatsApp too). Best-effort.
 */
export async function notifyOrderPlaced(admin: Admin, orderId: string): Promise<void> {
  const { data: order } = await admin.from('orders').select('*').eq('id', orderId).maybeSingle()
  if (!order) return
  const { msmeUserId, providerUserId } = await parties(admin, order)
  const r = ref(order)
  const amount = formatPaise(Number(order.total_paise))
  if (providerUserId) {
    await createNotification(admin, {
      userId: providerUserId,
      kind: 'order_placed',
      titleI18n: notifyText('order_placed_provider.title'),
      bodyI18n: notifyText('order_placed_provider.body', { ref: r }),
      link: providerLink(orderId),
      values: { ref: r },
    })
  }
  if (msmeUserId) {
    await createNotification(admin, {
      userId: msmeUserId,
      kind: 'order_placed',
      titleI18n: notifyText('order_placed_buyer.title'),
      bodyI18n: notifyText('order_placed_buyer.body', { ref: r, amount }),
      link: buyerLink(orderId),
      values: { ref: r, amount },
    })
  }
}

interface EventCopy {
  to: 'msme' | 'provider'
  kind: NotificationKind
  /** The `notify.<key>` pair (title / body with {ref}). */
  key: string
}

/** Per-action copy + recipient: one place, mirrors §3.7. Goods orders get their own words (dispatch, receipt, return). */
function copyFor(action: string, goods: boolean): EventCopy | null {
  switch (action) {
    case 'accept':
      return { to: 'msme', kind: 'order_accepted', key: goods ? 'goods_order_accepted' : 'order_accepted' }
    case 'submit_requirements':
      return { to: 'provider', kind: 'requirements_submitted', key: 'requirements_submitted' }
    case 'start':
      // goods: the dispatch action (accepted → requirements_submitted → in_progress)
      return goods ? { to: 'msme', kind: 'goods_dispatched', key: 'goods_dispatched' } : { to: 'msme', kind: 'order_in_progress', key: 'order_started' }
    case 'deliver':
      return goods ? { to: 'msme', kind: 'goods_delivered', key: 'goods_delivered' } : { to: 'msme', kind: 'order_delivered', key: 'order_delivered' }
    case 'accept_delivery':
      return { to: 'provider', kind: 'order_completed', key: goods ? 'goods_received' : 'order_completed' }
    case 'request_revision':
      return { to: 'provider', kind: 'revision_requested', key: 'revision_requested' }
    case 'resume':
      return { to: 'msme', kind: 'order_in_progress', key: 'revision_in_progress' }
    case 'cancel':
      return { to: 'provider', kind: 'order_cancelled', key: 'order_cancelled' }
    default:
      return null
  }
}

/**
 * Notify the counterparty after a buyer/provider-driven order transition.
 * `accept_delivery` also fires the review prompt to the buyer (separately).
 */
export async function notifyOrderTransition(admin: Admin, order: any, action: string): Promise<void> {
  const goods = isGoods(order)
  const c = copyFor(action, goods)
  if (!c) {
    if (action === 'raise_dispute') await notifyDispute(admin, order)
    return
  }
  const { msmeUserId, providerUserId } = await parties(admin, order)
  const userId = c.to === 'msme' ? msmeUserId : providerUserId
  const r = ref(order)
  // Delivery starts the 72-hour auto-accept: the deadline is part of the notice.
  const deadline = action === 'deliver' && order.auto_accept_at ? istDateTime(order.auto_accept_at) : null
  if (userId) {
    await createNotification(admin, {
      userId,
      kind: c.kind,
      titleI18n: notifyText(`${c.key}.title`),
      bodyI18n: notifyText(`${c.key}.body`, { ref: r, ...(deadline ? { deadline } : {}) }),
      link: c.to === 'msme' ? buyerLink(order.id) : providerLink(order.id),
      values: { ref: r, ...(deadline ? { deadline } : {}) },
    })
  }
  if (action === 'accept_delivery') await notifyReviewPrompt(admin, order)
}

async function notifyDispute(admin: Admin, order: any): Promise<void> {
  const { msmeUserId, providerUserId } = await parties(admin, order)
  const key = isGoods(order) ? 'goods_return_opened' : 'order_disputed'
  for (const userId of [msmeUserId, providerUserId].filter(Boolean) as string[]) {
    await createNotification(admin, {
      userId,
      kind: 'order_disputed',
      titleI18n: notifyText(`${key}.title`),
      bodyI18n: notifyText(`${key}.body`, { ref: ref(order) }),
      link: userId === msmeUserId ? buyerLink(order.id) : providerLink(order.id),
      values: { ref: ref(order) },
    })
  }
}

/** S0.4 quote-or-decline: tell the buyer how many matched providers could not
 *  take the RFQ up (declines + window lapses) — polite, translated, no model call. */
export async function notifyQuoteWindowLapsed(admin: Admin, rfq: any, counts: { unavailable: number; total: number }): Promise<void> {
  const { data: m } = await admin.from('msme_profiles').select('user_id').eq('id', rfq.msme_id).maybeSingle()
  const userId = m?.user_id as string | undefined
  if (!userId) return
  const title = rfq.title ?? notifyText('your_request')
  await createNotification(admin, {
    userId,
    kind: 'rfq_providers_unavailable',
    titleI18n: notifyText('providers_unavailable.title'),
    bodyI18n: notifyText('providers_unavailable.body', { unavailable: counts.unavailable, total: counts.total, title }),
    link: `/app/rfq/${rfq.id}`,
    values: { title, unavailable: counts.unavailable, total: counts.total },
  })
}

/** Services evidence engine (S0.3): notify the buyer on each milestone. Best-effort. */
export async function notifyMilestone(admin: Admin, order: any, kind: MilestoneKind): Promise<void> {
  const { msmeUserId } = await parties(admin, order)
  if (!msmeUserId) return
  const label = notifyText(`milestone_label.${kind}`)
  await createNotification(admin, {
    userId: msmeUserId,
    kind: 'milestone_added',
    titleI18n: notifyText('milestone.title', { label }),
    bodyI18n: notifyText('milestone.body', { ref: ref(order), label }),
    link: buyerLink(order.id),
    values: { ref: ref(order), label },
  })
}

/** Prompt the buyer to review a completed order. */
export async function notifyReviewPrompt(admin: Admin, order: any): Promise<void> {
  const { msmeUserId } = await parties(admin, order)
  if (!msmeUserId) return
  await createNotification(admin, {
    userId: msmeUserId,
    kind: 'review_prompt',
    titleI18n: notifyText('review_prompt.title'),
    bodyI18n: notifyText('review_prompt.body', { ref: ref(order) }),
    link: buyerLink(order.id),
    values: { ref: ref(order) },
  })
}

/** System: order auto-cancelled (24h no-accept) → refunded. Notify buyer, and tell the provider why they lost it. */
export async function notifyAutoCancelled(admin: Admin, order: any): Promise<void> {
  const { msmeUserId, providerUserId } = await parties(admin, order)
  if (msmeUserId) {
    await createNotification(admin, {
      userId: msmeUserId,
      kind: 'order_auto_cancelled',
      titleI18n: notifyText('auto_cancelled_buyer.title'),
      bodyI18n: notifyText('auto_cancelled_buyer.body', { ref: ref(order) }),
      link: buyerLink(order.id),
      values: { ref: ref(order) },
    })
  }
  if (providerUserId) {
    await createNotification(admin, {
      userId: providerUserId,
      kind: 'order_auto_cancelled',
      titleI18n: notifyText('auto_cancelled_provider.title'),
      bodyI18n: notifyText('auto_cancelled_provider.body', { ref: ref(order) }),
      link: providerLink(order.id),
      values: { ref: ref(order) },
    })
  }
}

/** System: delivered order auto-accepted (72h) → completed. Notify both + prompt review. */
export async function notifyAutoAccepted(admin: Admin, order: any): Promise<void> {
  const { msmeUserId, providerUserId } = await parties(admin, order)
  if (providerUserId) {
    await createNotification(admin, {
      userId: providerUserId,
      kind: 'order_completed',
      titleI18n: notifyText('auto_completed_provider.title'),
      bodyI18n: notifyText('auto_completed_provider.body', { ref: ref(order) }),
      link: providerLink(order.id),
      values: { ref: ref(order) },
    })
  }
  if (msmeUserId) {
    await createNotification(admin, {
      userId: msmeUserId,
      kind: 'order_auto_accepted',
      titleI18n: notifyText('auto_accepted_buyer.title'),
      bodyI18n: notifyText('auto_accepted_buyer.body', { ref: ref(order) }),
      link: buyerLink(order.id),
      values: { ref: ref(order) },
    })
  }
  await notifyReviewPrompt(admin, order)
}

/** A provider withdrew their quote on the buyer's RFQ: WhatsApp + email, like a new / revised quote. */
export async function notifyQuoteWithdrawn(admin: Admin, rfqId: string): Promise<void> {
  const { data } = await admin.from('rfqs').select('id, title, msme:msme_profiles!inner(user_id)').eq('id', rfqId).maybeSingle()
  const r = data as any
  const userId = r?.msme?.user_id as string | undefined
  if (!userId) return
  const title = (r.title as string | null) ?? notifyText('your_request')
  await createNotification(admin, {
    userId,
    kind: 'quote_withdrawn',
    titleI18n: notifyText('quote_withdrawn.title'),
    bodyI18n: notifyText('quote_withdrawn.body', { title }),
    link: `/app/rfq/${rfqId}`,
    values: { title },
  })
}

/** rfq.expire cron: the buyer's request ran out of time — offer to post it again. Once per transitioned RFQ. */
export async function notifyRfqExpired(admin: Admin, rfq: { id: string; title: string | null; msme_id: string }): Promise<void> {
  const { data: m } = await admin.from('msme_profiles').select('user_id').eq('id', rfq.msme_id).maybeSingle()
  const userId = m?.user_id as string | undefined
  if (!userId) return
  const title = rfq.title ?? notifyText('your_request')
  await createNotification(admin, {
    userId,
    kind: 'rfq_expired',
    titleI18n: notifyText('rfq_expired.title'),
    bodyI18n: notifyText('rfq_expired.body', { title }),
    link: `/app/rfq/new?from=${rfq.id}`,
    values: { title },
  })
}

/** rfq.expire cron: the provider's still-submitted quote closed with the request. One per expired quote. */
export async function notifyQuotesExpired(admin: Admin, quotes: { providerId: string; rfqId: string; rfqTitle: string | null }[]): Promise<void> {
  if (quotes.length === 0) return
  const { data: provs } = await admin.from('provider_profiles').select('id, user_id').in('id', [...new Set(quotes.map((q) => q.providerId))])
  const userOf = new Map(((provs ?? []) as any[]).map((p) => [p.id as string, p.user_id as string]))
  for (const q of quotes) {
    const userId = userOf.get(q.providerId)
    if (!userId) continue
    const title = q.rfqTitle ?? notifyText('a_request')
    await createNotification(admin, {
      userId,
      kind: 'quote_expired',
      titleI18n: notifyText('quote_expired.title'),
      bodyI18n: notifyText('quote_expired.body', { title }),
      link: `/partner/rfqs/${q.rfqId}`,
    })
  }
}

async function orderNumber(admin: Admin, orderId: string | null | undefined): Promise<string> {
  if (!orderId) return '—'
  const { data } = await admin.from('orders').select('order_number').eq('id', orderId).maybeSingle()
  return String((data as { order_number?: string } | null)?.order_number ?? '—')
}

/**
 * Provider payout marked paid (payouts cron, a gateway confirmation). The exact amount in paise (never rounded to the
 * rupee) and the transfer reference when the transfer was real.
 */
export async function notifyPayoutPaid(admin: Admin, providerId: string, amountPaise: number, orderId: string, transferRef?: string | null): Promise<void> {
  const { data: p } = await admin.from('provider_profiles').select('user_id').eq('id', providerId).maybeSingle()
  if (!p?.user_id) return
  const amount = formatPaise(amountPaise)
  const r = await orderNumber(admin, orderId)
  const transfer = transferRef && !transferRef.startsWith('sim') ? transferRef : null
  await createNotification(admin, {
    userId: p.user_id,
    kind: 'payout_paid',
    titleI18n: notifyText('payout_paid.title'),
    bodyI18n: transfer ? notifyText('payout_paid.body_ref', { amount, ref: r, transfer }) : notifyText('payout_paid.body', { amount, ref: r }),
    link: orderId ? providerLink(orderId) : `/partner/earnings`,
    values: { amount, ref: r, ...(transfer ? { transfer } : {}) },
  })
}

/** The provider-facing label for a payout blocker (payoutRunBlockers). Chargebacks stay unnamed (a payment check). */
function holdReasonKey(blocker: string): string {
  if (blocker.startsWith('order_status:') || blocker === 'dispute_open' || blocker === 'return_open') return 'dispute'
  if (blocker === 'no_delivery_photo' || blocker === 'missing_work_complete_photo') return 'proof'
  if (blocker === 'awaiting_receipt' || blocker === 'awaiting_buyer_confirmation') return 'buyer_confirmation'
  if (blocker === 'return_window_open') return 'return_window'
  if (blocker === 'refund_exists' || blocker === 'nothing_to_pay') return 'refund'
  return 'review'
}

/**
 * runPayouts held a payout at release (ADR 026): tell the provider why, once per payout and set of reasons.
 */
export async function notifyPayoutHeld(admin: Admin, payout: { id: string; order_id: string; provider_id: string; amount_paise: number | string }, blockers: string[]): Promise<void> {
  const keys = [...new Set(blockers.map(holdReasonKey))].sort()
  const claim = await claimOnce(admin, { kind: 'payout_held', entityId: payout.id, stage: keys.join(',').slice(0, 120) })
  if (claim === 'taken') return
  const { data: p } = await admin.from('provider_profiles').select('user_id').eq('id', payout.provider_id).maybeSingle()
  if (!p?.user_id) return
  const amount = formatPaise(Number(payout.amount_paise))
  const r = await orderNumber(admin, payout.order_id)
  const labels = keys.map((k) => notifyText(`payout_hold_reason.${k}`))
  const reasons = {
    en: labels.map((l) => l.en).join('; '),
    hi: labels.map((l) => l.hi).join('; '),
    ...(labels.every((l) => l.te) ? { te: labels.map((l) => l.te!).join('; ') } : {}),
    ...(labels.every((l) => l.ta) ? { ta: labels.map((l) => l.ta!).join('; ') } : {}),
  }
  await createNotification(admin, {
    userId: p.user_id,
    kind: 'payout_held',
    titleI18n: notifyText('payout_held.title'),
    bodyI18n: notifyText('payout_held.body', { amount, ref: r, reasons }),
    link: providerLink(payout.order_id),
    values: { amount, ref: r, reasons },
  })
}

/**
 * A buyer's refund went through (the cancellation settlement, the gateway webhook) or came back failed. Each outcome
 * is told once per order (notification_reminders claim; without 0087 the callers' own once-guards hold).
 */
export async function notifyRefund(admin: Admin, orderOrId: any, outcome: 'processed' | 'failed', amountPaise: number | null): Promise<void> {
  const order = typeof orderOrId === 'string' ? (await admin.from('orders').select('*').eq('id', orderOrId).maybeSingle()).data : orderOrId
  if (!order) return
  const claim = await claimOnce(admin, { kind: 'refund', entityId: order.id, stage: outcome })
  if (claim === 'taken') return
  const { msmeUserId } = await parties(admin, order)
  if (!msmeUserId) return
  const amount = amountPaise != null && amountPaise > 0 ? formatPaise(amountPaise) : formatPaise(Number(order.total_paise))
  const r = ref(order)
  await createNotification(admin, {
    userId: msmeUserId,
    kind: outcome === 'processed' ? 'refund_processed' : 'refund_failed',
    titleI18n: notifyText(`refund_${outcome}.title`),
    bodyI18n: notifyText(`refund_${outcome}.body`, { amount, ref: r }),
    link: buyerLink(order.id),
    values: { amount, ref: r },
  })
}

/** Mark a refund as already announced (a dispute resolution names the amount itself), so the webhook stays quiet. */
export async function markRefundAnnounced(admin: Admin, orderId: string): Promise<void> {
  await claimOnce(admin, { kind: 'refund', entityId: orderId, stage: 'processed' })
}

/**
 * A dispute (or a goods return) was resolved: both parties hear the outcome, with the refund and payout amounts
 * formatted from paise on the server.
 */
export async function notifyDisputeResolved(
  admin: Admin,
  d: { order: any; resolution: DisputeResolution; refundPaise: number; providerPaidPaise: number },
): Promise<void> {
  const { msmeUserId, providerUserId } = await parties(admin, d.order)
  const r = ref(d.order)
  const goods = isGoods(d.order) ? 'yes' : 'no'
  const amount = formatPaise(d.refundPaise)
  const payout = formatPaise(d.providerPaidPaise)
  const outcome = d.resolution === 'refund_full' ? 'refund_full' : d.resolution === 'refund_partial' ? 'refund_partial' : 'release'
  const values = { ref: r, amount, payout, outcome }
  if (msmeUserId) {
    await createNotification(admin, {
      userId: msmeUserId,
      kind: 'dispute_resolved',
      titleI18n: notifyText('dispute_resolved.title', { ref: r, goods }),
      bodyI18n: notifyText(`dispute_resolved.buyer_${outcome}`, { amount }),
      link: buyerLink(d.order.id),
      values,
    })
  }
  if (providerUserId) {
    await createNotification(admin, {
      userId: providerUserId,
      kind: 'dispute_resolved',
      titleI18n: notifyText('dispute_resolved.title', { ref: r, goods }),
      bodyI18n: notifyText(`dispute_resolved.provider_${outcome}`, { amount, payout }),
      link: providerLink(d.order.id),
      values,
    })
  }
}

/** The admin verification queue decided (approve / reject with the reason / needs more information). */
export async function notifyVerificationDecision(admin: Admin, providerId: string, decision: 'approve' | 'reject' | 'needs_info', reason?: string | null): Promise<void> {
  const { data: p } = await admin.from('provider_profiles').select('user_id').eq('id', providerId).maybeSingle()
  if (!p?.user_id) return
  const why = String(reason ?? '').trim().slice(0, 500)
  const kind: NotificationKind = decision === 'approve' ? 'provider_verified' : decision === 'reject' ? 'provider_rejected' : 'provider_needs_info'
  await createNotification(admin, {
    userId: p.user_id as string,
    kind,
    titleI18n: notifyText(`${kind}.title`),
    bodyI18n: decision === 'approve' ? notifyText(`${kind}.body`) : notifyText(`${kind}.body`, { reason: why }),
    link: decision === 'needs_info' ? '/partner/onboarding' : '/partner',
    values: decision === 'approve' ? {} : { reason: why },
  })
}

/** Provider replied to a buyer's review. Notify the buyer. */
export async function notifyReviewReply(admin: Admin, review: any): Promise<void> {
  const { data: m } = await admin.from('msme_profiles').select('user_id').eq('id', review.msme_id).maybeSingle()
  if (!m?.user_id) return
  await createNotification(admin, {
    userId: m.user_id,
    kind: 'review_reply',
    titleI18n: notifyText('review_reply.title'),
    bodyI18n: notifyText('review_reply.body'),
    link: buyerLink(review.order_id),
  })
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * S1.7 — a party stated their side on an open dispute: the counter-party is
 * told and the ops user in-app when set. Never the body.
 */
export async function notifyDisputeStatement(
  admin: Admin,
  d: { order: { id: string; order_number: string; msme_id: string; provider_id: string }; disputeId: string; role: 'buyer' | 'provider'; edited: boolean },
): Promise<void> {
  const { msmeUserId, providerUserId } = await parties(admin, d.order)
  const counterparty = d.role === 'buyer' ? providerUserId : msmeUserId
  const r = ref(d.order)
  if (counterparty) {
    await createNotification(admin, {
      userId: counterparty,
      kind: 'dispute_statement',
      titleI18n: notifyText('dispute_statement.title', { who: d.role, edited: d.edited ? 'yes' : 'no', ref: r }),
      bodyI18n: notifyText('dispute_statement.body'),
      link: d.role === 'buyer' ? providerLink(d.order.id) : buyerLink(d.order.id),
      values: { ref: r },
    })
  }
  const { data: ops } = await admin.from('agent_settings').select('value').eq('key', 'ops_user_id').maybeSingle()
  const opsUserId = typeof ops?.value === 'string' ? ops.value : null
  if (opsUserId) {
    await createNotification(admin, {
      userId: opsUserId,
      kind: 'dispute_statement',
      titleI18n: notifyText('dispute_statement_ops.title', { who: d.role, ref: r }),
      bodyI18n: notifyText('dispute_statement_ops.body'),
      link: `/admin/disputes/${d.disputeId}`,
      values: { ref: r },
    })
  }
}

/**
 * S1.7 — a triage card is ready for the ops user. Sent once per triage (the
 * notify route claims notified_at first). Recommendation only; nothing moves.
 */
export async function notifyDisputeTriageReady(
  admin: Admin,
  d: { opsUserId: string; triageId: string; disputeId: string; orderNumber: string; recommendation: string; confidence: string },
): Promise<void> {
  const rec = d.recommendation.replace(/_/g, ' ')
  await createNotification(admin, {
    userId: d.opsUserId,
    kind: 'dispute_triage_ready',
    titleI18n: notifyText('dispute_triage_ready.title', { ref: d.orderNumber, rec, confidence: d.confidence }),
    bodyI18n: notifyText('dispute_triage_ready.body'),
    link: `/admin/disputes/${d.disputeId}?triage=${d.triageId}`,
    values: { ref: d.orderNumber, rec, confidence: d.confidence },
  })
}

/**
 * S1.4 — a payout dossier is ready for the founder's one-tap. Sent to the ops
 * user (agent_settings.ops_user_id) once per dossier (the notify route claims
 * notified_at first).
 */
export async function notifyPayoutDossierReady(
  admin: Admin,
  d: { opsUserId: string; dossierId: string; orderNumber: string; amountPaise: number; recommendation: 'approve' | 'hold' },
): Promise<void> {
  const amount = formatPaise(d.amountPaise)
  await createNotification(admin, {
    userId: d.opsUserId,
    kind: 'payout_dossier_ready',
    titleI18n: notifyText('payout_dossier_ready.title', { amount, ref: d.orderNumber, rec: d.recommendation }),
    bodyI18n: notifyText('payout_dossier_ready.body'),
    link: `/admin/payouts?dossier=${d.dossierId}`,
    values: { amount, ref: d.orderNumber, rec: d.recommendation },
  })
}
