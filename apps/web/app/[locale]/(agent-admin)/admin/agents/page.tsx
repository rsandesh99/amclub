import { RUNTIME_AGENTS } from '@amclub/shared'
import { agentPageGate } from '@/lib/agent/gate'
import { agentRuntimeReady } from '@/lib/agent/runtime-client'
import { AgentsConsoleClient } from './AgentsConsoleClient'

/**
 * /admin/agents — the founder's agent console (S0.2): AI spend, per-agent
 * enable toggles + budgets/cohort, and the kill switch. Flag-gated; the admin
 * layout already requires the admin/ops role.
 */
export default function AdminAgentsPage() {
  agentPageGate()
  // Runtime agents read as off until the runtime is configured (shared agentRunnable); say so here.
  return <AgentsConsoleClient runtimeReady={agentRuntimeReady()} runtimeAgents={RUNTIME_AGENTS} />
}
