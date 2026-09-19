import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { AGENT_PERSONAS, AGENT_RUN_STATUSES } from '@amclub/shared'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'

/**
 * Admin runs list (S0.2) — every agent run across all users, filterable by
 * persona / status / since-date. Admin/ops only; agentApiGate first.
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
  const persona = sp.get('persona')
  const status = sp.get('status')
  const since = sp.get('since') // ISO date/time
  const limit = Math.min(Math.max(Number(sp.get('limit') ?? '100'), 1), 200)

  const admin = await createAdminClient()
  let q = admin
    .from('agent_runs')
    .select('id, user_id, persona, status, surface, subject_type, subject_id, cost_est_paise, input_tokens, output_tokens, error, created_at, updated_at, completed_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (persona && (AGENT_PERSONAS as readonly string[]).includes(persona)) q = q.eq('persona', persona)
  if (status && (AGENT_RUN_STATUSES as readonly string[]).includes(status)) q = q.eq('status', status)
  if (since) q = q.gte('created_at', since)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ runs: data ?? [] }, { headers: NO_STORE })
}
