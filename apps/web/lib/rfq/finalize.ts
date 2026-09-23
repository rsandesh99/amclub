import 'server-only'
import { AGENT_ENABLED } from '@/lib/flags'
import { canTransitionQuote, isValidOrderTransition } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { createNotification, createNotificationsBulk } from '@/lib/notifications/create'
import { addEvent, processRefund } from '@/lib/orders/transitions'
import { writeAudit } from '@/lib/audit/log'
import { addQuoteEvent, addQuoteEvents } from './events'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * What finalize did with the order:
 * - `finalized` — this order won the RFQ (quote accepted, siblings declined).
 * - `noop` — not a quote order, or a replay of the winner.
 * - `duplicate_refunded` — a second paid order on an already-accepted RFQ was
 *   cancelled (placed → auto_cancelled, reason duplicate_rfq_order) and fully
 *   refunded through processRefund.
 * - `duplicate_flagged` — a duplicate that could not be safely auto-refunded
 *   (no longer `placed`, or the winner is unknown); recorded for ops.
 */
export type FinalizeResult = 'finalized' | 'noop' | 'duplicate_refunded' | 'duplicate_flagged'

/**
 * Runs when a QUOTE-sourced order materialises (called from the payment
 * materialize path, so it covers both the webhook and the reconciliation cron).
 * Idempotent: marks the accepted quote `accepted`, auto-declines the other
 * submitted quotes politely, moves the RFQ → `accepted`, and notifies everyone.
 * No-op for package orders or a replay of the winning order. A SECOND paid
 * order on an already-accepted RFQ (P0-5 race) is never left silently: it is
 * recorded and refunded (see handleDuplicateRfqOrder).
 */
