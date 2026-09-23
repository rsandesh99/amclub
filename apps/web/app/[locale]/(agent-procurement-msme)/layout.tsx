import { notFound } from 'next/navigation'
import { agentPageGate } from '@/lib/agent/gate'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { isProcurementEnabledFor } from '@/lib/agent/procurement'
import MsmeLayout from '../(msme)/layout'

/**
 * The buying-assistant route group (S3.1; one group per agent switch — the S2.3 rule). The (msme) group streams
 * through its loading.tsx, so a page-level notFound() would ship the 404 UI as a 200. This group gates FIRST: with
 * AGENT_ENABLED=false — or for a buyer the agent is not on for (agents_enabled.procurement + cohort) —
 * /app/assistant is a real 404 before any shell renders. Same URL space, same shell as the (msme) group.
 */
export default async function AgentProcurementMsmeGroupLayout({ children }: { children: React.ReactNode }) {
  agentPageGate()
  const user = await getSessionUser()
  if (user) {
    const admin = await createAdminClient()
    if (!(await isProcurementEnabledFor(admin, user.id))) notFound()
  }
  return <MsmeLayout>{children}</MsmeLayout>
}
