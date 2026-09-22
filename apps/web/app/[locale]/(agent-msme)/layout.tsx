import { notFound } from 'next/navigation'
import { agentPageGate } from '@/lib/agent/gate'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { isSupportEnabledFor } from '@/lib/support/settings'
import MsmeLayout from '../(msme)/layout'

/**
 * Agent buyer route group (S2.3; the (agent-provider) / (agent-admin) rule).
 * The (msme) group streams through its loading.tsx, so a page-level
 * notFound() would ship the 404 UI as a 200. This group gates FIRST: with
 * AGENT_ENABLED=false — or for a user the agent is not on for
 * (agents_enabled.support + cohort) — /app/support is a real 404 before any
 * shell renders. Same URLs, same shell as the (msme) group.
 */
export default async function AgentMsmeGroupLayout({ children }: { children: React.ReactNode }) {
  agentPageGate()
  const user = await getSessionUser()
  if (user) {
    const admin = await createAdminClient()
    if (!(await isSupportEnabledFor(admin, user.id))) notFound()
  }
  return <MsmeLayout>{children}</MsmeLayout>
}
