import { notFound } from 'next/navigation'
import { agentPageGate } from '@/lib/agent/gate'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { poolsOnFor } from '@/lib/pools/core'
import ProviderLayout from '../(provider)/layout'

/**
 * S3.4 (ADR 024) route group — gates FIRST: with AGENT_ENABLED=false, or for a signed-in provider the
 * demand_aggregation agent is not on for (agents_enabled + cohort), /partner/pools is a real 404.
 */
export default async function AgentPoolsProviderGroupLayout({ children }: { children: React.ReactNode }) {
  agentPageGate()
  const user = await getSessionUser()
  if (user && !(await poolsOnFor(await createAdminClient(), user.id))) notFound()
  return <ProviderLayout>{children}</ProviderLayout>
}
