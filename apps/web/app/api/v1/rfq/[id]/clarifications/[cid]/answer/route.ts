import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { clarificationAnswerSchema, hoursToAnswer, redactContactInfo } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'
import { createNotificationsBulk } from '@/lib/notifications/create'
import { captureServerEvent } from '@/lib/analytics/server'
import { matchedProviderUserIds, resolveClarificationParty, rfqAcceptsClarifications, toClarificationView } from '@/lib/rfq/clarifications'
import { notifyText, sameText } from '@/lib/i18n/notify'

/**
 * S1.3 — the buyer answers ONE clarification, once. The answer is visible to
 * every matched provider (fairness); every matched, non-declined provider is
 * notified (the asker included — no special copy, they see `mine` in the UI).
 * Closed is closed: no answers on an expired/cancelled/accepted RFQ (the rescue
 * UI re-broadcasts). Replay-safe: the update is guarded on answered_at IS NULL.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const COLS = 'id, provider_id, question, question_redacted, answer, answer_redacted, asked_at, answered_at'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; cid: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const scope = await requireToolScope('answer_clarification')
  if (scope) return scope
  const { id: rfqId, cid } = await params
  const admin = await createAdminClient()

  const party = await resolveClarificationParty(admin, userId, rfqId)
  if (!party || party.role !== 'buyer') return NextResponse.json({ error: 'not_the_buyer' }, { status: 403 })

  const rl = await enforce(limiters.authed, `answer:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = clarificationAnswerSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const { data: existing } = await admin.from('rfq_clarifications').select(COLS).eq('id', cid).eq('rfq_id', rfqId).is('deleted_at', null).maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (existing.answered_at) return NextResponse.json({ error: 'already_answered' }, { status: 409 })
  if (!rfqAcceptsClarifications(party.rfq)) return NextResponse.json({ error: 'rfq_closed' }, { status: 409 })

  const { text: answer, redacted } = redactContactInfo(parsed.data.answer)
  const now = new Date().toISOString()
  const { data: moved, error } = await admin
    .from('rfq_clarifications')
    .update({ answer, answer_redacted: redacted, answered_at: now, answered_by: userId })
    .eq('id', cid)
    .is('answered_at', null)
    .select(COLS)
  if (error) return serverError('[clarification answer]', error)
  const row = moved?.[0]
  if (!row) return NextResponse.json({ error: 'already_answered' }, { status: 409 })

  const audience = await matchedProviderUserIds(admin, rfqId)
  await createNotificationsBulk(admin, audience, {
    kind: 'rfq_answer',
    titleI18n: notifyText('rfq_answer.title'),
    bodyI18n: sameText(answer),
    link: `/partner/rfqs/${rfqId}`,
    channels: ['whatsapp'],
  })
  captureServerEvent(userId, 'rfq_question_answered', { rfq_id: rfqId, hours_to_answer: hoursToAnswer(row.asked_at, now), redacted, notified: audience.length, role: 'msme' })

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const clarification = toClarificationView(row as any, { role: 'buyer' })
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return NextResponse.json({ clarification }, { headers: NO_STORE })
}
