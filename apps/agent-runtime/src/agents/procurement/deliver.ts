import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProcurementAgentOutput, ProcurementButtons, ProcurementReply, WaLocale } from '@amclub/agent-core'
import {
  PROCUREMENT_BUTTON_TITLES,
  procurementButtonId,
  renderProcurementCopy,
  renderSupportReply,
  toProcurementLocale,
  toSupportLocale,
  waLocaleFor,
  type ProcurementLocale,
} from '@amclub/shared'
import { nowOf, recordTurn, type ProcurementRuntimeDeps, type SessionRow } from './store'
import { boundConversationFor, conversationServesUser } from '../../whatsapp/binding'
import { runtimeSend, sentMessageId } from '../../whatsapp/outbound'

/**
 * S3.1 — delivery. Every reply is a template rendered by code (the model never writes a sentence the buyer reads).
 * It is recorded as an agent turn (the web mirror shows it, with the proposal's buttons) and, when the buyer holds a
 * WhatsApp grant carrying the procurement scopes, sent there through the one send path (ADR-030): text / reply buttons
 * inside the 24 h window, the `procurement_update` template (one line + the assistant link) outside it — decisions
 * then happen in the app.
 */

interface ConversationRow { id: string; phone_e164: string; window_open_until: string | null }

/**
 * Audit M41: the session's conversation only while it is still bound to the buyer AND is their current phone; else the
 * conversation of the buyer's current phone. Never "the most recent inbound" (an old number is never a target).
 */
async function conversationFor(admin: SupabaseClient, row: SessionRow): Promise<ConversationRow | null> {
  if (row.conversation_id) {
    const { data } = await admin.from('wa_conversations').select('id, phone_e164, window_open_until, user_id').eq('id', row.conversation_id).maybeSingle()
    const conv = data as (ConversationRow & { user_id: string | null }) | null
    if (conv && (await conversationServesUser(admin, conv, row.user_id))) return { id: conv.id, phone_e164: conv.phone_e164, window_open_until: conv.window_open_until }
  }
  return boundConversationFor(admin, row.user_id)
}

export function renderReply(r: ProcurementReply, locale: ProcurementLocale): string {
  return r.source === 'procurement' ? renderProcurementCopy(r.key, r.slots, locale) : renderSupportReply(r.key, r.slots, toSupportLocale(locale))
}

function waLocale(l: ProcurementLocale): WaLocale {
  return waLocaleFor(l)
}

function buttonsFor(b: ProcurementButtons, locale: ProcurementLocale, ctx: { runId: string | null; sessionId: string; messageId: string | null }): { id: string; title: string }[] {
  const t = PROCUREMENT_BUTTON_TITLES[locale]
  if (!b) return []
  if (b.kind === 'decision') {
    if (!ctx.runId) return []
    return [
      { id: procurementButtonId({ kind: 'decision', action: 'ok', runId: ctx.runId }), title: t.yes },
      ...(b.edit ? [{ id: procurementButtonId({ kind: 'decision', action: 'edit', runId: ctx.runId }), title: t.edit }] : []),
      { id: procurementButtonId({ kind: 'decision', action: 'no', runId: ctx.runId }), title: t.no },
    ]
  }
  if (b.kind === 'labels') return b.labels.slice(0, 3).map((l) => ({ id: procurementButtonId({ kind: 'label', sessionId: ctx.sessionId, label: l }), title: t.label(l) }))
  if (b.kind === 'session') {
    if (!ctx.messageId) return []
    return [
      { id: procurementButtonId({ kind: 'session', choice: 'new', messageId: ctx.messageId }), title: t.newReq },
      { id: procurementButtonId({ kind: 'session', choice: 'current', messageId: ctx.messageId }), title: t.thisOne },
    ]
  }
  return []
}

