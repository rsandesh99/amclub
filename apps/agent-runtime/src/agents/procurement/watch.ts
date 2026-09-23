import { applyProcurementPatch, procurementWatchAgent, runAgent } from '@amclub/agent-core'
import { deliver } from './deliver'
import { resumeProcurementRun } from './decide'
import {
  buyerTurns,
  cancelParkedRun,
  istDate,
  nowOf,
  persistSession,
  procurementAllowed,
  procurementSettings,
  proposalsLeft,
  resolveProposalTurn,
  sessionRow,
  sessionView,
  type ProcurementJobResult,
  type ProcurementRuntimeDeps,
  type SessionRow,
} from './store'

/**
 * S3.1 — procurement.watch (every 15 min; the web cron enqueues it): one run of `procurementWatchAgent` per ACTIVE
 * session. First the two stop rules, BEFORE any read: a revoked grant or the agent switched off (flag / cohort) closes
 * the session as failed with the reason and sends NOTHING further; STOP (the WhatsApp grant revoked, a web grant still
 * held) keeps the web mirror and only drops WhatsApp. Then: an approved-but-parked proposal (the web decision could not
 * reach the runtime) is resumed; the agent reads the request under the buyer's token and summarises / relays / chases /
 * closes. At most one proposal per session per tick (the run parks on it).
 */

const SESSION_COLS = 'id, user_id, msme_id, rfq_id, root_run_id, open_run_id, conversation_id, surface, state, locale, title, draft, pending, labels, last_seen, proposals_today, proposals_date, last_chase_at, expires_at, created_at'

export async function runProcurementWatch(deps: ProcurementRuntimeDeps, opts: { sessionIds?: readonly string[] } = {}): Promise<ProcurementJobResult> {
  if (!deps.agentEnabled) return { status: 'failed', error: 'agent_disabled' }
  const s = await procurementSettings(deps.admin)
  let q = deps.admin.from('procurement_sessions').select(SESSION_COLS).not('state', 'in', '("closed","expired","failed")').is('deleted_at', null).order('updated_at', { ascending: true }).limit(200)
  if (opts.sessionIds?.length) q = q.in('id', [...opts.sessionIds])
  const { data } = await q
  const rows = (data as SessionRow[] | null) ?? []
  const detail = { sessions: rows.length, stopped: 0, resumed: 0, runs: 0, proposed: 0, closed: 0, messages: 0, failed: 0 }
  const now = nowOf(deps)

  for (const row of rows) {
    const allowed = await procurementAllowed(deps, row.user_id)
    if (!allowed.ok) {
      // revoked / switched off: close as failed, cancel the parked proposal, send nothing
      await cancelParkedRun(deps, row.open_run_id, allowed.reason ?? 'grant_revoked')
      if (row.open_run_id) await resolveProposalTurn(deps.admin, row.open_run_id, 'cancelled')
      const view = await sessionView(deps, row)
      await persistSession(deps, row, { ...view, state: 'failed', pending: null }, { openRunId: null, closeReason: allowed.reason ?? 'grant_revoked' })
      detail.stopped++
      deps.capture?.(row.user_id, 'procurement_session_closed', { state: 'failed', reason: allowed.reason })
      continue
    }

    // the web decision's ping did not land: the ai_decisions row exists, the run still waits → resume here
    if (row.open_run_id) {
      const run = await deps.core.ledger.getRun(row.open_run_id)
      if (run?.status === 'awaiting_confirmation') {
        const { data: dec } = await deps.admin.from('ai_decisions').select('id, tool, final').eq('run_id', row.open_run_id).order('created_at', { ascending: false }).limit(1).maybeSingle()
        const d = dec as { id: string; tool: string | null; final: Record<string, unknown> | null } | null
        if (d?.tool) {
          await resumeProcurementRun(deps, { runId: row.open_run_id, userId: row.user_id, tool: d.tool, payload: d.final ?? {}, decisionId: d.id, scopes: allowed.scopes })
          detail.resumed++
          continue
        }
      } else if (run && run.status !== 'running') {
        // cancelled / failed elsewhere (a web No, a superseded draft): clear the pointer
        await deps.admin.from('procurement_sessions').update({ open_run_id: null }).eq('id', row.id).eq('open_run_id', row.open_run_id)
        row.open_run_id = null
      }
    }

    const view = await sessionView(deps, row)
    const turns = await buyerTurns(deps.admin, row.id)
    const result = await runAgent(
      procurementWatchAgent,
      { ...deps.core, scopes: allowed.scopes, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
      { userId: row.user_id, surface: 'system', subjectType: 'procurement_session', subjectId: row.id, parentRunId: row.root_run_id, meta: { agent: 'procurement', job: 'watch' } },
      { session: view, now: now.toISOString(), today: istDate(now), chaseHours: s.chaseHours, buyerTurns: turns, proposalsLeft: proposalsLeft(row, s, now), appUrl: deps.apiUrl, nudgeVia: row.surface === 'whatsapp' ? 'whatsapp' : row.surface },
    )
    detail.runs++
    if (result.status === 'failed') {
      detail.failed++
      console.warn(`[procurement] watch run ${result.runId} for session ${row.id}: ${result.error}`)
      continue
    }
    const out = result.output
    let next = applyProcurementPatch(view, out.patch).session
    let closeReason: string | undefined
    if (out.close) {
      await cancelParkedRun(deps, row.open_run_id, out.close.reason)
      if (row.open_run_id) await resolveProposalTurn(deps.admin, row.open_run_id, 'cancelled')
      next = applyProcurementPatch(next, { states: [out.close.state] }).session
      closeReason = out.close.reason
      detail.closed++
    }
    const parked = result.status === 'awaiting_confirmation' && !!out.proposal
    const saved = await persistSession(deps, row, next, { ...(parked ? { openRunId: result.runId } : {}), proposed: out.proposed, ...(closeReason ? { closeReason } : {}) })
    if (!saved) {
      // a concurrent turn moved the session: the next tick re-reads it (never send over a stale state)
      if (parked) await cancelParkedRun(deps, result.runId, 'stale_watch')
      continue
    }
    if (parked) detail.proposed++
    const fresh = (await sessionRow(deps.admin, row.id)) ?? row
    // proactive: WhatsApp whenever the buyer's WhatsApp grant carries the scopes (STOP drops it; the mirror remains)
    const d = await deliver(deps, fresh, out, { runId: parked ? result.runId : null, whatsapp: allowed.whatsapp, messageId: null })
    detail.messages += d.sent
    if (out.close) deps.capture?.(row.user_id, 'procurement_session_closed', { state: out.close.state, reason: out.close.reason })
    for (const r of out.replies) if (r.reply.key === 'quotes_summary') deps.capture?.(row.user_id, 'procurement_quotes_summarised', { rfq_id: row.rfq_id })
    if (parked) deps.capture?.(row.user_id, 'procurement_proposed', { tool: out.proposal!.tool, surface: 'watch' })
  }
  return { status: 'ok', detail }
}
