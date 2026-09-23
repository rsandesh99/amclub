import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { supportStats } from '@/lib/support/tickets'

/** GET /api/v1/agent/admin/support/stats (S2.3) — open / in progress, median ack vs the 24 h SLA, the self-serve rate over 7 days, escalation reasons. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const admin = await createAdminClient()
  try {
    return NextResponse.json(await supportStats(admin), { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
