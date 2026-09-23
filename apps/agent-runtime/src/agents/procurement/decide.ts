import {
  AgentRun,
  AgentRunError,
  applyProcurementPatch,
  procurementDeclineEffect,
  procurementResumeEffect,
  type RunContext,
  type ToolCallResult,
} from '@amclub/agent-core'
import { agentToolNameSchema, voiceMayConfirm } from '@amclub/shared'
import { deliver } from './deliver'
import {
  persistSession,
  procurementAllowed,
  resolveProposalTurn,
  sessionByOpenRun,
  sessionRow,
  sessionView,
  type ProcurementJobResult,
  type ProcurementRuntimeDeps,
  type SessionRow,
} from './store'

/**
 * S3.1 — procurement.decide: the buyer's tap on a proposal (a WhatsApp button, a web / mobile tap, or an allow-listed
 * spoken / typed yes for a voice-confirmable tool). Approval = the decision route under the buyer's delegated token
 * (the ONE ai_decisions writer; feature procurement_step) then the runner's resume → the ORDINARY route runs the write
 * (choose_quote runs none: its effect is the decision-bound link to the pay page). No / Edit = a declined decision; the
 * run is cancelled. A button-only tool (choose / decline / the chase nudge) is never approved by a spoken / typed yes.
 */

export interface ProcurementDecideJob {
  kind: 'decide'
  runId: string
  userId: string
  action: 'ok' | 'edit' | 'no'
  /** `text_no` = a typed "no" to the open proposal (the dispatcher's card rule, 2026-09-23); only ever with action 'no'. */
  via: 'whatsapp_button' | 'voice_yes' | 'text_yes' | 'web_text_yes' | 'web' | 'text_no'
  messageId?: string | null
  jobId?: string | null
}

function runContext(deps: ProcurementRuntimeDeps, args: { runId: string; userId: string; scopes: readonly string[] }): RunContext {
  return {
    runId: args.runId,
    userId: args.userId,
    persona: 'buyer',
    ledger: deps.core.ledger,
    gateway: deps.core.gateway,
    budget: deps.core.makeBudget({ runId: args.runId, userId: args.userId, agentName: 'procurement' }),
    apiBaseUrl: deps.apiUrl,
    getToken: () => deps.core.makeToken({ runId: args.runId, persona: 'buyer', userId: args.userId }),
    scopes: args.scopes,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  }
}

async function proposedPayload(deps: ProcurementRuntimeDeps, runId: string): Promise<{ tool: string | null; payload: Record<string, unknown> }> {
  const { data } = await deps.admin.from('agent_events').select('tool, payload').eq('run_id', runId).eq('kind', 'confirmation_requested').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const ev = data as { tool: string | null; payload: Record<string, unknown> | null } | null
  return { tool: ev?.tool ?? null, payload: ev?.payload ?? {} }
}

