import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { munshiAdminStats } from '@/lib/agent/munshi'

/** GET /api/v1/agent/admin/munshi/stats (S2.2) — the console tile: this week's counts, providers enabled, the Phase 2 exit metric, cost per approved draft. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const admin = await createAdminClient()
  try {
    return NextResponse.json(await munshiAdminStats(admin), { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
