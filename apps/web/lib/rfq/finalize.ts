import 'server-only'
import { AGENT_ENABLED } from '@/lib/flags'
import { canTransitionQuote, isValidOrderTransition, QUOTE_STATUS, RFQ_LIVE_STATUSES } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { createNotification, createNotificationsBulk } from '@/lib/notifications/create'
import { addEvent, processRefund } from '@/lib/orders/transitions'
import { writeAudit } from '@/lib/audit/log'
import { reportOpsError, reportOpsIssue } from '@/lib/observability'
import { addQuoteEvent, addQuoteEvents } from './events'
import { labelLostQuotes } from './loss-labels'
import { shadowAtAcceptance } from '@/lib/shadow'
import { optionForOrder } from './quote-options'
import { notifyText, sameText } from '@/lib/i18n/notify'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * What finalize did with the order:
 * - `finalized` — this order won the RFQ (quote accepted, siblings declined).
 * - `noop` — not a quote order, or a replay of the winner.
 * - `duplicate_flagged` — a second paid order on an already-accepted RFQ;
 *   cancelled and refunded in full at once (ADR-014 §7), or left for ops if
 *   that cannot complete (see handleDuplicateRfqOrder).
 * - `rfq_not_live` — ADR 027 (audit M21): the RFQ closed (cancelled / expired)
 *   while the checkout was open. It is never moved to `accepted` (the RFQ state
 *   machine has no such edge); the paid order stands as an ordinary `placed`
 *   order (the provider may accept it, or the 24 h auto-cancel refunds it in
 *   full) and ops sees `rfq_not_live_at_payment`.
 */
export type FinalizeResult = 'finalized' | 'noop' | 'duplicate_flagged' | 'rfq_not_live'

/**
 * Runs when a QUOTE-sourced order materialises (called from the payment
 * materialize path, so it covers both the webhook and the reconciliation cron).
 * Idempotent: marks the accepted quote `accepted`, auto-declines the other
 * submitted quotes politely, moves the RFQ → `accepted`, and notifies everyone.
 * No-op for package orders or a replay of the winning order. A SECOND paid
 * order on an already-accepted RFQ (P0-5 race) is never left silently: it is
 * recorded for an ops refund (see handleDuplicateRfqOrder).
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
    .select('id, rfq_id, provider_id, status')
    .eq('id', order.quote_id)
    .maybeSingle()
  if (!quote) return 'noop'
  // The buyer paid for a quote that is no longer live (e.g. withdrawn or expired
  // while a checkout session was open). The payment stands — never drop a paid
  // order — but ops must see it.
  if (quote.status !== QUOTE_STATUS.submitted && quote.status !== QUOTE_STATUS.accepted) {
    const detail = { quote_id: quote.id, quote_status: quote.status, rfq_id: quote.rfq_id }
    await addEvent(admin, orderId, 'quote_not_live_at_payment', null, detail)
    await writeAudit(admin, null, { actorId: null, action: 'quote_not_live_at_payment', entity: 'orders', entityId: orderId, after: detail })
    console.error('[finalize] paid order on a quote that is no longer live', orderId, detail)
  }

  // Claim the RFQ atomically — only the first finalize proceeds (idempotent).
  // ADR 027 (M21): only a LIVE RFQ (open | quoted) may become accepted.
  const { data: claimed } = await admin
    .from('rfqs')
    .update({ status: 'accepted', updated_at: new Date().toISOString() })
    .eq('id', quote.rfq_id)
    .in('status', [...RFQ_LIVE_STATUSES])
    .select('id, msme_id, title')
    .maybeSingle()
  if (!claimed) {
    const { data: rfqNow } = await admin.from('rfqs').select('status').eq('id', quote.rfq_id).maybeSingle()
    const rfqStatus = (rfqNow as { status?: string } | null)?.status
    if (rfqStatus && rfqStatus !== 'accepted') {
      const { data: flagged } = await admin.from('order_events').select('id').eq('order_id', orderId).eq('event', 'rfq_not_live_at_payment').limit(1)
      if (!(flagged ?? []).length) {
        const detail = { rfq_id: quote.rfq_id, rfq_status: rfqStatus, quote_id: quote.id }
        await addEvent(admin, orderId, 'rfq_not_live_at_payment', null, detail)
        await writeAudit(admin, null, { actorId: null, action: 'rfq_not_live_at_payment', entity: 'orders', entityId: orderId, after: detail })
        console.error('[finalize] paid order on an RFQ that is no longer live', orderId, detail)
      }
      return 'rfq_not_live'
    }
    const result = await handleDuplicateRfqOrder(admin, orderId, quote.rfq_id as string)
    // E7 (N22) — a replay of the winning order completes loss labels an interrupted pass missed
    // (labelLostQuotes writes only missing rows, checks the winner itself, never throws).
    if (result === 'noop') {
      const option = await optionForOrder(admin, orderId)
      await labelLostQuotes(admin, { rfqId: quote.rfq_id as string, acceptedQuoteId: quote.id, ...(option ? { winnerTerms: { pricePaise: option.pricePaise, deliveryDays: option.deliveryDays } } : {}) })
      await shadowAtAcceptance(admin, { rfqId: quote.rfq_id as string, acceptedQuoteId: quote.id })
    }
    return result
  }

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
  // E12b / ADR 020 — the option the buyer paid for (from the frozen session; null = Standard). Best-effort,
  // a separate write so the acceptance above never names a 0066 column.
  const option = await optionForOrder(admin, orderId)
  if (option) {
    const { error: optErr } = await admin.from('quotes').update({ selected_option_id: option.id }).eq('id', quote.id)
    if (optErr) console.warn('[finalize] selected_option_id', optErr.message)
  }
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
  // E7 (N22) — one `lost` label per passed-over quote, deltas against the winner (E12b: its winning option). Best-effort, outside the money path.
  await labelLostQuotes(admin, { rfqId: quote.rfq_id as string, acceptedQuoteId: quote.id, ...(option ? { winnerTerms: { pricePaise: option.pricePaise, deliveryDays: option.deliveryDays } } : {}) })
  // E15 F10 — resolve the RFQ's shadow predictions (price band vs the winner, fit vs quoted). Best-effort, shown to nobody.
  await shadowAtAcceptance(admin, { rfqId: quote.rfq_id as string, acceptedQuoteId: quote.id })

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
      titleI18n: notifyText('quote_accepted.title'),
      bodyI18n: sameText(claimed.title),
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
      titleI18n: notifyText('quote_lost.title'),
      bodyI18n: sameText(claimed.title),
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
 * is recorded ONCE (order_event `duplicate_rfq_order` + audit row) and then
 * settled: ADR-014 §7 gives it its own state, `placed → cancelled_duplicate →
 * refunded`, with a full refund through the one refund engine. The provider is
 * never told to start it (materialize skips the new-order notice). Anything
 * that cannot complete (the provider acted first, the refund engine reports a
 * different amount, the gateway fails) is left flagged for ops, as before.
 */
