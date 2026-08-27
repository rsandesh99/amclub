import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import { createNotification, createNotificationsBulk } from '@/lib/notifications/create'
import { addQuoteEvent, addQuoteEvents } from './events'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * Runs when a QUOTE-sourced order materialises (called from the payment
 * materialize path, so it covers both the webhook and the reconciliation cron).
 * Idempotent: marks the accepted quote `accepted`, auto-declines the other
 * submitted quotes politely, moves the RFQ → `accepted`, and notifies everyone.
 * No-op for package orders or if the RFQ is already accepted.
 */
export async function finalizeQuoteAcceptance(admin: Admin, orderId: string): Promise<void> {
  const { data: order } = await admin
    .from('orders')
    .select('id, source, quote_id')
    .eq('id', orderId)
    .maybeSingle()
  if (!order || order.source !== 'quote' || !order.quote_id) return

  const { data: quote } = await admin
    .from('quotes')
    .select('id, rfq_id, provider_id')
    .eq('id', order.quote_id)
    .maybeSingle()
  if (!quote) return

  // Claim the RFQ atomically — only the first finalize proceeds (idempotent).
  const { data: claimed } = await admin
    .from('rfqs')
    .update({ status: 'accepted', updated_at: new Date().toISOString() })
    .eq('id', quote.rfq_id)
    .neq('status', 'accepted')
    .select('id, msme_id, title')
    .maybeSingle()
  if (!claimed) return // someone else already finalised

  // Accept the winning quote.
  await admin.from('quotes').update({ status: 'accepted', updated_at: new Date().toISOString() }).eq('id', quote.id)
  // The acceptance is the buyer's paid checkout, recorded via the payment path
  // (no interactive actor here) — attribute to system with the order as proof.
  await addQuoteEvent(admin, {
    quoteId: quote.id,
    eventType: 'accepted',
    reason: 'order_paid',
    payload: { order_id: orderId, rfq_id: quote.rfq_id },
  })

  // Politely decline the rest (still 'submitted').
  const { data: declined } = await admin
    .from('quotes')
    .update({ status: 'declined', updated_at: new Date().toISOString() })
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
}
