import type { SupabaseClient } from '@supabase/supabase-js'
import { AGENT_SETTING_DEFS, agentSettingDefault, inAgentCohort, type AgentName, type AgentSettingDef, type AgentSettingKey } from '@amclub/shared'
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

/**
 * agents_enabled.<name> AND the user in the cohort — the same rule the web applies. The cohort is cohort_user_ids, or
 * everyone when cohort_mode = 'all' (audit B8, D-WA2); the agent's own switch and the user's grant still apply.
 */
export async function isAgentEnabledForUser(db: SupabaseClient, name: AgentName, userId: string): Promise<boolean> {
  const s = await readAgentSettings(db, ['agents_enabled', 'cohort_user_ids', 'cohort_mode'])
  const enabled = (s.agents_enabled as Record<string, boolean> | undefined)?.[name] === true
  return enabled && inAgentCohort(s.cohort_mode, s.cohort_user_ids, userId)
}

/** ADR-030 recycled numbers: days without a sign-in before WhatsApp asks "confirm it's you" (0 = off; default 90). */
export async function waRebindDormantDays(db: SupabaseClient): Promise<number> {
  const s = await readAgentSettings(db, ['wa_rebind_dormant_days'])
  const v = Number(s.wa_rebind_dormant_days)
  return Number.isInteger(v) && v >= 0 && v <= 3650 ? v : 90
}

/**
 * ADR-030 §6: days until a DPDP request made on WhatsApp is due. Read from `dpdp_due_days` when that key is registered
 * (the privacy-operations work owns it), else 30.
 */
export async function dpdpDueDays(db: SupabaseClient): Promise<number> {
  const def = (AGENT_SETTING_DEFS as Record<string, AgentSettingDef>)['dpdp_due_days']
  if (!def) return 30
  const { data } = await db.from('agent_settings').select('value').eq('key', 'dpdp_due_days').maybeSingle()
  const v = Number((data as { value?: unknown } | null)?.value ?? def.default)
  return Number.isInteger(v) && v >= 1 && v <= 90 ? v : 30
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
