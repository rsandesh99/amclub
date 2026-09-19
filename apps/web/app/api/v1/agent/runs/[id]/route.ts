import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { getAuthedSupabase } from '@/lib/auth/request'

/**
 * GET /api/v1/agent/runs/[id] — one run + its append-only event trace (RLS: the
 * self-read policies return only the caller's own run and events).
 * 404s while AGENT_ENABLED=false, and 404s a run the caller does not own.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = agentApiGate()
  if (gate) return gate
  const { id } = await params
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: run } = await supabase
    .from('agent_runs')
    .select('id, persona, status, surface, subject_type, subject_id, cost_est_paise, input_tokens, output_tokens, error, created_at, updated_at, completed_at')
    .eq('id', id)
    .maybeSingle()
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: events } = await supabase
    .from('agent_events')
    .select('id, kind, tool, actor, payload, created_at')
    .eq('run_id', id)
    .order('created_at', { ascending: true })

  return NextResponse.json({ run, events: events ?? [] }, { headers: NO_STORE })
}