/**
 * Send one reply on WhatsApp through the one send path (ADR-030): text / reply buttons inside the 24 h window, the
 * `procurement_update` template (one line + the assistant link) outside it. `key` is the agent turn it mirrors, so a
 * retried job never sends it twice. Returns the wa_messages id, or null when nothing was sent.
 */
async function sendOnWhatsApp(deps: ProcurementRuntimeDeps, row: SessionRow, text: string, buttons: { id: string; title: string }[], extra: Record<string, unknown>, send: { key: string; initiation: 'business' | 'reply' }): Promise<string | null> {
  if (!deps.agentEnabled) return null
  const conv = await conversationFor(deps.admin, row)
  if (!conv) return null
  const locale = toProcurementLocale(row.locale)
  const line = text.split('\n')[0]!.replace(/\s+/g, ' ').slice(0, 300)
  const r = await runtimeSend(
    { admin: deps.admin, whatsapp: deps.whatsapp, now: () => nowOf(deps) },
    {
      conv,
      userId: row.user_id,
      kind: 'procurement_update',
      purpose: 'assistant',
      initiation: send.initiation,
      idempotencyKey: send.key,
      text: buttons.length ? text.slice(0, 1024) : text,
      ...(buttons.length ? { buttons } : {}),
      template: { kind: 'procurement_update', locale: waLocale(locale), values: { line, link: `${deps.apiUrl}/app/assistant` } },
      runId: typeof extra['run_id'] === 'string' ? extra['run_id'] : null,
      meta: { procurement: true, ...extra },
    },
  )
  return sentMessageId(r)
}

/**
 * Deliver an agent output: each reply → an agent turn (+ WhatsApp when `whatsapp`). A proposal's card carries the
 * run id so the web mirror and the buttons resolve the same parked run.
 */
export async function deliver(deps: ProcurementRuntimeDeps, row: SessionRow, out: Pick<ProcurementAgentOutput, 'replies' | 'proposal'>, ctx: { runId: string | null; whatsapp: boolean; messageId: string | null; initiation?: 'business' | 'reply' }): Promise<{ sent: number; whatsapp: number }> {
  const locale = toProcurementLocale(row.locale)
  let sent = 0
  let whatsapp = 0
  for (const [i, x] of out.replies.entries()) {
    const text = renderReply(x.reply, locale)
    const isCard = !!out.proposal && i === out.replies.length - 1 && x.buttons?.kind === 'decision'
    const buttons = buttonsFor(x.buttons, locale, { runId: isCard ? ctx.runId : null, sessionId: row.id, messageId: ctx.messageId })
    const proposal = isCard && out.proposal ? { run_id: ctx.runId, tool: out.proposal.tool, status: 'open', edit: x.buttons?.kind === 'decision' && x.buttons.edit } : x.buttons?.kind === 'labels' ? { labels: x.buttons.labels, status: 'open' } : x.buttons?.kind === 'session' ? { session_choice: true, message_id: ctx.messageId, status: 'open' } : null
    const turnId = await recordTurn(deps, { sessionId: row.id, userId: row.user_id, role: 'agent', surface: row.surface, body: text, runId: isCard ? ctx.runId : null, proposal: proposal ? { ...proposal, key: x.reply.key } : { key: x.reply.key } })
    sent++
    if (ctx.whatsapp) {
      // one WhatsApp message per recorded agent turn; a reply to the buyer's message, else the agent writes first (the chase)
      const key = turnId ? `pt:${turnId}` : `ps:${row.id}:${ctx.runId ?? ctx.messageId ?? 'x'}:${x.reply.key}:${i}:${nowOf(deps).getTime()}`
      const id = await sendOnWhatsApp(deps, row, text, buttons, { procurement_session_id: row.id, reply_key: x.reply.key, ...(isCard ? { run_id: ctx.runId } : {}) }, { key, initiation: ctx.initiation ?? (ctx.messageId ? 'reply' : 'business') })
      if (id) whatsapp++
    }
  }
  return { sent, whatsapp }
}