export async function finalizeQuoteAcceptance(admin: Admin, orderId: string): Promise<FinalizeResult> {
  const { data: order } = await admin
    .from('orders')
    .select('id, source, quote_id')
    .eq('id', orderId)
    .maybeSingle()
  if (!order || order.source !== 'quote' || !order.quote_id) return 'noop'

  const { data: quote } = await admin
    .from('quotes')
    .select('id, rfq_id, provider_id')
    .eq('id', order.quote_id)
    .maybeSingle()
  if (!quote) return 'noop'

  // Claim the RFQ atomically — only the first finalize proceeds (idempotent).
  const { data: claimed } = await admin
    .from('rfqs')
    .update({ status: 'accepted', updated_at: new Date().toISOString() })
    .eq('id', quote.rfq_id)
    .neq('status', 'accepted')
    .select('id, msme_id, title')
    .maybeSingle()
  if (!claimed) return handleDuplicateRfqOrder(admin, orderId, quote.rfq_id as string)

  // The acceptance is the buyer's paid checkout, recorded via the payment path
  // (no interactive actor here) — attribute to system with the order as proof.
  // Written FIRST after the claim: its payload.order_id is how a racing second
  // order learns which order won (handleDuplicateRfqOrder).
  await addQuoteEvent(admin, {
    quoteId: quote.id,
    eventType: 'accepted',
    reason: 'order_paid',
    payload: { order_id: orderId, rfq_id: quote.rfq_id },
  })

  // Accept the winning quote.
  await admin.from('quotes').update({ status: 'accepted', updated_at: new Date().toISOString() }).eq('id', quote.id)
  // S2.2 — mark the winner's price-book row accepted (Munshi prefers accepted rows as its basis). The row exists
  // only while the agent programme is on (recordPriceBookEntry), so this is gated the same way; best-effort.
  if (AGENT_ENABLED) {
    const { error: pbErr } = await admin.from('provider_price_book').update({ accepted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('source_quote_id', quote.id).is('accepted_at', null)
    if (pbErr) console.warn('[finalize] price-book accepted_at', pbErr.message)
  }

  // Politely decline the rest (still 'submitted'). S1.2: the .eq('status',
  // 'submitted') guard IS the QUOTE_TRANSITIONS rule (submitted → declined);
  // assert it against the one map without changing behaviour, and stamp WHY.
  if (!canTransitionQuote('submitted', 'declined')) throw new Error('QUOTE_TRANSITIONS drift: submitted → declined must be allowed')
  const declinedAt = new Date().toISOString()
  const { data: declined } = await admin
    .from('quotes')
    .update({ status: 'declined', decline_reason: 'another_quote_accepted', declined_by: 'system', declined_at: declinedAt, updated_at: declinedAt })
    .eq('rfq_id', quote.rfq_id)
    .eq('status', 'submitted')
    .neq('id', quote.id)
    .select('id, provider_id')
  await addQuoteEvents(
    admin,
    (declined ?? []).map((q) => ({
      quoteId: q.id,
      eventType: 'auto_declined' as const,
      reason: 'another_quote_accepted',
      payload: { rfq_id: quote.rfq_id, accepted_quote_id: quote.id, order_id: orderId },
    })),
  )

  // Notify the winning provider, and the declined providers.
  const { data: winner } = await admin
    .from('provider_profiles')
    .select('user_id')
    .eq('id', quote.provider_id)
    .maybeSingle()
  if (winner?.user_id) {
    await createNotification(admin, {
      userId: winner.user_id,
      kind: 'quote_accepted',
      titleI18n: { en: 'Your quote was accepted', hi: 'आपका कोटेशन स्वीकार किया गया' },
      bodyI18n: { en: claimed.title, hi: claimed.title },
      link: '/partner/orders',
      channels: ['sms', 'whatsapp'],
    })
  }

  const declinedProviderIds = [...new Set((declined ?? []).map((d) => d.provider_id))]
  if (declinedProviderIds.length > 0) {
    const { data: provs } = await admin
      .from('provider_profiles')
      .select('user_id')
      .in('id', declinedProviderIds)
    const userIds = (provs ?? []).map((p) => p.user_id).filter(Boolean) as string[]
    await createNotificationsBulk(admin, userIds, {
      kind: 'quote_declined',
      titleI18n: {
        en: 'A request you quoted on was awarded to another provider',
        hi: 'जिस अनुरोध पर आपने कोटेशन दिया वह किसी अन्य प्रदाता को दिया गया',
      },
      bodyI18n: { en: claimed.title, hi: claimed.title },
      link: '/partner/rfqs',
    })
  }
  return 'finalized'
}

/**
 * The order that won the RFQ: the winner's quote_events.accepted row carries
 * it. RFQs accepted before that event existed fall back to the earliest order
 * on the RFQ's accepted quote. Null while neither is visible yet (a racing
 * loser can look a moment before the winner writes) — re-read briefly.
 */
async function winningOrderId(admin: Admin, rfqId: string): Promise<string | null> {
  const { data: quotes } = await admin.from('quotes').select('id, status').eq('rfq_id', rfqId)
  const rows = (quotes ?? []) as { id: string; status: string }[]
  const ids = rows.map((q) => q.id)
  if (ids.length === 0) return null
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: ev } = await admin
      .from('quote_events')
      .select('payload, created_at')
      .in('quote_id', ids)
      .eq('event_type', 'accepted')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    const id = (ev?.payload as { order_id?: string } | null)?.order_id
    if (id) return id
    const { data: acc } = await admin.from('quotes').select('id').eq('rfq_id', rfqId).eq('status', 'accepted').limit(1).maybeSingle()
    if (acc?.id) {
      const { data: first } = await admin.from('orders').select('id').eq('quote_id', acc.id).order('created_at', { ascending: true }).limit(1).maybeSingle()
      if (first?.id) return first.id as string
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 750))
  }
  return null
}

/**
 * P0-5 — the RFQ was already claimed when this order finalised. Either this is
 * a replay of the winning order (no-op), or a SECOND paid order materialised on
 * the same RFQ (two checkouts raced past the checkout-route guard). A duplicate
 * is recorded (order_event `duplicate_rfq_order` + audit row, once) and, while
 * it is still `placed`, cancelled on the canonical system-cancel transition
 * placed → auto_cancelled (cancelled_reason `duplicate_rfq_order`) and fully
 * refunded through processRefund — the one refund path, keyed rfnd_<order_id>,
 * so replays never refund twice. Anything else is left for ops (flagged).
 */
