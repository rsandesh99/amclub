import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { recordAiDecision } from '@/lib/mart/events'
import { releaseDeferredRfq } from '@/lib/rfq/release'
import { loadDeferredRfqForBuyer } from '@/lib/agent/rfq-quality'
import { captureServerEvent } from '@/lib/analytics/server'

/**
 * S1.5 — "Send as is": the buyer declines to answer and releases their own
 * DEFERRED RFQ unchanged. ONE ai_decisions row (feature rfq_quality, tool
 * check_rfq_quality, run_id null) records the tap; then the ONE release path
 * fans out. A cron release that wins the race → 409 already_sent.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const loaded = await loadDeferredRfqForBuyer(admin, actor.msmeId, rfqId)
  if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: loaded.status })
  const { rfq } = loaded

  const decisionId = await recordAiDecision(
    admin,
    userId,
    {
      feature: 'rfq_quality',
      input_refs: { rfq_id: rfqId },
      proposed: (rfq.report ?? {}) as unknown as Record<string, unknown>,
      final: { decision: 'sent_as_is', missing_count: rfq.report?.missing.length ?? 0 },
    },
    { runId: null, tool: 'check_rfq_quality' },
  )
  if (!decisionId) console.error('[rfq quality send] ai_decisions row not recorded', rfqId)

  const { released, matched } = await releaseDeferredRfq(admin, rfqId, 'sent_as_is', { decisionId })
  if (!released) return NextResponse.json({ error: 'already_sent' }, { status: 409 })

  captureServerEvent(userId, 'rfq_quality_sent_as_is', { rfq_id: rfqId, missing_count: rfq.report?.missing.length ?? 0, matched, role: 'msme' })
  return NextResponse.json({ rfqId, matched }, { headers: NO_STORE })
}
