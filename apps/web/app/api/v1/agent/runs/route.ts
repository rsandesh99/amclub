import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { getAuthedSupabase } from '@/lib/auth/request'

/**
 * GET /api/v1/agent/runs — the caller's own agent runs (RLS self read).
 * 404s while AGENT_ENABLED=false.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET() {
  const gate = agentApiGate()
  if (gate) return gate
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data, error } = await supabase
    .from('agent_runs')
    .select('id, persona, status, surface, subject_type, subject_id, cost_est_paise, created_at, updated_at, completed_at')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ runs: data ?? [] }, { headers: NO_STORE })
}
