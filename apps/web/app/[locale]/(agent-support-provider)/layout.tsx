import { notFound } from 'next/navigation'
import { agentPageGate } from '@/lib/agent/gate'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { isSupportEnabledFor } from '@/lib/support/settings'
import ProviderLayout from '../(provider)/layout'

/**
 * Agent provider route group for the Support agent (S2.3). A route-group
 * layout cannot see which page it wraps, so each agent's provider pages need
 * their OWN group gated on their OWN switch: /partner/munshi lives in
 * (agent-provider) (agents_enabled.munshi), /partner/support here
 * (agents_enabled.support). The provider group streams through its
 * loading.tsx, so this layout gates FIRST — a real 404 flag-off or outside the
 * cohort. Same URL, same shell as the provider group.
 */
export default async function AgentSupportProviderGroupLayout({ children }: { children: React.ReactNode }) {
  agentPageGate()
  const user = await getSessionUser()
  if (user) {
    const admin = await createAdminClient()
    if (!(await isSupportEnabledFor(admin, user.id))) notFound()
  }
  return <ProviderLayout>{children}</ProviderLayout>
}
