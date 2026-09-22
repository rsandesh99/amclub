import { notFound } from 'next/navigation'
import { agentPageGate } from '@/lib/agent/gate'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { isMunshiEnabledFor } from '@/lib/agent/munshi'
import ProviderLayout from '../(provider)/layout'

/**
 * Agent provider route group (S2.2; the (agent-admin) / (mart-*) dark-build
 * rule). The provider group streams through its loading.tsx, so a page-level
 * notFound() would ship the 404 UI as a 200. This group gates FIRST: with
 * AGENT_ENABLED=false — or for a signed-in user the agent is not on for
 * (agents_enabled.munshi + cohort) — the whole /partner/munshi subtree is a
 * real 404 before any shell renders. Same URLs, same shell as the provider
 * group; an anonymous visitor falls through to the provider layout's login
 * redirect.
 */
export default async function AgentProviderGroupLayout({ children }: { children: React.ReactNode }) {
  agentPageGate()
  const user = await getSessionUser()
  if (user) {
    const admin = await createAdminClient()
    if (!(await isMunshiEnabledFor(admin, user.id))) notFound()
  }
  return <ProviderLayout>{children}</ProviderLayout>
}
