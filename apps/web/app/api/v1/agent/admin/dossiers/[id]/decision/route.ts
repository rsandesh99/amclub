import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { dossierHoldDecisionSchema } from '@amclub/shared'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { writeAudit } from '@/lib/audit/log'
import { closeDossierHold, getDossier } from '@/lib/agent/dossiers'

/**
 * POST /api/v1/agent/admin/dossiers/[id]/decision { decision: 'hold', note? }
 * (S1.4 §4d). The ONLY decision this route accepts is hold — approve must go
 * through the payout release route, because approve IS the money-moving tap.
 * Hold writes nothing money-related: the payout simply stays held; the dossier
 * records the founder's look as one ai_decisions row. A dossier is decided
 * once (409 afterwards). Agent surface: agentApiGate FIRST, admin/ops, never a
 * delegated token.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const delegated = await requireNotDelegated('POST /agent/admin/dossiers/[id]/decision')
  if (delegated) return delegated
  const rl = await enforce(limiters.adminMutation, `admin:${auth.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const parsed = dossierHoldDecisionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const { id } = await params
  const admin = await createAdminClient()
  const dossier = await getDossier(admin, id)
  if (!dossier) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (dossier.decision) return NextResponse.json({ error: 'dossier_already_decided', decision: dossier.decision }, { status: 409 })

  const r = await closeDossierHold(admin, dossier, auth.userId, parsed.data.note ?? null)
  if (!r.ok) {
    return NextResponse.json({ error: r.error === 'already_decided' ? 'dossier_already_decided' : 'write_failed' }, { status: r.error === 'already_decided' ? 409 : 500 })
  }
  await writeAudit(admin, request, {
    actorId: auth.userId,
    action: 'payout_dossier_hold',
    entity: 'payout_dossiers',
    entityId: id,
    before: { decision: null, recommendation: dossier.recommendation },
    after: { decision: 'hold', decision_id: r.decisionId, payout_id: dossier.payout_id },
  })
  return NextResponse.json({ ok: true, decision: 'hold', decision_id: r.decisionId })
}
