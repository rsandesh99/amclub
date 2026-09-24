import { notFound } from 'next/navigation'
import { agentPageGate } from '@/lib/agent/gate'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { poolsOnFor } from '@/lib/pools/core'
import MsmeLayout from '../(msme)/layout'

/**
 * S3.4 (ADR 024) route group — one group per agent switch: gates FIRST, so with AGENT_ENABLED=false, or for a
 * signed-in buyer the demand_aggregation agent is not on for (agents_enabled + cohort), /app/pools is a real 404
 * before any shell renders.
 */
export default async function AgentPoolsMsmeGroupLayout({ children }: { children: React.ReactNode }) {
  agentPageGate()
  const user = await getSessionUser()
  if (user && !(await poolsOnFor(await createAdminClient(), user.id))) notFound()
  return <MsmeLayout>{children}</MsmeLayout>
}
