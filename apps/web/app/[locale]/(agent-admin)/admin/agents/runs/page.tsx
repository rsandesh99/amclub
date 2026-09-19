import { agentPageGate } from '@/lib/agent/gate'
import { AgentRunsClient } from './AgentRunsClient'

/**
 * /admin/agents/runs — every agent run, filterable, with a detail drawer
 * (event trace + per-call cost + confirmation decisions). Flag-gated.
 */
export default function AdminAgentRunsPage() {
  agentPageGate()
  return <AgentRunsClient />
}
