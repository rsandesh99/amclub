import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { adminPools } from '@/lib/pools/queries'

/**
 * GET /api/v1/agent/admin/pools (S3.4, ADR 024) — every group with its counts, including each closed group's
 * committed → quoted → paid numbers (the honest-commitment measure). Admin / ops only; 404 while AGENT_ENABLED is off.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const admin = await createAdminClient()
  return NextResponse.json({ pools: await adminPools(admin) }, { headers: { 'Cache-Control': 'private, no-store' } })
}
