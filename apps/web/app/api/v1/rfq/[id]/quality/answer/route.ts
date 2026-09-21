import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { redactContactInfo, rfqQualityAnswerSchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'
import { recordAiDecision } from '@/lib/mart/events'
import { releaseDeferredRfq } from '@/lib/rfq/release'
import { loadDeferredRfqForBuyer } from '@/lib/agent/rfq-quality'
import { captureServerEvent } from '@/lib/analytics/server'

/**
 * S1.5 — the buyer answers the quality questions on their own DEFERRED RFQ.
 * Keys must be a subset of the report's `missing[].field`; each answer is
 * contact-masked and merged into `details` (template field → that key; a
 * generic gap → `details.<gap>`); ONE ai_decisions row (feature rfq_quality,
 * tool check_rfq_quality, run_id null) records the confirmation; then the ONE
 * release path fans out. A cron release that wins the race → 409 already_sent.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const scope = await requireToolScope('complete_rfq')
  if (scope) return scope
  const { id: rfqId } = await params
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.msmeId) return NextResponse.json({ error: 'not_a_buyer' }, { status: 403 })

  const rl = await enforce(limiters.authed, `rfq-quality:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = rfqQualityAnswerSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const loaded = await loadDeferredRfqForBuyer(admin, actor.msmeId, rfqId)
  if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: loaded.status })
  const { rfq } = loaded
  const allowed = new Set((rfq.report?.missing ?? []).map((m) => m.field))
  const keys = Object.keys(parsed.data.answers)
  const unknown = keys.filter((k) => !allowed.has(k))
  if (unknown.length) return NextResponse.json({ error: 'unknown_field', fields: unknown }, { status: 422 })

  // §9.3 — free text crosses parties: mask contact info BEFORE storage; the buyer is told which.
  const details: Record<string, unknown> = { ...rfq.details }
  const redactedFields: string[] = []
  for (const k of keys) {
    const { text, redacted } = redactContactInfo(parsed.data.answers[k]!)
    details[k] = text
    if (redacted) redactedFields.push(k)
  }
  const now = new Date().toISOString()
  // Guarded on fanout_at IS NULL: if the cron guard released meanwhile, this is 409 (nothing overwritten).
  const { data: moved, error: updErr } = await admin.from('rfqs').update({ details, updated_at: now }).eq('id', rfqId).is('fanout_at', null).select('id')
  if (updErr) return serverError('[rfq quality answer]', updErr)
  if (!moved || moved.length === 0) return NextResponse.json({ error: 'already_sent' }, { status: 409 })

  const decisionId = await recordAiDecision(
    admin,
    userId,
    {
      feature: 'rfq_quality',
      input_refs: { rfq_id: rfqId },
      proposed: (rfq.report ?? {}) as unknown as Record<string, unknown>,
      final: { decision: 'answered', answered_fields: keys, redacted_fields: redactedFields },
    },
    { runId: null, tool: 'check_rfq_quality' },
  )
  if (!decisionId) console.error('[rfq quality answer] ai_decisions row not recorded', rfqId)

  const { released, matched } = await releaseDeferredRfq(admin, rfqId, 'answered', { decisionId })
  if (!released) return NextResponse.json({ error: 'already_sent' }, { status: 409 })

  const secondsSinceCheck = rfq.checkedAt ? Math.max(0, Math.round((Date.now() - new Date(rfq.checkedAt).getTime()) / 1000)) : null
  captureServerEvent(userId, 'rfq_quality_answered', { rfq_id: rfqId, answered_count: keys.length, missing_count: rfq.report?.missing.length ?? 0, seconds_since_check: secondsSinceCheck, redacted: redactedFields.length > 0, matched, role: 'msme' })

  return NextResponse.json({ rfqId, matched, redacted_fields: redactedFields }, { headers: NO_STORE })
}
