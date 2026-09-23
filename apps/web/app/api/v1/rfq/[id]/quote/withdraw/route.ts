import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { canTransitionQuote, QUOTE_STATUS, rfqIsActive, type QuoteStatus } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { addQuoteEvent } from '@/lib/rfq/events'
import { notifyQuoteWithdrawn } from '@/lib/notifications/events'
import { serverError } from '@/lib/api/errors'
import { captureServerEvent } from '@/lib/analytics/server'

/** Optional one-line reason, kept in quote_events only (never shown to the buyer). */
const withdrawSchema = z.object({ reason: z.string().trim().max(200).optional() }).strict()

/**
 * POST /api/v1/rfq/[id]/quote/withdraw — the provider takes back their OWN
 * submitted quote (QUOTE_TRANSITIONS: submitted → withdrawn). Guarded write on
 * `submitted` (replay-safe: a second call is a 409, nothing moves twice); the RFQ
 * must still be active; refused while the buyer holds a live checkout session on
 * this quote (they are paying for it). The quote slot is released so another
 * matched provider can quote. A withdrawn quote is terminal — the one-quote-per-
 * provider rule still holds. Human-only: no agent tool wraps this route.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('rfq.quote.withdraw')
  if (delegated) return delegated
  const { id: rfqId } = await params
  if (!z.string().uuid().safeParse(rfqId).success) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return NextResponse.json({ error: 'Not a provider' }, { status: 403 })

  const rl = await enforce(limiters.quoteSubmit, `quote:${actor.providerId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const parsed = withdrawSchema.safeParse((await request.json().catch(() => null)) ?? {})
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const reason = parsed.data.reason ? parsed.data.reason : null

  // Own quote on this RFQ (provider ownership is the provider_id filter).
  const { data: quote } = await admin
    .from('quotes')
    .select('id, status')
    .eq('rfq_id', rfqId)
    .eq('provider_id', actor.providerId)
    .maybeSingle()
  if (!quote) return NextResponse.json({ error: 'quote_not_found' }, { status: 404 })
  if (!canTransitionQuote(quote.status as QuoteStatus, QUOTE_STATUS.withdrawn)) {
    return NextResponse.json({ error: 'quote_not_withdrawable', status: quote.status }, { status: 409 })
  }

  const { data: rfq } = await admin.from('rfqs').select('id, status, expires_at').eq('id', rfqId).maybeSingle()
  if (!rfq || !rfqIsActive(rfq.status) || new Date(rfq.expires_at).getTime() <= Date.now()) {
    return NextResponse.json({ error: 'rfq_closed', status: rfq?.status ?? null }, { status: 409 })
  }

  // The buyer is mid-payment on this quote: withdrawing now would race the webhook.
  const nowIso = new Date().toISOString()
  const { data: live, error: liveErr } = await admin
    .from('checkout_sessions')
    .select('id')
    .eq('quote_id', quote.id)
    .eq('status', 'created')
    .gt('expires_at', nowIso)
    .limit(1)
  if (liveErr) return serverError('[quote withdraw] checkout lookup', liveErr)
  if (live && live.length > 0) return NextResponse.json({ error: 'checkout_in_progress' }, { status: 409 })

  // Guarded write: only a still-submitted quote moves; zero rows → someone else moved it first.
  const { data: moved, error: updErr } = await admin
    .from('quotes')
    .update({ status: QUOTE_STATUS.withdrawn, updated_at: nowIso })
    .eq('id', quote.id)
    .eq('status', QUOTE_STATUS.submitted)
    .select('id')
  if (updErr) return serverError('[quote withdraw]', updErr)
  if (!moved || moved.length === 0) return NextResponse.json({ error: 'quote_not_withdrawable' }, { status: 409 })

  // Give the slot back so the cap reflects live quotes (release_quote_slot, 0009; never below 0).
  const { error: relErr } = await admin.rpc('release_quote_slot', { p_rfq_id: rfqId })
  if (relErr) console.error('[quote withdraw] release_quote_slot failed', rfqId, relErr.message)

  await addQuoteEvent(admin, { quoteId: quote.id, eventType: 'withdrawn', actor: actor.userId, reason, payload: { rfq_id: rfqId } })

  await notifyQuoteWithdrawn(admin, rfqId)

  captureServerEvent(actor.userId, 'quote_withdrawn', { rfq_id: rfqId, quote_id: quote.id, has_reason: !!reason, role: 'provider' })

  return NextResponse.json({ quoteId: quote.id, status: QUOTE_STATUS.withdrawn })
}
