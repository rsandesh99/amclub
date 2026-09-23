import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { benchmarkStats } from '@/lib/benchmarks/stats'

/** GET /api/v1/agent/admin/benchmarks/stats (S3.2) — the agents-console tile: switches, the last run, the table (aggregates only). */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const admin = await createAdminClient()
  return NextResponse.json(await benchmarkStats(admin), { headers: { 'Cache-Control': 'private, no-store' } })
}
