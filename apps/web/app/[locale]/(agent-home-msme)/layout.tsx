import { agentPageGate } from '@/lib/agent/gate'
import MsmeLayout from '../(msme)/layout'

/**
 * The assistant home for buyers (/app/ai). It is gated on AGENT_ENABLED only:
 * the page itself shows which capabilities are on for this person. The (msme)
 * group streams through its loading.tsx, so a page-level notFound() would ship
 * the 404 UI as a 200. This group gates FIRST, a real 404 with the flag off.
 * Same URL space, same shell as the (msme) group.
 */
export default function AgentHomeMsmeGroupLayout({ children }: { children: React.ReactNode }) {
  agentPageGate()
  return <MsmeLayout>{children}</MsmeLayout>
}
