import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { extractRuntimeCredential, verifyRuntimeCredential } from '@amclub/agent-core'
import { agentApiGate } from '@/lib/agent/gate'
import { createAdminClient } from '@/lib/supabase/server'
import { getAgentSetting } from '@/lib/agent/settings'
import { getDossier } from '@/lib/agent/dossiers'
import { notifyPayoutDossierReady } from '@/lib/notifications/events'
import { env } from '@/lib/env'

/**
 * POST /api/v1/agent/admin/dossiers/[id]/notify (S1.4 §4d) — the runtime calls
 * this after writing a dossier. Runtime credential REQUIRED (no session path);
 * idempotent: the founder is notified once per dossier (guarded update on
 * notified_at). Dispatch is by notification kind (`payout_dossier_ready`), so
 * WhatsApp picks it up the moment the S0.5 rails are live — no direct send here.
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
  const dossier = await getDossier(admin, id)
  if (!dossier) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (dossier.run_id && claims.runId !== dossier.run_id) return NextResponse.json({ error: 'run_mismatch' }, { status: 403 })

  const opsUserId = (await getAgentSetting(admin, 'ops_user_id')) as string | null
  if (!opsUserId) return NextResponse.json({ ok: true, notified: false, reason: 'no_ops_user' })

  // Claim the notification: only the writer that flips notified_at sends.
  const { data: claimed, error } = await admin
    .from('payout_dossiers')
    .update({ notified_at: new Date().toISOString() })
    .eq('id', id)
    .is('notified_at', null)
    .select('id')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!claimed || (claimed as unknown[]).length === 0) return NextResponse.json({ ok: true, notified: false, reason: 'already_notified' })

  const [{ data: order }, { data: payout }] = await Promise.all([
    admin.from('orders').select('id, order_number, title').eq('id', dossier.order_id).maybeSingle(),
    dossier.payout_id ? admin.from('payouts').select('amount_paise').eq('id', dossier.payout_id).maybeSingle() : { data: null },
  ])
  await notifyPayoutDossierReady(admin, {
    opsUserId,
    dossierId: dossier.id,
    orderNumber: order?.order_number ?? dossier.order_id,
    amountPaise: Number(payout?.amount_paise ?? 0),
    recommendation: dossier.recommendation,
  })
  return NextResponse.json({ ok: true, notified: true })
}
