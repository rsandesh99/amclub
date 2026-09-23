import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { tenderFeedbackSchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { isTendersOn, listTenderAlerts, recordTenderFeedback } from '@/lib/partner-v3/tenders'

/**
 * POST /api/v1/partner/tenders/[id]/feedback (PRD Experience v3 E11 FR-11.6,
 * D9, dark) — "Save" or "Not relevant" on a tender alert I can see. Feeds
 * matching; nothing is applied for or bid on. 404 while tenders_enabled is off.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = await createAdminClient()
  if (!(await isTendersOn(admin))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const delegated = await requireNotDelegated('partner/tenders/feedback')
  if (delegated) return delegated
  const parsed = tenderFeedbackSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body', code: 'invalid_body' }, { status: 422 })
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const visible = await listTenderAlerts(admin, actor.providerId)
  if (visible === 'not_eligible' || !visible.some((a) => a.id === id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!(await recordTenderFeedback(admin, actor.providerId, id, parsed.data.verdict))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
