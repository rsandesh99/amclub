import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import type { MilestoneKind } from '@amclub/shared'
import { createNotification } from './create'
import { notifyText } from '@/lib/i18n/notify'

type Admin = Awaited<ReturnType<typeof createAdminClient>>
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

/**
 * Order placed (payment captured → order materialised). Notifies the provider
 * ("new order, please accept") and confirms to the buyer. Best-effort.
 */
export async function notifyOrderPlaced(admin: Admin, orderId: string): Promise<void> {
  const { data: order } = await admin.from('orders').select('*').eq('id', orderId).maybeSingle()
  if (!order) return
  const { msmeUserId, providerUserId } = await parties(admin, order)
  const r = ref(order)
  if (providerUserId) {
    await createNotification(admin, {
      userId: providerUserId,
      kind: 'order_placed',
      titleI18n: notifyText('order_placed_provider.title'),
      bodyI18n: notifyText('order_placed_provider.body', { ref: r }),
      link: `/partner/orders/${orderId}`,
      channels: ['email', 'sms', 'whatsapp'],
    })
  }
  if (msmeUserId) {
    await createNotification(admin, {
      userId: msmeUserId,
      kind: 'order_placed',
      titleI18n: notifyText('order_placed_buyer.title'),
      bodyI18n: notifyText('order_placed_buyer.body', { ref: r }),
      link: `/app/orders/${orderId}`,
      channels: ['email'],
    })
  }
}

interface EventCopy {
  to: 'msme' | 'provider'
  kind: string
  /** The `notify.<key>` pair (title / body with {ref}). */
  key: string
  channels: string[]
}

/** Per-action notification copy + recipient. One place; mirrors §3.7 actions. Copy: messages `notify.*` (E14). */
function copyFor(action: string): EventCopy | null {
  switch (action) {
    case 'accept':
      return { to: 'msme', kind: 'order_accepted', key: 'order_accepted', channels: ['email', 'sms'] }
    case 'submit_requirements':
      return { to: 'provider', kind: 'requirements_submitted', key: 'requirements_submitted', channels: ['email'] }
    case 'start':
      return { to: 'msme', kind: 'order_in_progress', key: 'order_started', channels: ['email'] }
    case 'deliver':
      return { to: 'msme', kind: 'order_delivered', key: 'order_delivered', channels: ['email', 'sms'] }
    case 'accept_delivery':
      return { to: 'provider', kind: 'order_completed', key: 'order_completed', channels: ['email', 'sms'] }
    case 'request_revision':
      return { to: 'provider', kind: 'revision_requested', key: 'revision_requested', channels: ['email'] }
    case 'resume':
      return { to: 'msme', kind: 'order_in_progress', key: 'revision_in_progress', channels: ['email'] }
    case 'cancel':
      return { to: 'provider', kind: 'order_cancelled', key: 'order_cancelled', channels: ['email'] }
    default:
      return null
  }
}

/**
 * Notify the counterparty after a buyer/provider-driven order transition.
 * `accept_delivery` also fires the review prompt to the buyer (separately).
 */
export async function notifyOrderTransition(admin: Admin, order: any, action: string): Promise<void> {
  const c = copyFor(action)
  if (!c) {
    if (action === 'raise_dispute') await notifyDispute(admin, order)
    return
  }
  const { msmeUserId, providerUserId } = await parties(admin, order)
  const userId = c.to === 'msme' ? msmeUserId : providerUserId
  if (userId) {
    await createNotification(admin, {
      userId,
      kind: c.kind,
      titleI18n: notifyText(`${c.key}.title`),
      bodyI18n: notifyText(`${c.key}.body`, { ref: ref(order) }),
      link: c.to === 'msme' ? `/app/orders/${order.id}` : `/partner/orders/${order.id}`,
      channels: c.channels,
    })
  }
  if (action === 'accept_delivery') await notifyReviewPrompt(admin, order)
}

async function notifyDispute(admin: Admin, order: any): Promise<void> {
  const { msmeUserId, providerUserId } = await parties(admin, order)
  const both = [msmeUserId, providerUserId].filter(Boolean) as string[]
  for (const userId of both) {
    await createNotification(admin, {
      userId,
      kind: 'order_disputed',
      titleI18n: notifyText('order_disputed.title'),
      bodyI18n: notifyText('order_disputed.body', { ref: ref(order) }),
      link: userId === msmeUserId ? `/app/orders/${order.id}` : `/partner/orders/${order.id}`,
      channels: ['email'],
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
    channels: ['email'],
  })
}

/** Services evidence engine (S0.3): notify the buyer on each milestone. Best-effort.
 *  WhatsApp is added once S0.5 lands (email + in-app for now). */
export async function notifyMilestone(admin: Admin, order: any, kind: MilestoneKind): Promise<void> {
  const { msmeUserId } = await parties(admin, order)
  if (!msmeUserId) return
  const label = notifyText(`milestone_label.${kind}`)
  await createNotification(admin, {
    userId: msmeUserId,
    kind: 'milestone_added',
    titleI18n: notifyText('milestone.title', { label }),
    bodyI18n: notifyText('milestone.body', { ref: ref(order), label }),
    link: `/app/orders/${order.id}`,
    channels: ['email'],
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
    link: `/app/orders/${order.id}`,
    channels: ['email'],
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
      link: `/app/orders/${order.id}`,
      channels: ['email', 'sms'],
    })
  }
  if (providerUserId) {
    await createNotification(admin, {
      userId: providerUserId,
      kind: 'order_auto_cancelled',
      titleI18n: notifyText('auto_cancelled_provider.title'),
      bodyI18n: notifyText('auto_cancelled_provider.body', { ref: ref(order) }),
      link: `/partner/orders/${order.id}`,
      channels: ['email'],
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
      link: `/partner/orders/${order.id}`,
      channels: ['email'],
    })
  }
  if (msmeUserId) {
    await createNotification(admin, {
      userId: msmeUserId,
      kind: 'order_auto_accepted',
      titleI18n: notifyText('auto_accepted_buyer.title'),
      bodyI18n: notifyText('auto_accepted_buyer.body', { ref: ref(order) }),
      link: `/app/orders/${order.id}`,
      channels: ['email'],
    })
  }
  await notifyReviewPrompt(admin, order)
}

