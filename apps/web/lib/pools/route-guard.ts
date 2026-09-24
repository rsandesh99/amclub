import 'server-only'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { agentApiGate } from '@/lib/agent/gate'
import { requireNotDelegated } from '@/lib/agent/scope'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { poolsOnFor } from './core'

/**
 * S3.4 (ADR 024) — every person-facing pool route starts here: AGENT_ENABLED (hard 404 while dark), a session, and
 * the demand_aggregation switch + cohort for THIS user (404 otherwise — the surface does not exist for them).
 */
export type PoolGuard =
  | { ok: true; admin: SupabaseClient; userId: string; msmeId: string | null; providerId: string | null }
  | { ok: false; res: NextResponse }

export async function poolRouteGuard(): Promise<PoolGuard> {
  const gate = agentApiGate()
  if (gate) return { ok: false, res: gate }
  const { userId } = await getAuthedSupabase()
  if (!userId) return { ok: false, res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  // Audit M85 — joining and offering are a person's taps (ADR 024); no agent tool wraps them.
  const delegated = await requireNotDelegated('pools')
  if (delegated) return { ok: false, res: delegated }
  const admin = await createAdminClient()
  if (!(await poolsOnFor(admin, userId))) return { ok: false, res: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  const actor = await resolveActor(admin, userId)
  return { ok: true, admin, userId, msmeId: actor.msmeId, providerId: actor.providerId }
}

export const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
export const NO_STORE = { 'Cache-Control': 'private, no-store' }
