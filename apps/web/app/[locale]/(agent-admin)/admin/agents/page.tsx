import { RUNTIME_AGENTS } from '@amclub/shared'
import { residencyPosture } from '@amclub/agent-core'
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
  // Audit M23: the model gateway's residency posture on THIS deployment (the runtime reports its own on /health).
  // `unconfigured` = production with agents on and no decision → every model call with user data is refused.
  const residency = residencyPosture()
  // Runtime agents read as off until the runtime is configured (shared agentRunnable); say so here.
  return <AgentsConsoleClient runtimeReady={agentRuntimeReady()} runtimeAgents={RUNTIME_AGENTS} residency={{ mode: residency.mode, waiver: residency.waiver }} />
}
