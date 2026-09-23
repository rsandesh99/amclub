import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { CLARIFICATION_MAX_OPEN_PER_PROVIDER, clarificationAskSchema, redactContactInfo } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'
import { createNotification } from '@/lib/notifications/create'
import { captureServerEvent } from '@/lib/analytics/server'
import {
  countOpenQuestionsByProvider,
  listClarifications,
  resolveClarificationParty,
  rfqAcceptsClarifications,
  toClarificationView,
} from '@/lib/rfq/clarifications'
import { notifyText, sameText } from '@/lib/i18n/notify'

/**
 * S1.3 — RFQ clarification thread (RFQ-level, visible to every matched provider).
 *   GET  → the thread for the caller (buyer or matched provider; 403 otherwise).
 *          A provider gets `mine`, never `provider_id`; the buyer gets the asker's name.
 *   POST → a matched, non-declined provider asks ONE question on an active RFQ
 *          (≤ 3 open at a time); contact info is masked before storage; the buyer
 *          is notified. A provider who already quoted may still ask.
 * No RFQ status changes: "in clarification" is derived from open questions.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id: rfqId } = await params
  const admin = await createAdminClient()
  const party = await resolveClarificationParty(admin, userId, rfqId)
  if (!party) return NextResponse.json({ error: 'not_a_party' }, { status: 403 })
  const clarifications = await listClarifications(admin, rfqId, party.role === 'buyer' ? { role: 'buyer' } : { role: 'provider', providerId: party.providerId })
  return NextResponse.json({ clarifications, role: party.role }, { headers: NO_STORE })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const scope = await requireToolScope('ask_clarification')
  if (scope) return scope
  const { id: rfqId } = await params
  const admin = await createAdminClient()

  const party = await resolveClarificationParty(admin, userId, rfqId)
  // Only a matched provider asks — the buyer (403) and an unmatched provider (403) cannot.
  if (!party || party.role !== 'provider') return NextResponse.json({ error: 'not_a_matched_provider' }, { status: 403 })

  const rl = await enforce(limiters.authed, `clarify:${party.providerId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = clarificationAskSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  if (!rfqAcceptsClarifications(party.rfq)) return NextResponse.json({ error: 'rfq_closed' }, { status: 409 })
  // S0.4 quote-or-decline is exclusive — a declined match asks nothing (same shape as the quote route).
  if (party.declinedAt) return NextResponse.json({ error: 'declined', declined_at: party.declinedAt }, { status: 409 })

  const open = await countOpenQuestionsByProvider(admin, rfqId, party.providerId)
  if (open >= CLARIFICATION_MAX_OPEN_PER_PROVIDER) {
    return NextResponse.json({ error: 'clarification_cap', open, max: CLARIFICATION_MAX_OPEN_PER_PROVIDER }, { status: 409 })
  }

  // §9.3 — free text crosses parties: mask contact info BEFORE storage, keep the flag.
  const { text: question, redacted } = redactContactInfo(parsed.data.question)
  const { data: row, error } = await admin
    .from('rfq_clarifications')
    .insert({ rfq_id: rfqId, provider_id: party.providerId, question, question_redacted: redacted })
    .select('id, provider_id, question, question_redacted, answer, answer_redacted, asked_at, answered_at')
    .single()
  if (error || !row) return serverError('[clarification ask]', error)

  if (party.rfq.buyerUserId) {
    await createNotification(admin, {
      userId: party.rfq.buyerUserId,
      kind: 'rfq_question',
      titleI18n: notifyText('rfq_question.title'),
      bodyI18n: sameText(question),
      link: `/app/rfq/${rfqId}`,
      channels: ['whatsapp'],
    })
  }
  captureServerEvent(userId, 'rfq_question_asked', { rfq_id: rfqId, kind: party.rfq.kind, redacted, open_count: open + 1, role: 'provider' })

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const clarification = toClarificationView(row as any, { role: 'provider', providerId: party.providerId })
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return NextResponse.json({ clarification }, { headers: NO_STORE })
}
