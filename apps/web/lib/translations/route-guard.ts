import 'server-only'
import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { requireNotDelegated } from '@/lib/agent/scope'
import { isContentTranslateEnabledFor } from '@/lib/agent/content-translate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * E14 FR-14.3 — every /api/v1/partner/translations route, in this order:
 * AGENT_ENABLED (404) → session (401) → never a delegated agent token (the
 * provider approves, never an agent) → the caller's provider profile (403) →
 * agents_enabled.content_translate + cohort for THIS user (404, same body as
 * the gate).
 */
export async function translationRouteGuard(route: string): Promise<{ ok: true; admin: Admin; userId: string; providerId: string } | { ok: false; res: NextResponse }> {
  const gate = agentApiGate()
  if (gate) return { ok: false, res: gate }
  const { userId } = await getAuthedSupabase()
  if (!userId) return { ok: false, res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const delegated = await requireNotDelegated(route)
  if (delegated) return { ok: false, res: delegated }
  const admin = await createAdminClient()
  const { data: p } = await admin.from('provider_profiles').select('id').eq('user_id', userId).maybeSingle()
  if (!p) return { ok: false, res: NextResponse.json({ error: 'not_a_provider' }, { status: 403 }) }
  if (!(await isContentTranslateEnabledFor(admin, userId))) return { ok: false, res: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return { ok: true, admin, userId, providerId: p.id as string }
}