/** A provider withdrew their quote on the buyer's RFQ. In-app + SMS, like a new / revised quote. */
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
    channels: ['sms'],
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
    channels: ['email'],
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

/** Provider payout marked paid (payouts cron). */
export async function notifyPayoutPaid(admin: Admin, providerId: string, amountPaise: number, orderId: string): Promise<void> {
  const { data: p } = await admin.from('provider_profiles').select('user_id').eq('id', providerId).maybeSingle()
  if (!p?.user_id) return
  const rupees = (amountPaise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })
  await createNotification(admin, {
    userId: p.user_id,
    kind: 'payout_paid',
    titleI18n: notifyText('payout_paid.title'),
    bodyI18n: notifyText('payout_paid.body', { amount: rupees }),
    link: orderId ? `/partner/orders/${orderId}` : `/partner/earnings`,
    channels: ['email', 'sms'],
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
    link: `/app/orders/${review.order_id}`,
    channels: ['email'],
  })
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * S1.7 — a party stated their side on an open dispute: the counter-party is
 * told (in-app + email) and the ops user in-app when set. Never the body.
 */
export async function notifyDisputeStatement(
  admin: Admin,
  d: { order: { id: string; order_number: string; msme_id: string; provider_id: string }; disputeId: string; role: 'buyer' | 'provider'; edited: boolean },
): Promise<void> {
  const { msmeUserId, providerUserId } = await parties(admin, d.order)
  const counterparty = d.role === 'buyer' ? providerUserId : msmeUserId
  const r = ref(d.order)
  const who = d.role === 'buyer' ? { en: 'The buyer', hi: 'खरीदार' } : { en: 'The provider', hi: 'प्रदाता' }
  if (counterparty) {
    await createNotification(admin, {
      userId: counterparty,
      kind: 'dispute_statement',
      titleI18n: notifyText('dispute_statement.title', { who: d.role, edited: d.edited ? 'yes' : 'no', ref: r }),
      bodyI18n: notifyText('dispute_statement.body'),
      link: d.role === 'buyer' ? `/partner/orders/${d.order.id}` : `/app/orders/${d.order.id}`,
      channels: ['email'],
    })
  }
  const { data: ops } = await admin.from('agent_settings').select('value').eq('key', 'ops_user_id').maybeSingle()
  const opsUserId = typeof ops?.value === 'string' ? ops.value : null
  if (opsUserId) {
    await createNotification(admin, {
      userId: opsUserId,
      kind: 'dispute_statement',
      titleI18n: { en: `${who.en} stated their side on ${r}`, hi: `${who.hi} ने ${r} पर पक्ष दर्ज किया` },
      bodyI18n: { en: 'Open the dispute console to read both statements.', hi: 'दोनों पक्ष पढ़ने के लिए विवाद कंसोल खोलें।' },
      link: `/admin/disputes/${d.disputeId}`,
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
    titleI18n: { en: `Dispute triage for ${d.orderNumber} — suggests: ${rec} (${d.confidence})`, hi: `${d.orderNumber} का विवाद ट्रायेज — सुझाव: ${rec} (${d.confidence})` },
    bodyI18n: { en: 'The card lists the timeline, each party\'s claims with evidence and the gaps. Nothing is resolved until you click.', hi: 'कार्ड में समयरेखा, दोनों पक्षों के दावे और साक्ष्य, और कमियाँ हैं। आपके क्लिक के बिना कुछ नहीं बदलेगा।' },
    link: `/admin/disputes/${d.disputeId}?triage=${d.triageId}`,
    channels: ['email', 'whatsapp'],
  })
}

/**
 * S1.4 — a payout dossier is ready for the founder's one-tap. Sent to the ops
 * user (agent_settings.ops_user_id) once per dossier (the notify route claims
 * notified_at first). Channels by KIND: email today; WhatsApp the moment the
 * S0.5 rails are live (template payout_dossier_ready, opt-in gated).
 */
export async function notifyPayoutDossierReady(
  admin: Admin,
  d: { opsUserId: string; dossierId: string; orderNumber: string; amountPaise: number; recommendation: 'approve' | 'hold' },
): Promise<void> {
  const rupees = `₹${(d.amountPaise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
  const recEn = d.recommendation === 'approve' ? 'approve' : 'hold'
  const recHi = d.recommendation === 'approve' ? 'स्वीकृत करें' : 'रोकें'
  await createNotification(admin, {
    userId: d.opsUserId,
    kind: 'payout_dossier_ready',
    titleI18n: { en: `Payout ${rupees} for ${d.orderNumber} — recommendation: ${recEn}`, hi: `${d.orderNumber} का भुगतान ${rupees} — सिफ़ारिश: ${recHi}` },
    bodyI18n: {
      en: `The evidence dossier is ready. Approve releases the payout; Hold keeps it held. Nothing moves until you tap.`,
      hi: `साक्ष्य डोज़ियर तैयार है। स्वीकृत करने पर भुगतान जारी होगा; रोकने पर रुका रहेगा। आपके टैप के बिना कुछ नहीं बदलेगा।`,
    },
    link: `/admin/payouts?dossier=${d.dossierId}`,
    channels: ['email', 'whatsapp'],
  })
}