async function postDecision(deps: ProcurementRuntimeDeps, args: { runId: string; userId: string; body: Record<string, unknown> }): Promise<{ ok: boolean; status: number; decisionId: string | null; resumed: boolean; error: string | null }> {
  const f = deps.fetchImpl ?? fetch
  try {
    const token = await deps.tokenFor({ runId: args.runId, userId: args.userId })
    const res = await f(`${deps.apiUrl}/api/v1/agent/runs/${args.runId}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(args.body) })
    const json = (await res.json().catch(() => null)) as { decision_id?: string; resumed?: boolean; error?: string } | null
    return { ok: res.ok, status: res.status, decisionId: json?.decision_id ?? null, resumed: json?.resumed === true, error: json?.error ?? null }
  } catch (e) {
    return { ok: false, status: 0, decisionId: null, resumed: false, error: (e as Error).message }
  }
}

async function sessionForRun(deps: ProcurementRuntimeDeps, runId: string): Promise<SessionRow | null> {
  const open = await sessionByOpenRun(deps.admin, runId)
  if (open) return open
  const { data } = await deps.admin.from('procurement_turns').select('session_id').eq('run_id', runId).limit(1).maybeSingle()
  return (data as { session_id?: string } | null)?.session_id ? sessionRow(deps.admin, (data as { session_id: string }).session_id) : null
}

/**
 * After the ordinary route ran (or refused): the session patch + the buyer's reply, the card resolved. Shared by the
 * WhatsApp decide, the web decision's runtime ping (server.ts) and the watcher's fallback. Guarded on open_run_id.
 */
export async function finalizeProcurementRun(deps: ProcurementRuntimeDeps, runId: string, result: ToolCallResult | null, error: string | null, decisionId: string | null): Promise<void> {
  const row = await sessionByOpenRun(deps.admin, runId)
  if (!row) return
  const allowed = await procurementAllowed(deps, row.user_id)
  const { tool, payload } = await proposedPayload(deps, runId)
  const view = await sessionView(deps, { ...row, open_run_id: null })
  const eff = procurementResumeEffect({ tool: tool ?? '', result, error, session: view, payload, decisionId, appUrl: deps.apiUrl })
  const applied = applyProcurementPatch(view, eff.patch)
  for (const i of applied.illegal) console.warn('[procurement] illegal session step dropped', row.id, i)
  await persistSession(deps, row, applied.session, { openRunId: null })
  await resolveProposalTurn(deps.admin, runId, result?.ok ? 'approved' : 'failed')
  const fresh = (await sessionRow(deps.admin, row.id)) ?? row
  await deliver(deps, fresh, { replies: [{ reply: eff.reply, buttons: null }], proposal: null }, { runId: null, whatsapp: allowed.whatsapp && row.surface === 'whatsapp', messageId: null })
  deps.capture?.(row.user_id, 'procurement_step_decided', { tool, outcome: result?.ok ? 'approved' : 'failed', status: result?.status ?? null, surface: row.surface })
  if (tool === 'choose_quote' && result?.ok) deps.capture?.(row.user_id, 'procurement_checkout_link_sent', { rfq_id: payload['rfq_id'] ?? null })
}

/** Resume a parked run in-process after an approved decision (the web ping did not, or we ARE the runtime). */
export async function resumeProcurementRun(deps: ProcurementRuntimeDeps, args: { runId: string; userId: string; tool: string; payload: Record<string, unknown>; decisionId: string | null; scopes: readonly string[] }): Promise<void> {
  const toolParsed = agentToolNameSchema.safeParse(args.tool)
  if (!toolParsed.success) return
  const run = new AgentRun(runContext(deps, { runId: args.runId, userId: args.userId, scopes: args.scopes }))
  try {
    const outcome = await run.resume(toolParsed.data, args.payload, args.decisionId ? { decisionId: args.decisionId } : undefined)
    try {
      await run.complete()
    } catch {
      /* completed by a concurrent resume */
    }
    await finalizeProcurementRun(deps, args.runId, outcome.status === 'done' ? outcome.result : null, null, args.decisionId)
  } catch (e) {
    const msg = e instanceof AgentRunError ? e.code : (e as Error).message
    await run.fail(msg)
    await finalizeProcurementRun(deps, args.runId, null, msg, args.decisionId)
  }
}

export async function decideProcurement(deps: ProcurementRuntimeDeps, job: ProcurementDecideJob): Promise<ProcurementJobResult> {
  if (!deps.agentEnabled) return { status: 'failed', error: 'agent_disabled' }
  const run = await deps.core.ledger.getRun(job.runId)
  if (!run) return { status: 'failed', error: 'run_gone' }
  if (run.userId !== job.userId) return { status: 'failed', error: 'message_conversation_mismatch' }
  const row = await sessionForRun(deps, job.runId)
  if (!row || row.user_id !== job.userId) return { status: 'failed', error: 'session_not_found' }
  const allowed = await procurementAllowed(deps, job.userId)
  if (!allowed.ok) return { status: 'failed', error: allowed.reason ?? 'grant_revoked' }
  const whatsapp = allowed.whatsapp && row.surface === 'whatsapp'
  const gone = async () => {
    await deliver(deps, row, { replies: [{ reply: { source: 'procurement', key: 'proposal_gone', slots: {} }, buttons: null }], proposal: null }, { runId: null, whatsapp, messageId: null })
    return { status: 'ok' as const, detail: { outcome: 'proposal_gone' } }
  }
  if (run.status !== 'awaiting_confirmation' || row.open_run_id !== job.runId) return gone()
  const { tool, payload } = await proposedPayload(deps, job.runId)
  if (!tool) return gone()
  // a spoken / typed yes never approves a money-adjacent (button-only) tool
  if (job.action === 'ok' && job.via !== 'whatsapp_button' && job.via !== 'web' && !voiceMayConfirm(tool)) return { status: 'ok', detail: { outcome: 'needs_button', tool } }
  const inputRefs: Record<string, string> = { procurement_session_id: row.id, via: job.via, ...(job.messageId ? { wa_message_id: job.messageId } : {}) }

  if (job.action !== 'ok') {
    const r = await postDecision(deps, { runId: job.runId, userId: job.userId, body: { approve: false, reason: job.action === 'edit' ? 'edited' : 'declined', input_refs: inputRefs } })
    const view = await sessionView(deps, { ...row, open_run_id: null })
    const eff = procurementDeclineEffect({ tool, action: job.action, session: view, appUrl: deps.apiUrl })
    const applied = applyProcurementPatch(view, eff.patch)
    await persistSession(deps, row, applied.session, { openRunId: null, ...(eff.patch.closeReason ? { closeReason: eff.patch.closeReason } : {}) })
    await resolveProposalTurn(deps.admin, job.runId, job.action === 'edit' ? 'edited' : 'declined')
    const fresh = (await sessionRow(deps.admin, row.id)) ?? row
    await deliver(deps, fresh, { replies: [{ reply: eff.reply, buttons: null }], proposal: null }, { runId: null, whatsapp, messageId: null })
    deps.capture?.(row.user_id, 'procurement_step_decided', { tool, outcome: job.action === 'edit' ? 'edited' : 'declined', via: job.via })
    return { status: 'ok', detail: { outcome: job.action, decision_status: r.status } }
  }

  const r = await postDecision(deps, { runId: job.runId, userId: job.userId, body: { approve: true, final: payload, input_refs: inputRefs } })
  let decisionId = r.decisionId
  if (!r.ok && r.status === 409) {
    // a replayed button: the decision may already exist; resume idempotently
    const { data: dec } = await deps.admin.from('ai_decisions').select('id').eq('run_id', job.runId).eq('tool', tool).limit(1).maybeSingle()
    decisionId = (dec as { id: string } | null)?.id ?? null
  }
  if (!r.ok && !decisionId) {
    await deliver(deps, row, { replies: [{ reply: { source: 'procurement', key: 'failed', slots: { link: `${deps.apiUrl}/app/assistant` } }, buttons: null }], proposal: null }, { runId: null, whatsapp, messageId: null })
    return { status: 'failed', error: `decision_failed:${r.status}:${r.error ?? ''}` }
  }
  if (!r.resumed) await resumeProcurementRun(deps, { runId: job.runId, userId: job.userId, tool, payload, decisionId, scopes: allowed.scopes })
  return { status: 'ok', detail: { outcome: 'approved', tool, resumed_by: r.resumed ? 'web_ping' : 'in_process' } }
}
