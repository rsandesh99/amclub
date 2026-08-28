import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { quoteSchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { createNotification } from '@/lib/notifications/create'
import { addQuoteEvent } from '@/lib/rfq/events'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'

const bodySchema = quoteSchema.omit({ rfq_id: true })

/** Provider submits ONE quote on a matched, active RFQ. The N-quote cap (7) is
 *  enforced atomically via claim_quote_slot — the 8th quote is rejected (409). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id: rfqId } = await params

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return NextResponse.json({ error: 'Not a provider' }, { status: 403 })

  const rl = await enforce(limiters.quoteSubmit, `quote:${actor.providerId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  // Provider must be matched to this RFQ (fan-out wrote the row).
  const { data: match } = await admin
    .from('rfq_matches')
    .select('rfq_id')
    .eq('rfq_id', rfqId)
    .eq('provider_id', actor.providerId)
    .maybeSingle()
  if (!match) return NextResponse.json({ error: 'Not matched to this request' }, { status: 403 })

  // One quote per provider per RFQ.
  const { data: existing } = await admin
    .from('quotes')
    .select('id')
    .eq('rfq_id', rfqId)
    .eq('provider_id', actor.providerId)
    .maybeSingle()
  if (existing) return NextResponse.json({ error: 'already_quoted' }, { status: 409 })

  // Atomically claim a slot (enforces cap + active + not expired; flips open→quoted).
  const { data: newCount, error: claimErr } = await admin.rpc('claim_quote_slot', { p_rfq_id: rfqId })
  if (claimErr) return serverError('[quote claim]', claimErr)
  if (newCount === null || newCount === undefined) {
    return NextResponse.json({ error: 'rfq_closed' }, { status: 409 }) // cap reached / closed / expired
  }

  const { data: quote, error: insErr } = await admin
    .from('quotes')
    .insert({
      rfq_id: rfqId,
      provider_id: actor.providerId,
      price_paise: d.price_paise,
      delivery_days: d.delivery_days,
      scope: d.scope,
      message: d.message ?? null,
      // Phase 4b — optional terms; absent → NULL ("not stated").
      gst_included: d.gst_included ?? null,
      transport_included: d.transport_included ?? null,
      valid_until: d.valid_until ?? null,
      advance_percent: d.advance_percent ?? null,
      status: 'submitted',
    })
    .select('id')
    .single()
  if (insErr || !quote) {
    // Lost a race (e.g. unique violation) — give the slot back so the count is honest.
    await admin.rpc('release_quote_slot', { p_rfq_id: rfqId })
    if ((insErr as { code?: string })?.code === '23505') {
      return NextResponse.json({ error: 'already_quoted' }, { status: 409 })
    }
    return serverError('[quote insert]', insErr)
  }
  await addQuoteEvent(admin, {
    quoteId: quote.id,
    eventType: 'submitted',
    actor: actor.userId,
    // History captures what was STATED at submission, including "not stated".
    payload: {
      rfq_id: rfqId,
      price_paise: d.price_paise,
      delivery_days: d.delivery_days,
      gst_included: d.gst_included ?? null,
      transport_included: d.transport_included ?? null,
      valid_until: d.valid_until ?? null,
      advance_percent: d.advance_percent ?? null,
    },
  })

  // Notify the buyer of the new quote.
  const { data: rfq } = await admin
    .from('rfqs')
    .select('title, msme:msme_profiles!inner(user_id)')
    .eq('id', rfqId)
    .maybeSingle()
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const buyerUserId = (rfq as any)?.msme?.user_id as string | undefined
  /* eslint-enable @typescript-eslint/no-explicit-any */
  if (buyerUserId) {
    await createNotification(admin, {
      userId: buyerUserId,
      kind: 'rfq_new_quote',
      titleI18n: { en: 'New quote received', hi: 'नया कोटेशन प्राप्त हुआ' },
      bodyI18n: { en: (rfq as { title: string }).title, hi: (rfq as { title: string }).title },
      link: `/app/rfq/${rfqId}`,
      channels: ['sms'],
    })
  }

  return NextResponse.json({ quoteId: quote.id, quoteCount: newCount })
}
