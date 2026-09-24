import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { agentToolNameSchema, type AgentPersona, type AgentToolName, type AiDecisionFeature } from '@amclub/shared'
import { createSupabaseLedger, signRuntimeCredential } from '@amclub/agent-core'
import { agentApiGate } from '@/lib/agent/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { env } from '@/lib/env'
import { OUTBOUND_TIMEOUT_MS } from '@/lib/outbound'

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
  /** S1.6 — extra REFS (ids only, never content) recorded next to run_id, e.g. { session_id, wa_message_id }. */
  input_refs: z.record(z.string().max(40), z.string().max(200)).optional(),
})

/** The ai_decisions.feature for a tool's confirmation; the generic runtime confirmation otherwise. */
const FEATURE_BY_TOOL: Partial<Record<AgentToolName, AiDecisionFeature>> = {
  confirm_onboarding_draft: 'onboarding', // S1.6
  submit_quote: 'munshi_draft', // S2.2 — the provider's tap on a Munshi quote draft
  ask_clarification: 'munshi_draft', // S2.2 — … on a Munshi question draft
  reply_thread: 'munshi_reply', // S2.2 — … on a Munshi thread reply
  nudge_counterparty: 'support_nudge', // S2.3 — the user's yes to a Support-agent nudge (WhatsApp)
}

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
  const { data: run } = await admin.from('agent_runs').select('id, user_id, persona, status, meta').eq('id', id).maybeSingle()
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
    // S3.1 — a procurement run's confirmation is procurement_step whatever the tool (nudge_counterparty included)
    feature: (run as { meta?: { agent?: string } | null }).meta?.agent === 'procurement' ? 'procurement_step' : (FEATURE_BY_TOOL[tool] ?? 'agent_tool'),
    runId: id,
    tool,
    inputRefs: { ...(parsed.data.input_refs ?? {}), run_id: id },
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
        // Audit M37: never hold the tap on a slow runtime; munshi.followup resumes approved runs it missed.
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS.internal),
      })
      resumed = res.ok
    } catch {
      resumed = false
    }
  }

  return NextResponse.json({ status: 'approved', decision_id: decision.id, resumed }, { headers: NO_STORE })
}
