import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { quoteMessageSchema, redactContactInfo } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { createNotification } from '@/lib/notifications/create'
import { serverError } from '@/lib/api/errors'

/** Resolve the quote thread + verify the caller is a party (buyer or the quote's
 *  provider). Returns the conversation context + the counterparty user id. */
async function loadThread(admin: Awaited<ReturnType<typeof createAdminClient>>, quoteId: string, userId: string) {
  const { data: quote } = await admin
    .from('quotes')
    .select('id, provider_id, rfq_id, rfq:rfqs!inner(id, title, msme_id, msme:msme_profiles!inner(user_id)), provider:provider_profiles!inner(user_id)')
    .eq('id', quoteId)
    .maybeSingle()
  if (!quote) return null
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = quote as any
  const msmeId: string = q.rfq.msme_id
  const buyerUserId: string = q.rfq.msme.user_id
  const providerUserId: string = q.provider.user_id
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const actor = await resolveActor(admin, userId)
  const isBuyer = actor.msmeId === msmeId
  const isProvider = actor.providerId === quote.provider_id
  if (!isBuyer && !isProvider) return null
  return {
    quoteId,
    msmeId,
    providerId: quote.provider_id as string,
    rfqId: quote.rfq_id as string,
    rfqTitle: q.rfq.title as string,
    counterpartyUserId: isBuyer ? providerUserId : buyerUserId,
    /** Who receives the notification — decides which app surface the link opens. */
    counterpartyRole: (isBuyer ? 'provider' : 'buyer') as 'provider' | 'buyer',
  }
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ quoteId: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // S2.2 — a reply scope implies reading the thread it replies to (Munshi's follow-up); no-op for sessions.
  const scope = await requireToolScope(['reply_thread', 'support_lookup'])
  if (scope) return scope
  const { quoteId } = await params
  const admin = await createAdminClient()
  const thread = await loadThread(admin, quoteId, userId)
  if (!thread) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data: convo } = await admin
    .from('conversations')
    .select('id')
    .eq('context_type', 'quote')
    .eq('context_id', quoteId)
    .maybeSingle()
  if (!convo) return NextResponse.json({ messages: [] })

  const { data: messages } = await admin
    .from('messages')
    .select('id, sender_id, body, redacted, created_at')
    .eq('conversation_id', convo.id)
    .order('created_at', { ascending: true })

  return NextResponse.json({
    messages: (messages ?? []).map((m) => ({
      id: m.id,
      mine: m.sender_id === userId,
      body: m.body,
      redacted: m.redacted,
      createdAt: m.created_at,
    })),
  })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ quoteId: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // S2.2 the provider's Munshi reply · S3.1 the buyer's procurement question (message_provider) — the S2.3 list form
  const scope = await requireToolScope(['reply_thread', 'message_provider'])
  if (scope) return scope
  const { quoteId } = await params
  const admin = await createAdminClient()
  const thread = await loadThread(admin, quoteId, userId)
  if (!thread) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await request.json().catch(() => null)
  const parsed = quoteMessageSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  // §9.3 — mask phone/email BEFORE storing (anti-disintermediation, pre-payment).
  const { text, redacted } = redactContactInfo(parsed.data.body)

  // One conversation per quote (unique on context_type+context_id).
  const { data: convo, error: convoErr } = await admin
    .from('conversations')
    .upsert(
      { context_type: 'quote', context_id: quoteId, msme_id: thread.msmeId, provider_id: thread.providerId },
      { onConflict: 'context_type,context_id', ignoreDuplicates: false },
    )
    .select('id')
    .single()
  if (convoErr || !convo) return serverError('[quote message convo]', convoErr)

  const { data: message, error: msgErr } = await admin
    .from('messages')
    .insert({ conversation_id: convo.id, sender_id: userId, body: text, redacted })
    .select('id, created_at')
    .single()
  if (msgErr || !message) return serverError('[quote message insert]', msgErr)

  await createNotification(admin, {
    userId: thread.counterpartyUserId,
    kind: 'quote_message',
    titleI18n: { en: 'New message on a quote', hi: 'कोटेशन पर नया संदेश' },
    bodyI18n: { en: thread.rfqTitle, hi: thread.rfqTitle },
    // Role-aware deep link: the provider's RFQ page for a provider, the buyer's compare view for a buyer.
    link: thread.counterpartyRole === 'provider' ? `/partner/rfqs/${thread.rfqId}` : `/app/rfq/${thread.rfqId}`,
  })

  return NextResponse.json({ id: message.id, body: text, redacted, mine: true, createdAt: message.created_at })
}
