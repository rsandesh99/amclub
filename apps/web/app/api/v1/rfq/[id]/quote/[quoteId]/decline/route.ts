import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { canTransitionQuote, quoteDeclineResponseSchema, quoteDeclineSchema, type QuoteStatus } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { addQuoteEvent } from '@/lib/rfq/events'
import { composeDeclineMessage, providerMessageLocale } from '@/lib/rfq/decline'
import { createNotification } from '@/lib/notifications/create'
import { captureServerEvent } from '@/lib/analytics/server'

/**
 * POST /api/v1/rfq/[id]/quote/[quoteId]/decline (S1.2 §4) — the first
 * buyer-initiated quotes.status write. Guarded on `submitted` (replay-safe)
 * and governed by QUOTE_TRANSITIONS; the provider gets a courteous message in
 * their language (agent or template) — a decline never depends on the model.
 * `chose_other` is reserved for the system path. quote_count is NOT
 * decremented (the cap counts submissions). Not flag-gated: an ordinary
 * product feature; only the message's authorship is.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; quoteId: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const scope = await requireToolScope('decline_quote')
  if (scope) return scope
  const { id: rfqId, quoteId } = await params

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.msmeId) return NextResponse.json({ error: 'not_a_buyer' }, { status: 403 })
  const rl = await enforce(limiters.authed, `quote-decline:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const parsed = quoteDeclineSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  if (parsed.data.reason === 'chose_other') return NextResponse.json({ error: 'reason_reserved' }, { status: 422 })
  const { reason } = parsed.data
  const note = parsed.data.note?.trim() ? parsed.data.note.trim() : null

  const { data: quote } = await admin.from('quotes').select('id, rfq_id, provider_id, status').eq('id', quoteId).eq('rfq_id', rfqId).maybeSingle()
  if (!quote) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { data: rfq } = await admin.from('rfqs').select('id, msme_id, status, title').eq('id', rfqId).maybeSingle()
  if (!rfq) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (rfq.msme_id !== actor.msmeId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (!canTransitionQuote(quote.status as QuoteStatus, 'declined')) {
    return NextResponse.json({ error: 'quote_not_declinable', status: quote.status }, { status: 409 })
  }
  if (rfq.status !== 'open' && rfq.status !== 'quoted') return NextResponse.json({ error: 'rfq_closed', status: rfq.status }, { status: 409 })

  // Guarded write (the pools rule): only the expected state moves; zero rows → 409.
  const now = new Date().toISOString()
  const { data: moved } = await admin
    .from('quotes')
    .update({ status: 'declined', decline_reason: reason, decline_note: note, declined_by: 'buyer', declined_at: now, updated_at: now })
    .eq('id', quoteId)
    .eq('status', 'submitted')
    .select('id')
  if (!moved || (moved as unknown[]).length === 0) return NextResponse.json({ error: 'quote_not_declinable', status: quote.status }, { status: 409 })

  await addQuoteEvent(admin, { quoteId, eventType: 'declined', actor: userId, reason, payload: { rfq_id: rfqId, note_len: note?.length ?? 0 } })

  // Message in the provider's language (agent when on for THIS buyer, else the template).
  const { locale, providerUserId } = await providerMessageLocale(admin, quote.provider_id)
  const composed = await composeDeclineMessage(admin, { quoteId, rfqId, reason, note, rfqTitle: rfq.title, locale, buyerUserId: userId })
  await admin
    .from('quotes')
    .update({ decline_message: composed.message, decline_message_locale: composed.locale, ...(composed.decisionId ? { decline_decision_id: composed.decisionId } : {}) })
    .eq('id', quoteId)

  if (providerUserId) {
    await createNotification(admin, {
      userId: providerUserId,
      kind: 'quote_declined',
      titleI18n: { en: 'An update on your quote', hi: 'आपके कोटेशन पर एक अपडेट' },
      bodyI18n: { en: composed.message, hi: composed.message },
      link: `/partner/rfqs/${rfqId}`,
      channels: ['whatsapp'],
    })
  }

  captureServerEvent(userId, 'quote_declined', { rfq_id: rfqId, quote_id: quoteId, reason, has_note: !!note, message_source: composed.source, locale: composed.locale, role: 'msme' })

  const body = quoteDeclineResponseSchema.parse({ quoteId, status: 'declined', message_pending: false })
  return NextResponse.json({ ...body, message_source: composed.source, message_locale: composed.locale })
}
