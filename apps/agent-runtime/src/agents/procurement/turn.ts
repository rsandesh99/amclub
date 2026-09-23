import {
  applyProcurementPatch,
  procurementTurnAgent,
  readUtteranceOnProposal,
  runAgent,
  signRuntimeCredential,
  type ProcurementAgentOutput,
  type ProcurementMedia,
} from '@amclub/agent-core'
import { renderSupportReply, ticketRefFromId, toProcurementLocale, toSupportLocale } from '@amclub/shared'
import { transcribeVoiceNote } from '../onboarding/stt'
import { deliver, renderReply } from './deliver'
import { decideProcurement } from './decide'
import {
  buyerTurns,
  cancelParkedRun,
  createSession,
  istDate,
  nowOf,
  persistSession,
  procurementAllowed,
  procurementSettings,
  proposalsLeft,
  recordTurn,
  resolveProposalTurn,
  sessionRow,
  sessionView,
  type ProcurementJobResult,
  type ProcurementRuntimeDeps,
  type SessionRow,
} from './store'

/**
 * S3.1 — procurement.turn: ONE buyer message (a WhatsApp message or a web / mobile composer turn) → ONE run of
 * `procurementTurnAgent` (agent-core; harness-proven), under a token minted from the buyer's own grant. A typed /
 * spoken reply to an open proposal is read by CODE first (`readUtteranceOnProposal`): an allow-listed yes approves a
 * voice-confirmable tool; for a button-only tool the buttons are sent again and nothing is recorded.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ProcurementTurnJob {
  kind: 'turn'
  userId: string
  surface: 'whatsapp' | 'web' | 'mobile'
  /** The session the message belongs to; null = start one (the new_need offer, the web assistant's first message). */
  sessionId: string | null
  conversationId?: string | null
  /** A wa_messages id (WhatsApp) … */
  messageId?: string | null
  /** … or a procurement_turns id (the web / mobile composer already stored the buyer's turn). */
  turnId?: string | null
  forced?: { label?: string; sessionChoice?: 'new' | 'current' } | null
  jobId?: string | null
}

const NIL = '00000000-0000-0000-0000-000000000000'

