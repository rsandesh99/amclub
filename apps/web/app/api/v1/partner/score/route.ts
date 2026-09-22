import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { captureServerEvent } from '@/lib/analytics/server'
import { getScoreSettings } from '@/lib/score/settings'
import { providerScoreCard } from '@/lib/score/card'

/**
 * GET /api/v1/partner/score (S2.4, ADR-010 §6) — the provider's OWN AMC Score: score (or the gate), components with
 * weights and raw counts, the two weakest with tips, a 30-day trend, and (Munshi providers) the day's coaching note.
 * 404 unless `score_card_enabled`. Scope `read_own_score` for a delegated token (a no-op for sessions). Never a
 * buyer route: the provider is resolved from the caller, there is no id parameter.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const scope = await requireToolScope('read_own_score')
  if (scope) return scope
  const admin = await createAdminClient()
  if (!(await getScoreSettings(admin)).cardEnabled) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const locale = request.nextUrl.searchParams.get('locale') ?? request.headers.get('x-amc-locale')
  const card = await providerScoreCard(admin, { providerId: actor.providerId, userId, locale })
  captureServerEvent(userId, 'score_card_viewed', { computed: card.computed, gated: card.gated, has_note: card.note !== null })
  return NextResponse.json(card, { headers: { 'Cache-Control': 'private, no-store' } })
}
