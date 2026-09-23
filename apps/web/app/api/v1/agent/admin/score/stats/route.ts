import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { scoreStats } from '@/lib/score/card'

/** GET /api/v1/agent/admin/score/stats (S2.4) — the agents-console tile: distribution per side, gated share, median, this week's movers. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const admin = await createAdminClient()
  return NextResponse.json(await scoreStats(admin), { headers: { 'Cache-Control': 'private, no-store' } })
}
