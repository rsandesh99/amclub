import { notFound } from 'next/navigation'
import { agentPageGate } from '@/lib/agent/gate'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { isContentTranslateEnabledFor } from '@/lib/agent/content-translate'
import ProviderLayout from '../(provider)/layout'

/**
 * E14 FR-14.3 (N32b) route group — one group per agent switch (the S2.2 rule):
 * gates FIRST, so with AGENT_ENABLED=false, or for a signed-in user the
 * content_translate agent is not on for (agents_enabled + cohort), the
 * /partner/translations subtree is a real 404 before any shell renders.
 */
export default async function AgentTranslateProviderGroupLayout({ children }: { children: React.ReactNode }) {
  agentPageGate()
  const user = await getSessionUser()
  if (user) {
    const admin = await createAdminClient()
    if (!(await isContentTranslateEnabledFor(admin, user.id))) notFound()
  }
  return <ProviderLayout>{children}</ProviderLayout>
}
