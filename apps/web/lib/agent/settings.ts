import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  agentSettingDefault,
  AGENT_SETTING_DEFS,
  AGENT_SETTING_KEYS,
  type AgentName,
  type AgentSettingKey,
  type AgentsEnabled,
} from '@amclub/shared'

/**
 * Read the agent config registry (agent_settings) with registry defaults. A key
 * absent from the DB reads as its launch default (agents_enabled all-false,
 * budget caps, empty cohort). Writers are the admin console (S0.2) only.
 */

export async function getAgentSetting<K extends AgentSettingKey>(admin: SupabaseClient, key: K): Promise<unknown> {
  const { data } = await admin.from('agent_settings').select('value').eq('key', key).maybeSingle()
  return data?.value ?? agentSettingDefault(key)
}

export interface AgentSettingRow {
  key: AgentSettingKey
  value: unknown
  set: boolean
  updated_at: string | null
  updated_by: string | null
  hint: string
}

export async function listAgentSettings(admin: SupabaseClient): Promise<{ settings: AgentSettingRow[]; unknown: string[] }> {
  const { data } = await admin.from('agent_settings').select('key, value, updated_at, updated_by')
  const rows = (data ?? []) as Array<{ key: string; value: unknown; updated_at: string | null; updated_by: string | null }>
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const settings: AgentSettingRow[] = AGENT_SETTING_KEYS.map((key) => {
    const row = byKey.get(key)
    return {
      key,
      value: row?.value ?? agentSettingDefault(key),
      set: !!row,
      updated_at: row?.updated_at ?? null,
      updated_by: row?.updated_by ?? null,
      hint: AGENT_SETTING_DEFS[key].hint,
    }
  })
  const unknown = rows.filter((r) => !(AGENT_SETTING_KEYS as string[]).includes(r.key)).map((r) => r.key)
  return { settings, unknown }
}

export async function getAgentsEnabled(admin: SupabaseClient): Promise<AgentsEnabled> {
  return (await getAgentSetting(admin, 'agents_enabled')) as AgentsEnabled
}

/** True only when the agent's flag is on AND the user is in the cohort allowlist. */
export async function isAgentEnabledForUser(admin: SupabaseClient, name: AgentName, userId: string): Promise<boolean> {
  const enabled = await getAgentsEnabled(admin)
  if (!enabled?.[name]) return false
  const cohort = (await getAgentSetting(admin, 'cohort_user_ids')) as string[]
  return Array.isArray(cohort) && cohort.includes(userId)
}
