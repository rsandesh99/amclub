import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { agentToolNameSchema, type AgentPersona } from '@amclub/shared'
import { createSupabaseLedger, signRuntimeCredential } from '@amclub/agent-core'
import { agentApiGate } from '@/lib/agent/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { env } from '@/lib/env'

/**
 * POST /api/v1/agent/runs/[id]/decision — the SURFACE records the user's yes/no
 * on a parked run (ARCHITECTURE.md §3 confirm gate). Approve writes the single
 * ai_decisions row bound to (run_id, tool) — the runner's resume gate reads it
 * — plus a 'confirmed' event, then pings the runtime to resume. Decline records
 * a 'declined' event and cancels the run. The model never records consent.
 * ai_decisions/agent_events are service-role writes, so we use the admin client
 * AFTER an explicit owner check (the run must belong to the caller).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const bodySchema = z.object({
  approve: z.boolean(),
  final: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().max(500).optional(),
})

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = agentApiGate()
  if (gate) return gate
  const { id } = await params
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const rl = await enforce(limiters.authed, `agent-decision:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const { data: run } = await admin.from('agent_runs').select('id, user_id, persona, status').eq('id', id).maybeSingle()
  if (!run || (run as { user_id: string }).user_id !== userId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if ((run as { status: string }).status !== 'awaiting_confirmation') {
    return NextResponse.json({ error: 'not_awaiting_confirmation' }, { status: 409 })
  }

  // The pending tool + proposed payload come from the latest confirmation_requested event.
  const { data: evs } = await admin
    .from('agent_events')
    .select('tool, payload')
    .eq('run_id', id)
    .eq('kind', 'confirmation_requested')
    .order('created_at', { ascending: false })
    .limit(1)
  const ev = (evs ?? [])[0] as { tool: string | null; payload: Record<string, unknown> | null } | undefined
  const toolParsed = agentToolNameSchema.safeParse(ev?.tool)
  if (!ev || !toolParsed.success) return NextResponse.json({ error: 'no_pending_confirmation' }, { status: 409 })
  const tool = toolParsed.data
  const proposed = (ev.payload ?? {}) as Record<string, unknown>

  const ledger = createSupabaseLedger(admin)

  if (!parsed.data.approve) {
    await ledger.appendEvent({ runId: id, kind: 'declined', tool, actor: 'user', payload: { reason: parsed.data.reason ?? null } })
    try {
      await ledger.transitionRun(id, 'awaiting_confirmation', 'cancelled')
    } catch {
      return NextResponse.json({ error: 'run_advanced' }, { status: 409 })
    }
    return NextResponse.json({ status: 'declined' }, { headers: NO_STORE })
  }

  const final = parsed.data.final ?? proposed
  const decision = await ledger.recordDecision({
    feature: 'agent_tool',
    runId: id,
    tool,
    inputRefs: { run_id: id },
    proposed,
    final,
    decidedBy: userId,
  })
  await ledger.appendEvent({ runId: id, kind: 'confirmed', tool, actor: 'user', payload: { decision_id: decision.id } })

  // Ping the runtime to resume (it verifies the ai_decisions row before acting).
  let resumed = false
  const runtimeUrl = env.AGENT_RUNTIME_URL
  const runtimeSecret = env.AGENT_RUNTIME_SECRET
  if (runtimeUrl && runtimeSecret) {
    try {
      const cred = signRuntimeCredential(runtimeSecret, { userId, persona: (run as { persona: AgentPersona }).persona, runId: id })
      const res = await fetch(`${runtimeUrl}/internal/runs/${id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `AMC-Runtime ${cred}` },
        body: JSON.stringify({ decisionId: decision.id, tool, final }),
      })
      resumed = res.ok
    } catch {
      resumed = false
    }
  }

  return NextResponse.json({ status: 'approved', decision_id: decision.id, resumed }, { headers: NO_STORE })
}
