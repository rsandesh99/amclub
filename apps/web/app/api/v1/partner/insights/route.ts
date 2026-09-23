import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { isOnFor } from '@/lib/experiments'
import { getPartnerInsights } from '@/lib/partner-v3/insights'

/**
 * GET /api/v1/partner/insights?range=7d|30d (PRD Experience v3 E11 FR-11.5) —
 * the caller's own weekly funnel, loss deltas (n ≥ 5), decline reasons
 * (n ≥ 3) and listing performance. Never another provider's name or price;
 * never the composite AMC Score. 404 unless the `partner` experience is on.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isOnFor('partner', userId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const delegated = await requireNotDelegated('partner/insights')
  if (delegated) return delegated
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const range = request.nextUrl.searchParams.get('range') === '30d' ? '30d' : '7d'
  return NextResponse.json(await getPartnerInsights(admin, actor.providerId, range), { headers: { 'Cache-Control': 'private, no-store' } })
}
