import 'server-only'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { agentApiGate } from '@/lib/agent/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { isMunshiEnabledFor } from '@/lib/agent/munshi'

/**
 * S2.2 — the common prologue of every /api/v1/agent/munshi/* route: the agent
 * flag gate (404 dark), a provider session (never a delegated token — these
 * are the provider's own switches), and the per-user enablement
 * (agents_enabled.munshi + cohort) — 404 otherwise, so the surface is
 * invisible to anyone outside the cohort.
 */
export type MunshiRouteContext = { error: NextResponse } | { error?: undefined; admin: SupabaseClient; userId: string; providerId: string }

export const MUNSHI_NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function munshiRouteContext(route: string): Promise<MunshiRouteContext> {
  const gate = agentApiGate()
  if (gate) return { error: gate }
  const { userId } = await getAuthedSupabase()
  if (!userId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const delegated = await requireNotDelegated(route)
  if (delegated) return { error: delegated }
  const admin = await createAdminClient()
  if (!(await isMunshiEnabledFor(admin, userId))) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return { error: NextResponse.json({ error: 'Not a provider' }, { status: 403 }) }
  return { admin, userId, providerId: actor.providerId }
}
