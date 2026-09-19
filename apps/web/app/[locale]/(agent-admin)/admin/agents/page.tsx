import { agentPageGate } from '@/lib/agent/gate'
import { AgentsConsoleClient } from './AgentsConsoleClient'

/**
 * /admin/agents — the founder's agent console (S0.2): AI spend, per-agent
 * enable toggles + budgets/cohort, and the kill switch. Flag-gated; the admin
 * layout already requires the admin/ops role.
 */
export default function AdminAgentsPage() {
  agentPageGate()
  return <AgentsConsoleClient />
}
