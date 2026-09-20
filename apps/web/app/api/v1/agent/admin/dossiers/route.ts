import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { listDossiers } from '@/lib/agent/dossiers'

/**
 * GET /api/v1/agent/admin/dossiers?status=pending|decided|all&order_id=&limit=
 * (S1.4 §4d) — the founder's dossier list with order + payout summary. Agent
 * surface: agentApiGate FIRST (404 while dark), then admin/ops.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(request: NextRequest) {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error

  const sp = request.nextUrl.searchParams
  const statusParam = sp.get('status')
  const status = statusParam === 'decided' || statusParam === 'all' ? statusParam : 'pending'
  const orderId = sp.get('order_id')
  const limit = Math.min(Math.max(Number(sp.get('limit') ?? '50'), 1), 200)

  const admin = await createAdminClient()
  try {
    const dossiers = await listDossiers(admin, { status, orderId, limit })
    return NextResponse.json({ dossiers }, { headers: NO_STORE })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
