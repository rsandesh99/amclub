import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'

/**
 * Admin run detail (S0.2) — one run with its event trace, per-call invocations
 * (task class, tier, tokens, paise cost), and the confirmation decisions bound
 * to it. Admin/ops only; agentApiGate first.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const { id } = await params
  const admin = await createAdminClient()

  const { data: run } = await admin
    .from('agent_runs')
    .select('id, user_id, persona, status, surface, subject_type, subject_id, cost_est_paise, input_tokens, output_tokens, error, meta, parent_run_id, job_id, created_at, updated_at, completed_at')
    .eq('id', id)
    .maybeSingle()
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [{ data: events }, { data: invocations }, { data: decisions }] = await Promise.all([
    admin.from('agent_events').select('id, kind, tool, actor, payload, created_at').eq('run_id', id).order('created_at', { ascending: true }),
    admin.from('ai_invocations').select('id, task_class, tier, vendor, status, latency_ms, cost_est_paise, input_tokens, output_tokens, created_at').eq('run_id', id).order('created_at', { ascending: true }),
    admin.from('ai_decisions').select('id, feature, tool, corrected_fields, decided_by, decided_at').eq('run_id', id).order('decided_at', { ascending: true }),
  ])

  return NextResponse.json({ run, events: events ?? [], invocations: invocations ?? [], decisions: decisions ?? [] }, { headers: NO_STORE })
}
