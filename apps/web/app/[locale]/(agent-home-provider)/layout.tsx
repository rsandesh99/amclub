import { agentPageGate } from '@/lib/agent/gate'
import ProviderLayout from '../(provider)/layout'

/**
 * The assistant home for providers (/partner/ai). It is gated on AGENT_ENABLED
 * only: the page itself shows which capabilities are on for this person. The
 * provider group streams through its loading.tsx, so this layout gates FIRST, a
 * real 404 with the flag off. Same URL space, same shell as the provider group.
 */
export default function AgentHomeProviderGroupLayout({ children }: { children: React.ReactNode }) {
  agentPageGate()
  return <ProviderLayout>{children}</ProviderLayout>
}
