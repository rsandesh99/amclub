import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { procurementStats } from '@/lib/agent/procurement'

/** GET /api/v1/agent/admin/procurement/stats (S3.1) — the agents-console tile (30 days): active sessions, proposals approved / edited / declined, RFQs created via the agent, completed orders from agent sessions, cost per completed order. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const admin = await createAdminClient()
  return NextResponse.json(await procurementStats(admin), { headers: { 'Cache-Control': 'private, no-store' } })
}
