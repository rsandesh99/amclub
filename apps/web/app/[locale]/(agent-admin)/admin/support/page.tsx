import { agentPageGate } from '@/lib/agent/gate'
import { SupportQueueClient } from './SupportQueueClient'

/** /admin/support (S2.3) — the ticket queue. The (agent-admin) group layout already gates AGENT_ENABLED. */
export default function AdminSupportPage() {
  agentPageGate()
  return <SupportQueueClient />
}
