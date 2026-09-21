import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { listTriages } from '@/lib/agent/triages'

/**
 * GET /api/v1/agent/admin/triages?status=pending|decided|all&dispute_id=&limit=
 * (S1.7) — the founder's triage list with dispute + order summary. Agent
 * surface: agentApiGate FIRST (404 while dark), then admin/ops.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const sp = request.nextUrl.searchParams
  const statusParam = sp.get('status')
  const status = statusParam === 'decided' || statusParam === 'all' ? statusParam : 'pending'
  const limit = Math.min(Math.max(Number(sp.get('limit') ?? '50'), 1), 200)
  const admin = await createAdminClient()
  try {
    return NextResponse.json({ triages: await listTriages(admin, { status, disputeId: sp.get('dispute_id'), limit }) }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