async function msmeIdOf(deps: ProcurementRuntimeDeps, userId: string): Promise<string | null> {
  // a suspended buyer (msme_profiles.deleted_at) has no buyer identity (PR #15 rule)
  const { data } = await deps.admin.from('msme_profiles').select('id').eq('user_id', userId).is('deleted_at', null).maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

async function mediaOf(deps: ProcurementRuntimeDeps, msg: { kind: string; media_ref: string | null; mime: string | null }): Promise<ProcurementMedia | null> {
  if (!msg.media_ref) return null
  const kind = msg.kind === 'audio' ? 'audio' : msg.kind === 'image' || msg.kind === 'document' ? 'document' : null
  if (!kind) return null
  const { data, error } = await deps.admin.storage.from(deps.mediaBucket).download(msg.media_ref)
  if (error || !data) return null
  const bytes = new Uint8Array(await data.arrayBuffer())
  const mime = (msg.mime ?? (kind === 'audio' ? 'audio/ogg' : 'image/jpeg')).split(';')[0]!.trim()
  const ext = mime.includes('pdf') ? 'pdf' : mime.includes('png') ? 'png' : kind === 'audio' ? 'ogg' : 'jpg'
  return { kind, bytes, mime, name: `whatsapp-${kind}.${ext}` }
}

/** The S2.3 ticket path (runtime credential → the web ticket route); the conversation then goes quiet until a human resolves it. */
async function openTicket(deps: ProcurementRuntimeDeps, row: SessionRow, args: { runId: string; text: string }): Promise<string | null> {
  if (!deps.runtimeSecret) return null
  try {
    const cred = signRuntimeCredential(deps.runtimeSecret, { userId: row.user_id, persona: 'buyer', runId: args.runId })
    const f = deps.fetchImpl ?? fetch
    const turns = await buyerTurns(deps.admin, row.id, 5)
    const res = await f(`${deps.apiUrl}/api/v1/agent/admin/support/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `AMC-Runtime ${cred}` },
      body: JSON.stringify({ user_id: row.user_id, role: 'buyer', channel: row.surface, conversation_id: row.surface === 'whatsapp' ? row.conversation_id : null, locale: toProcurementLocale(row.locale), reason: 'procurement_escalated', intent: 'procurement', rfq_id: row.rfq_id, run_id: args.runId, transcript: [...turns.map((t) => ({ id: t.id, role: 'user' as const, text: t.text.slice(0, 2000) })), { id: `now-${args.runId}`, role: 'user' as const, text: args.text.slice(0, 2000) }].slice(-12) }),
    })
    const body = (await res.json().catch(() => null)) as { ticket_id?: string; ticket_ref?: string } | null
    return res.ok && body?.ticket_id ? (body.ticket_ref ?? ticketRefFromId(body.ticket_id)) : null
  } catch (e) {
    console.warn('[procurement] ticket route failed', (e as Error).message)
    return null
  }
}

/** Is a support ticket open for this buyer on this surface (the S2.3 halt: the agent stays quiet)? */
async function ticketOpen(deps: ProcurementRuntimeDeps, row: SessionRow): Promise<boolean> {
  if (row.surface === 'whatsapp' && row.conversation_id) {
    const { data } = await deps.admin.from('wa_conversations').select('support_ticket_id').eq('id', row.conversation_id).maybeSingle()
    if ((data as { support_ticket_id?: string | null } | null)?.support_ticket_id) return true
  }
  const { data } = await deps.admin.from('support_tickets').select('id').eq('user_id', row.user_id).eq('channel', row.surface).neq('status', 'resolved').is('deleted_at', null).limit(1)
  return Array.isArray(data) && data.length > 0
}

/** Re-send the open proposal's card (the buttons) — a typed yes to a button-only tool never confirms it. */
async function resendCard(deps: ProcurementRuntimeDeps, row: SessionRow, runId: string, whatsapp: boolean): Promise<void> {
  const { data } = await deps.admin.from('procurement_turns').select('body, proposal').eq('run_id', runId).eq('role', 'agent').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const t = data as { body: string | null; proposal: { tool?: string; edit?: boolean } | null } | null
  if (!t?.body) return
  await deliver(deps, row, { replies: [{ reply: { source: 'procurement', key: 'busy', slots: {} }, buttons: { kind: 'decision', edit: !!t.proposal?.edit } }], proposal: { tool: t.proposal?.tool ?? 'unknown', payload: {} } }, { runId, whatsapp, messageId: null })
}

export async function runProcurementTurn(deps: ProcurementRuntimeDeps, job: ProcurementTurnJob): Promise<ProcurementJobResult> {
  const allowed = await procurementAllowed(deps, job.userId)
  if (!allowed.ok) return { status: 'failed', error: allowed.reason ?? 'agent_disabled' }
  const msmeId = await msmeIdOf(deps, job.userId)
  if (!msmeId) return { status: 'failed', error: 'no_profile' }
  const s = await procurementSettings(deps.admin)

  // the message
  let text = ''
  let media: ProcurementMedia | null = null
  let waMessageId: string | null = null
  let locale = 'en'
  let conversationId = job.conversationId ?? null
  if (job.messageId) {
    const { data: msg } = await deps.admin.from('wa_messages').select('id, conversation_id, kind, body, media_ref, mime').eq('id', job.messageId).maybeSingle()
    if (!msg) return { status: 'failed', error: 'message_not_found' }
    const { data: conv } = await deps.admin.from('wa_conversations').select('id, user_id, locale').eq('id', (msg as any).conversation_id).maybeSingle()
    if (!conv || (conv as any).user_id !== job.userId) return { status: 'failed', error: 'message_conversation_mismatch' }
    conversationId = (conv as any).id
    locale = (conv as any).locale ?? 'en'
    waMessageId = (msg as any).id
    text = String((msg as any).body ?? '')
    if ((msg as any).kind === 'button') text = ''
    media = (msg as any).kind === 'text' || (msg as any).kind === 'button' ? null : await mediaOf(deps, msg as any)
  } else if (job.turnId) {
    const { data: t } = await deps.admin.from('procurement_turns').select('id, session_id, user_id, body').eq('id', job.turnId).maybeSingle()
    if (!t || (t as any).user_id !== job.userId) return { status: 'failed', error: 'message_not_found' }
    text = String((t as any).body ?? '')
  }
  const { data: u } = await deps.admin.from('users').select('preferred_locale').eq('id', job.userId).maybeSingle()
  if (!job.messageId) locale = (u as { preferred_locale?: string } | null)?.preferred_locale ?? 'en'

  // the session: the given one while active; a new one for "new request" / the start offer / the first web message
  let row: SessionRow | null = job.sessionId && job.forced?.sessionChoice !== 'new' ? await sessionRow(deps.admin, job.sessionId) : null
  if (row && ['closed', 'expired', 'failed'].includes(row.state)) row = null
  if (!row) row = await createSession(deps, { userId: job.userId, msmeId, surface: job.surface, conversationId: job.surface === 'whatsapp' ? conversationId : null, locale })
  if (!row) return { status: 'failed', error: 'session_insert_failed' }
  if (row.user_id !== job.userId) return { status: 'failed', error: 'session_not_found' }
  const whatsapp = allowed.whatsapp && row.surface === 'whatsapp'

  // the S2.3 halt: an open support ticket → the message is stored, the agent stays quiet
  if (await ticketOpen(deps, row)) {
    if (job.messageId && text) await recordTurn(deps, { sessionId: row.id, userId: row.user_id, role: 'user', surface: row.surface, body: text, waMessageId })
    return { status: 'ok', detail: { outcome: 'ticket_open' } }
  }

  // a web "new request" tap re-runs the original turn in a NEW session: copy the buyer's words into its thread
  if (job.turnId && job.forced?.sessionChoice === 'new' && text) await recordTurn(deps, { sessionId: row.id, userId: row.user_id, role: 'user', surface: row.surface, body: text })
  // the buyer's turn in the mirror (the web composer stored its own)
  if (job.messageId && !job.forced && (text || media)) await recordTurn(deps, { sessionId: row.id, userId: row.user_id, role: 'user', surface: row.surface, body: text || (media?.kind === 'audio' ? '🎤' : '📎'), waMessageId })

  let view = await sessionView(deps, row)

  // a reply to an open proposal: the allow-list first (code, never a model)
  if (view.openProposal && !job.forced && (text || media?.kind === 'audio')) {
    let said = text
    if (!said && media?.kind === 'audio' && job.messageId) {
      const token = await deps.tokenFor({ runId: view.openProposal.runId, userId: row.user_id }).catch(() => '')
      const { data: msg } = await deps.admin.from('wa_messages').select('media_ref, mime').eq('id', job.messageId).maybeSingle()
      if (token && (msg as any)?.media_ref) {
        const t = await transcribeVoiceNote({ admin: deps.admin, bucket: deps.mediaBucket, mediaRef: (msg as any).media_ref, mime: (msg as any).mime, apiUrl: deps.apiUrl, token, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) })
        if (t.ok) said = t.text
      }
    }
    const read = said ? readUtteranceOnProposal(view.openProposal.tool, said, view.locale) : 'not_a_yes'
    if (read === 'approve') return decideProcurement(deps, { kind: 'decide', runId: view.openProposal.runId, userId: row.user_id, action: 'ok', via: media?.kind === 'audio' ? 'voice_yes' : row.surface === 'whatsapp' ? 'text_yes' : 'web_text_yes', messageId: job.messageId ?? null })
    if (read === 'resend_buttons') {
      await resendCard(deps, row, view.openProposal.runId, whatsapp)
      deps.capture?.(row.user_id, 'procurement_yes_needs_button', { tool: view.openProposal.tool })
      return { status: 'ok', detail: { outcome: 'buttons_resent', tool: view.openProposal.tool } }
    }
    if (said && !text) text = said
    if (media?.kind === 'audio' && said) media = null
  }

  const now = nowOf(deps)
  const result = await runAgent(
    procurementTurnAgent,
    { ...deps.core, scopes: allowed.scopes, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
    { userId: row.user_id, surface: row.surface, subjectType: 'procurement_session', subjectId: row.id, parentRunId: row.root_run_id, jobId: job.jobId ?? null, meta: { agent: 'procurement', job: 'turn', message_id: job.messageId ?? job.turnId ?? null } },
    {
      session: view,
      message: { id: job.messageId ?? job.turnId ?? NIL, text, channel: row.surface === 'whatsapp' ? 'whatsapp' : 'support_chat', media },
      forced: job.forced ?? null,
      proposalsLeft: proposalsLeft(row, s, now),
      appUrl: deps.apiUrl,
      today: istDate(now),
    },
  )
  if (result.status === 'failed') {
    // a budget / step cap fails cleanly: nothing proposed, the session unchanged, one honest message
    if (/^(budget_|step_budget)/.test(result.error)) await deliver(deps, row, { replies: [{ reply: { source: 'procurement', key: 'failed', slots: { link: `${deps.apiUrl}/app/assistant` } }, buttons: null }], proposal: null }, { runId: null, whatsapp, messageId: null })
    deps.capture?.(row.user_id, 'procurement_turn', { surface: row.surface, outcome: 'failed', error: result.error })
    return { status: 'failed', error: result.error }
  }
  const out: ProcurementAgentOutput = result.output
  if (out.patch.cancelOpenProposal && view.openProposal) {
    await cancelParkedRun(deps, view.openProposal.runId, 'superseded')
    await resolveProposalTurn(deps.admin, view.openProposal.runId, 'cancelled')
  }
  const applied = applyProcurementPatch(view, out.patch)
  for (const i of applied.illegal) console.warn('[procurement] illegal session step dropped', row.id, i)
  view = applied.session
  const parked = result.status === 'awaiting_confirmation' && !!out.proposal
  const openRun = parked ? { openRunId: result.runId } : out.patch.cancelOpenProposal ? { openRunId: null } : {}
  await persistSession(deps, row, view, { ...openRun, rootRunId: result.runId, buyerTurn: true, proposed: out.proposed, ...(out.patch.closeReason ? { closeReason: out.patch.closeReason } : {}) })
  const fresh = (await sessionRow(deps.admin, row.id)) ?? row

  if (out.escalate) {
    const ref = await openTicket(deps, fresh, { runId: result.runId, text })
    const reply = renderSupportReply('escalated', { sla_hours: 24, sla_days: 15, contact: 'support@amclub.in / +91 83411 15455', ticket_ref: ref ?? '' }, toSupportLocale(view.locale))
    await deliver(deps, fresh, { replies: [{ reply: { source: 'support', key: 'escalated', slots: { sla_hours: 24, sla_days: 15, contact: 'support@amclub.in / +91 83411 15455', ticket_ref: ref ?? '' } }, buttons: null }], proposal: null }, { runId: null, whatsapp, messageId: null })
    deps.capture?.(row.user_id, 'procurement_turn', { surface: row.surface, outcome: 'escalated', ticket: !!ref })
    return { status: 'ok', detail: { outcome: 'escalated', ticket: ref, reply } }
  }

  await deliver(deps, fresh, out, { runId: parked ? result.runId : null, whatsapp, messageId: job.messageId ?? job.turnId ?? null })
  deps.capture?.(row.user_id, 'procurement_turn', { surface: row.surface, outcome: parked ? 'proposed' : 'replied', tool: out.proposal?.tool ?? null, reply_keys: out.replies.map((r) => r.reply.key) })
  if (parked) deps.capture?.(row.user_id, 'procurement_proposed', { tool: out.proposal!.tool, surface: row.surface })
  return { status: 'ok', detail: { outcome: parked ? 'proposed' : 'replied', run_id: result.runId, session_id: row.id, tool: out.proposal?.tool ?? null, replies: out.replies.map((r) => renderReply(r.reply, view.locale)) } }
}
