import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { getTriage, summarize, triageHistory } from '@/lib/agent/triages'

/** GET /api/v1/agent/admin/triages/[id] (S1.7) — one triage with its dispute/order summary and the dispute's history. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const { id } = await params
  const admin = await createAdminClient()
  const triage = await getTriage(admin, id)
  if (!triage) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const [summary, history] = await Promise.all([summarize(admin, triage), triageHistory(admin, triage.dispute_id)])
  return NextResponse.json({ ...summary, history: history.map((h) => ({ id: h.id, created_at: h.created_at, recommendation: h.triage.recommendation, decision: h.decision })) }, { headers: { 'Cache-Control': 'private, no-store' } })
}
