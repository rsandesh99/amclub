import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AGENT_NAMES, agentRunnable, inAgentCohort, type AgentName, type AgentsEnabled } from '@amclub/shared'
import { AGENT_ENABLED } from '@/lib/flags'
import { agentRuntimeReady } from '@/lib/agent/runtime-client'
import { getAgentSetting, getAgentsEnabled } from '@/lib/agent/settings'

export type AgentAvailability = Record<AgentName, boolean>

/**
 * Which agents are on for this user, in one read of `agents_enabled` and the
 * cohort. It follows the same rule as isAgentEnabledForUser, for every agent at
 * once: the switch AND the cohort AND, for a runtime agent, a configured runtime.
 * Everything is false while AGENT_ENABLED is off.
 */
export async function agentAvailability(admin: SupabaseClient, userId: string): Promise<AgentAvailability> {
  const none = Object.fromEntries(AGENT_NAMES.map((n) => [n, false])) as AgentAvailability
  if (!AGENT_ENABLED) return none
  const [enabled, mode, cohort] = await Promise.all([
    getAgentsEnabled(admin) as Promise<AgentsEnabled | null>,
    getAgentSetting(admin, 'cohort_mode'),
    getAgentSetting(admin, 'cohort_user_ids'),
  ])
  // audit B8: cohort_mode 'all' = every user (still subject to each agent's switch and the user's grant)
  const inCohort = inAgentCohort(mode, cohort, userId)
  if (!inCohort || !enabled) return none
  const ready = agentRuntimeReady()
  return Object.fromEntries(AGENT_NAMES.map((n) => [n, !!enabled[n] && agentRunnable(n, ready)])) as AgentAvailability
}
