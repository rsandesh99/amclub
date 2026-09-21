import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { extractRuntimeCredential, verifyRuntimeCredential } from '@amclub/agent-core'
import { agentApiGate } from '@/lib/agent/gate'
import { createAdminClient } from '@/lib/supabase/server'
import { getAgentSetting } from '@/lib/agent/settings'
import { getTriage } from '@/lib/agent/triages'
import { notifyDisputeTriageReady } from '@/lib/notifications/events'
import { env } from '@/lib/env'

/**
 * POST /api/v1/agent/admin/triages/[id]/notify (S1.7) — the runtime calls this
 * after writing a triage. Runtime credential REQUIRED (no session path);
 * idempotent: the ops user is notified once per triage (guarded update on
 * notified_at). Dispatch by kind (`dispute_triage_ready`): in-app + email now,
 * WhatsApp through the S0.5 rails when live.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = agentApiGate()
  if (gate) return gate
  const secret = env.AGENT_RUNTIME_SECRET
  if (!secret) return NextResponse.json({ error: 'agent_not_configured' }, { status: 503 })
  const cred = extractRuntimeCredential(request.headers.get('authorization'))
  const claims = cred ? verifyRuntimeCredential(secret, cred) : null
  if (!claims) return NextResponse.json({ error: 'invalid_runtime_credential' }, { status: 401 })

  const { id } = await params
  const admin = await createAdminClient()
  const triage = await getTriage(admin, id)
  if (!triage) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (triage.run_id && claims.runId !== triage.run_id) return NextResponse.json({ error: 'run_mismatch' }, { status: 403 })

  const opsUserId = (await getAgentSetting(admin, 'ops_user_id')) as string | null
  if (!opsUserId) return NextResponse.json({ ok: true, notified: false, reason: 'no_ops_user' })

  const { data: claimed, error } = await admin.from('dispute_triages').update({ notified_at: new Date().toISOString() }).eq('id', id).is('notified_at', null).select('id')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!claimed || (claimed as unknown[]).length === 0) return NextResponse.json({ ok: true, notified: false, reason: 'already_notified' })

  const { data: order } = await admin.from('orders').select('order_number').eq('id', triage.order_id).maybeSingle()
  await notifyDisputeTriageReady(admin, {
    opsUserId,
    triageId: triage.id,
    disputeId: triage.dispute_id,
    orderNumber: (order as { order_number?: string } | null)?.order_number ?? triage.order_id,
    recommendation: triage.triage.recommendation,
    confidence: triage.triage.confidence,
  })
  return NextResponse.json({ ok: true, notified: true })
}