async function handleDuplicateRfqOrder(admin: Admin, orderId: string, rfqId: string): Promise<FinalizeResult> {
  const winnerId = await winningOrderId(admin, rfqId)
  if (winnerId === orderId) return 'noop' // replay of the winner

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const { data: row } = await admin.from('orders').select('*').eq('id', orderId).maybeSingle()
  const order = row as any
  if (!order) return 'noop'

  const { data: marked } = await admin
    .from('order_events')
    .select('id')
    .eq('order_id', orderId)
    .eq('event', 'duplicate_rfq_order')
    .limit(1)
    .maybeSingle()
  if (!marked) {
    const detail = { rfq_id: rfqId, quote_id: order.quote_id, winning_order_id: winnerId, status_at_detection: order.status, total_paise: order.total_paise }
    await addEvent(admin, orderId, 'duplicate_rfq_order', null, detail)
    await writeAudit(admin, null, { actorId: null, action: 'duplicate_rfq_order_detected', entity: 'orders', entityId: orderId, after: detail })
    console.error('[finalize] DUPLICATE paid order on an accepted RFQ', orderId, detail)
  }

  // Winner unknown → we cannot be sure THIS is the duplicate; never refund on a guess.
  if (!winnerId) return 'duplicate_flagged'

  let status = order.status as string
  if (status === 'placed') {
    if (!isValidOrderTransition('placed', 'auto_cancelled')) return 'duplicate_flagged'
    const nowIso = new Date().toISOString()
    const { data: moved } = await admin
      .from('orders')
      .update({ status: 'auto_cancelled', cancelled_reason: 'duplicate_rfq_order', updated_at: nowIso })
      .eq('id', orderId)
      .eq('status', 'placed') // guarded: a provider accept in between wins, and we flag instead
      .select('id')
    if (moved && moved.length > 0) {
      await addEvent(admin, orderId, 'auto_cancelled', null, { reason: 'duplicate_rfq_order', winning_order_id: winnerId })
      status = 'auto_cancelled'
    } else {
      const { data: now } = await admin.from('orders').select('status').eq('id', orderId).maybeSingle()
      status = (now?.status as string | undefined) ?? status
    }
  }
  if (status === 'refunded') return 'duplicate_refunded'
  // Only a duplicate WE cancelled is refunded here (a replay finishes a refund
  // an earlier run started; processRefund is idempotent on rfnd_<order_id>).
  if (status !== 'auto_cancelled') return 'duplicate_flagged'
  // Already auto_cancelled when we loaded it, for another reason (the 24h cron):
  // that path runs its own refund — do not race it.
  if (order.status === 'auto_cancelled' && order.cancelled_reason !== 'duplicate_rfq_order') return 'duplicate_flagged'

  const refunded = await processRefund(admin, { ...order, status: 'auto_cancelled' }, 'placed')
  if (refunded <= 0) return 'duplicate_flagged'
  const { data: done } = await admin.from('orders').update({ status: 'refunded' }).eq('id', orderId).eq('status', 'auto_cancelled').select('id')
  if (done && done.length > 0) {
    await addEvent(admin, orderId, 'refunded', null, { amount_paise: refunded, reason: 'duplicate_rfq_order' })
    const { data: msme } = await admin.from('msme_profiles').select('user_id').eq('id', order.msme_id).maybeSingle()
    if (msme?.user_id) {
      await createNotification(admin, {
        userId: msme.user_id as string,
        kind: 'order_auto_cancelled',
        titleI18n: { en: 'Duplicate payment refunded', hi: 'दोहरा भुगतान वापस किया गया' },
        bodyI18n: {
          en: `You paid twice for the same request. Order ${order.order_number} was cancelled and fully refunded; your other order stands.`,
          hi: `आपने एक ही अनुरोध के लिए दो बार भुगतान किया। ऑर्डर ${order.order_number} रद्द कर पूरी राशि वापस कर दी गई है; आपका दूसरा ऑर्डर जारी है।`,
        },
        link: `/app/orders/${orderId}`,
        channels: ['email', 'sms'],
      })
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return 'duplicate_refunded'
}
