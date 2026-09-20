import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { dossierStats } from '@/lib/agent/dossiers'

/**
 * GET /api/v1/agent/admin/dossiers/stats (S1.4 §4e) — the /admin/agents
 * "Dossiers" tile: pending count, median completed→decision minutes, approve
 * rate (last 30 days). Agent surface: agentApiGate FIRST, then admin/ops.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const admin = await createAdminClient()
  try {
    return NextResponse.json(await dossierStats(admin), { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
