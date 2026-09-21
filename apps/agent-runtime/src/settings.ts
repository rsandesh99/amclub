import type { SupabaseClient } from '@supabase/supabase-js'
import { agentSettingDefault, type AgentName, type AgentSettingKey } from '@amclub/shared'
import { resolveCaps, type BudgetCaps } from '@amclub/agent-core'

/**
 * agent_settings reads for the runtime (registry semantics, mirroring
 * apps/web/lib/agent/settings.ts): a key absent from the DB reads as its launch
 * default. The service role may read agent-owned config (deps.ts rules). The
 * client is passed in so this module never imports deps (no cycle).
 */
export async function readAgentSettings(db: SupabaseClient, keys: AgentSettingKey[]): Promise<Partial<Record<AgentSettingKey, unknown>>> {
  const { data } = await db.from('agent_settings').select('key, value').in('key', keys)
  const rows = (data ?? []) as Array<{ key: AgentSettingKey; value: unknown }>
  const out: Partial<Record<AgentSettingKey, unknown>> = {}
  for (const k of keys) out[k] = rows.find((r) => r.key === k)?.value ?? agentSettingDefault(k)
  return out
}

/** agents_enabled.<name> AND the user in cohort_user_ids — the same rule the web applies. */
export async function isAgentEnabledForUser(db: SupabaseClient, name: AgentName, userId: string): Promise<boolean> {
  const s = await readAgentSettings(db, ['agents_enabled', 'cohort_user_ids'])
  const enabled = (s.agents_enabled as Record<string, boolean> | undefined)?.[name] === true
  const cohort = s.cohort_user_ids
  return enabled && Array.isArray(cohort) && cohort.includes(userId)
}

/** S1.6 — session TTL (hours), 1..168, default 72. */
export async function onboardingSessionTtlHours(db: SupabaseClient): Promise<number> {
  const s = await readAgentSettings(db, ['onboarding_session_ttl_hours'])
  const v = Number(s.onboarding_session_ttl_hours)
  return Number.isFinite(v) && v >= 1 && v <= 168 ? v : 72
}

/** Budget caps for a run: the four budget keys (+ the S1.6 per-agent run override) with env fallback. */
export async function budgetCapsFor(db: SupabaseClient, agentName?: string): Promise<BudgetCaps> {
  const s = await readAgentSettings(db, ['budget_run_paise', 'budget_user_day_paise', 'budget_month_paise', 'budget_run_paise_by_agent'])
  return resolveCaps(s as Partial<Record<string, unknown>>, agentName)
}
