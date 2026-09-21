import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { writeAudit } from '@/lib/audit/log'
import { resolveDispute } from '@/lib/disputes/resolve'
import { serverError } from '@/lib/api/errors'
import { requireNotDelegated } from '@/lib/agent/scope'
import { closeTriage, getTriage } from '@/lib/agent/triages'
import { captureServerEvent } from '@/lib/analytics/server'

const bodySchema = z
  .object({
    resolution: z.enum(['refund_full', 'refund_partial', 'release']),
    amountPaise: z.number().int().nonnegative().optional(),
    /** S1.7 — the triage card the founder had open; links this click to ai_decisions AFTER settlement. */
    triage_id: z.string().uuid().optional(),
  })
  .refine((d) => d.resolution !== 'refund_partial' || (d.amountPaise != null && d.amountPaise > 0), {
    message: 'refund_partial requires a positive amountPaise',
    path: ['amountPaise'],
  })

/** POST — ops resolves a dispute (§5.4/§9.2). Money moves via the proven refund
 *  + payout rails; idempotent; audit-logged. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error
  // S1.7 — no agent tool wraps this route; ANY delegated token is refused (the payout-release precedent).
  const delegated = await requireNotDelegated('admin/disputes/resolve')
  if (delegated) return delegated

  const rl = await enforce(limiters.adminMutation, `admin:${gate.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const { id } = await params
  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const { data: before } = await admin.from('disputes').select('status, resolution').eq('id', id).maybeSingle()

  // S1.7 — a triage_id must belong to THIS dispute, checked BEFORE any money moves.
  const triage = parsed.data.triage_id ? await getTriage(admin, parsed.data.triage_id) : null
  if (parsed.data.triage_id && (!triage || triage.dispute_id !== id)) {
    return NextResponse.json({ error: 'triage_mismatch' }, { status: 422 })
  }

  let result
  try {
    result = await resolveDispute(admin, id, parsed.data.resolution, parsed.data.amountPaise, gate.userId)
  } catch (e) {
    return serverError('[dispute resolve]', e)
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status ?? 400 })

  // S1.7 — link the click to the triage AFTER settlement; a failed write logs and never rolls back money.
  let triageDecisionId: string | null = null
  if (!result.already && triage) {
    try {
      const closed = await closeTriage(admin, { triage, resolution: parsed.data.resolution, amountPaise: result.refundPaise ?? null, actorUserId: gate.userId })
      triageDecisionId = closed.decisionId
      captureServerEvent(gate.userId, 'dispute_resolved_with_triage', { dispute_id: id, triage_id: triage.id, agreed: triage.triage.recommendation === parsed.data.resolution, recommendation: triage.triage.recommendation, resolution: parsed.data.resolution })
    } catch (e) {
      console.error('[dispute resolve] closeTriage', (e as Error).message)
    }
  }

  // Audit only a real state change (idempotent re-resolves don't move money).
  if (!result.already) {
    await writeAudit(admin, request, {
      actorId: gate.userId,
      action: `dispute_${parsed.data.resolution}`,
      entity: 'disputes',
      entityId: id,
      before,
      after: { status: 'resolved', resolution: parsed.data.resolution, refund_paise: result.refundPaise, provider_paid_paise: result.providerPaidPaise, ...(triage ? { triage_id: triage.id, triage_decision_id: triageDecisionId } : {}) },
    })
  }

  return NextResponse.json({ ...result, ...(triage ? { triage_id: triage.id, triage_decision_id: triageDecisionId } : {}) })
}
