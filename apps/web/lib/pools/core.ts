import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { POOL_TIMING_DEFAULT, type PoolEventKind, type PoolTiming } from '@amclub/shared'
import { AGENT_ENABLED } from '@/lib/flags'
import { getAgentSetting, getAgentsEnabled, isAgentEnabledForUser } from '@/lib/agent/settings'

/**
 * S3.4 (ADR 024) — the gates and settings every pool reader and writer shares. Nothing touches a 0071 table unless
 * AGENT_ENABLED is on AND agents_enabled.demand_aggregation is on (and, for a person, they are in the cohort), so a
 * database without 0071 fails no query outside the pool surfaces.
 */

/** The switch for the platform-level jobs (detection and the clock). */
export async function poolsOn(admin: SupabaseClient): Promise<boolean> {
  if (!AGENT_ENABLED) return false
  const enabled = await getAgentsEnabled(admin)
  return enabled?.demand_aggregation === true
}

/** The switch for one person (buyer or provider): the agent on AND the person in the cohort. */
export async function poolsOnFor(admin: SupabaseClient, userId: string): Promise<boolean> {
  return AGENT_ENABLED && (await isAgentEnabledForUser(admin, 'demand_aggregation', userId))
}

export async function cohortUserIds(admin: SupabaseClient): Promise<string[]> {
  const v = await getAgentSetting(admin, 'cohort_user_ids')
  return Array.isArray(v) ? (v as string[]) : []
}

export interface PoolSettings {
  minMembers: number
  maxMembers: number
  timing: PoolTiming
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

export async function poolSettings(admin: SupabaseClient): Promise<PoolSettings> {
  const [min, max, form, open, buffer] = await Promise.all([
    getAgentSetting(admin, 'pool_min_members'),
    getAgentSetting(admin, 'pool_max_members'),
    getAgentSetting(admin, 'pool_form_hours'),
    getAgentSetting(admin, 'pool_open_hours'),
    getAgentSetting(admin, 'pool_pay_buffer_hours'),
  ])
  const minMembers = num(min, 3)
  return {
    minMembers,
    maxMembers: Math.max(minMembers, num(max, 20)),
    timing: {
      formHours: num(form, POOL_TIMING_DEFAULT.formHours),
      openHours: num(open, POOL_TIMING_DEFAULT.openHours),
      payBufferHours: num(buffer, POOL_TIMING_DEFAULT.payBufferHours),
    },
  }
}

/** Append one history row (append-only table; failures are logged, never thrown — history never blocks a move). */
export async function addPoolEvent(admin: SupabaseClient, poolId: string, kind: PoolEventKind, actorUserId: string | null, payload: Record<string, unknown> = {}): Promise<void> {
  const { error } = await admin.from('service_pool_events').insert({ pool_id: poolId, kind, actor_user_id: actorUserId, payload })
  if (error) console.error('[pools] event insert failed', { poolId, kind, message: error.message })
}

/** Split a list for `.in()` filters so a GET URL never grows past what PostgREST accepts. */
export function chunks<T>(xs: readonly T[], size = 150): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

export interface PoolRow {
  id: string
  category_id: string
  service_slug: string
  state: string
  status: string
  min_members: number
  max_members: number
  form_by: string
  opened_at: string | null
  closes_at: string | null
  closed_at: string | null
}

export const POOL_COLS = 'id, category_id, service_slug, state, status, min_members, max_members, form_by, opened_at, closes_at, closed_at'

export async function loadPool(admin: SupabaseClient, poolId: string): Promise<PoolRow | null> {
  const { data } = await admin.from('service_pools').select(POOL_COLS).eq('id', poolId).maybeSingle()
  return (data as PoolRow | null) ?? null
}

/**
 * Audit M45 — the buyer profiles (msme ids) whose user ALSO owns a provider profile (any status, not deleted).
 * Such a dual-role account never joins a group and never sees its offers: a provider could otherwise read its
 * competitors' sealed volume tiers through its own buyer profile (§8.3 — no bidding wars). Fails closed: a read
 * error throws (the caller's route answers 500; the detection run stops) rather than treating anyone as buyer-only.
 */
export async function dualRoleMsmeIds(admin: SupabaseClient, msmeIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>()
  const msmeByUser = new Map<string, string[]>()
  for (const part of chunks([...new Set(msmeIds)])) {
    const { data, error } = await admin.from('msme_profiles').select('id, user_id').in('id', part)
    if (error) throw new Error(`[pools] dual-role check (buyers): ${error.message}`)
    for (const m of (data ?? []) as Array<{ id: string; user_id: string }>) msmeByUser.set(m.user_id, [...(msmeByUser.get(m.user_id) ?? []), m.id])
  }
  for (const part of chunks([...msmeByUser.keys()])) {
    const { data, error } = await admin.from('provider_profiles').select('user_id').in('user_id', part).is('deleted_at', null)
    if (error) throw new Error(`[pools] dual-role check (providers): ${error.message}`)
    for (const p of (data ?? []) as Array<{ user_id: string }>) for (const id of msmeByUser.get(p.user_id) ?? []) out.add(id)
  }
  return out
}

/** The user id of each provider (for notifications), keyed by provider id. */
export async function providerUsers(admin: SupabaseClient, providerIds: readonly string[]): Promise<Map<string, { userId: string; name: string; slug: string | null; active: boolean }>> {
  const out = new Map<string, { userId: string; name: string; slug: string | null; active: boolean }>()
  for (const part of chunks([...new Set(providerIds)])) {
    const { data } = await admin.from('provider_profiles').select('id, user_id, display_name, slug, status, capacity_paused, deleted_at').in('id', part)
    for (const p of (data ?? []) as Array<{ id: string; user_id: string; display_name: string | null; slug: string | null; status: string; capacity_paused: boolean | null; deleted_at: string | null }>) {
      out.set(p.id, { userId: p.user_id, name: p.display_name ?? '', slug: p.slug, active: p.status === 'active' && !p.deleted_at && !p.capacity_paused })
    }
  }
  return out
}
