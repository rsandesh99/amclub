import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { rfqDeclineSchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'

/**
 * Quote-or-decline (S0.4). A matched provider declines an RFQ with a reason so
 * the buyer sees an honest count ("2 of 5 could not take this up") and the
 * provider's score treats it as a decision, not silence. Idempotent: a second
 * decline of the same match is a no-op 200. Providers with a submitted quote
 * cannot decline (withdraw the quote instead). Service-role write after the
 * party check; rfq_matches.declined_at is the source of truth.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id: rfqId } = await params
  const rl = await enforce(limiters.authed, `rfq-decline:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const parsed = rfqDeclineSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return NextResponse.json({ error: 'Only providers can decline' }, { status: 403 })

  const { data: match } = await admin
    .from('rfq_matches')
    .select('rfq_id, declined_at, rfq:rfqs!inner(id, status)')
    .eq('rfq_id', rfqId)
    .eq('provider_id', actor.providerId)
    .maybeSingle()
  if (!match) return NextResponse.json({ error: 'Not matched to this RFQ' }, { status: 403 })
  if (match.declined_at) return NextResponse.json({ ok: true, already: true, declined_at: match.declined_at })

  const { data: myQuote } = await admin
    .from('quotes')
    .select('id')
    .eq('rfq_id', rfqId)
    .eq('provider_id', actor.providerId)
    .maybeSingle()
  if (myQuote) return NextResponse.json({ error: 'You already quoted — withdraw the quote instead' }, { status: 409 })

  const now = new Date().toISOString()
  const { error } = await admin
    .from('rfq_matches')
    .update({ declined_at: now, decline_reason: parsed.data.reason })
    .eq('rfq_id', rfqId)
    .eq('provider_id', actor.providerId)
    .is('declined_at', null) // replay-safe
  if (error) return serverError('[rfq decline]', error)

  return NextResponse.json({ ok: true, declined_at: now, reason: parsed.data.reason }, { status: 200, headers: { 'Cache-Control': 'private, no-store' } })
}