async function handleDuplicateRfqOrder(admin: Admin, orderId: string, rfqId: string): Promise<FinalizeResult> {
  const winnerId = await winningOrderId(admin, rfqId)
  if (winnerId === orderId) return 'noop' // replay of the winner

  const { data: order } = await admin
    .from('orders')
    .select('id, msme_id, quote_id, status, total_paise, order_number')
    .eq('id', orderId)
    .maybeSingle()
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

  // Settle on every pass (idempotent), so a replay finishes an interrupted one.
  const refunded = await settleDuplicateRfqOrder(admin, order)
  if (marked) return 'duplicate_flagged' // already announced — replay

  const { data: msme } = await admin.from('msme_profiles').select('user_id').eq('id', order.msme_id).maybeSingle()
  if (msme?.user_id) {
    await createNotification(admin, {
      userId: msme.user_id as string,
      kind: 'order_duplicate_payment',
      titleI18n: notifyText('duplicate_payment.title'),
      bodyI18n: notifyText(refunded ? 'duplicate_payment.body_refunded' : 'duplicate_payment.body_pending', { ref: String(order.order_number) }),
      link: `/app/orders/${orderId}`,
      channels: ['email', 'sms'],
    })
  }
  return 'duplicate_flagged'
}

/**
 * ADR-014 §7 — cancel a duplicate and refund it in full: `placed →
 * cancelled_duplicate` (guarded; the provider accepting first leaves it to
 * ops), then processRefund computed from `placed` (100 %), read back, then
 * `cancelled_duplicate → refunded`. Idempotent: every write is guarded on the
 * state it expects and the refund is key-guarded. Returns true once refunded.
 */
async function settleDuplicateRfqOrder(
  admin: Admin,
  order: { id: string; status: string; total_paise: number | string },
): Promise<boolean> {
  if (!isValidOrderTransition('placed', 'cancelled_duplicate') || !isValidOrderTransition('cancelled_duplicate', 'refunded')) {
    throw new Error('ORDER_TRANSITIONS drift: placed → cancelled_duplicate → refunded must be allowed')
  }
  if (order.status === 'refunded') return true
  const nowIso = () => new Date().toISOString()
  if (order.status === 'placed') {
    const { data: moved } = await admin
      .from('orders')
      .update({ status: 'cancelled_duplicate', cancelled_reason: 'duplicate_rfq_order', updated_at: nowIso() })
      .eq('id', order.id)
      .eq('status', 'placed')
      .select('id')
    if (!moved || moved.length === 0) return false // someone acted first — ops handles it
    await addEvent(admin, order.id, 'cancelled_duplicate', null, { reason: 'duplicate_rfq_order' })
  } else if (order.status !== 'cancelled_duplicate') {
    return false // accepted or beyond — out of the automatic path, flagged for ops
  }

  const totalPaise = Number(order.total_paise)
  try {
    const refundedPaise = await processRefund(admin, order, 'placed')
    if (refundedPaise !== totalPaise) {
      // ADR-014 H4: never record a refund that did not happen.
      console.error('[finalize] duplicate refund mismatch — ops must check', order.id, { expected: totalPaise, refundedPaise })
      reportOpsIssue('duplicate RFQ order refund mismatch', 'refund_failed', { level: 'error', tags: { order_id: order.id }, extra: { expected_paise: totalPaise, refunded_paise: refundedPaise } })
      await writeAudit(admin, null, { actorId: null, action: 'duplicate_rfq_refund_mismatch', entity: 'orders', entityId: order.id, after: { expected_paise: totalPaise, refunded_paise: refundedPaise } })
      return false
    }
  } catch (e) {
    console.error('[finalize] duplicate refund failed — ops must refund', order.id, (e as Error).message)
    reportOpsError(e, 'refund_failed', { tags: { order_id: order.id, reason: 'duplicate_rfq_order' } })
    await writeAudit(admin, null, { actorId: null, action: 'duplicate_rfq_refund_failed', entity: 'orders', entityId: order.id, after: { error: (e as Error).message } })
    return false
  }

  await admin.from('orders').update({ status: 'refunded', updated_at: nowIso() }).eq('id', order.id).eq('status', 'cancelled_duplicate')
  await addEvent(admin, order.id, 'refunded', null, { amount_paise: totalPaise, reason: 'duplicate_rfq_order' })
  return true
}
