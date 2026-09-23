import type { SupabaseClient } from '@supabase/supabase-js'
import { templateFor, type ProcurementAgentOutput, type ProcurementButtons, type ProcurementReply, type WaLocale } from '@amclub/agent-core'
import {
  PROCUREMENT_BUTTON_TITLES,
  procurementButtonId,
  renderProcurementCopy,
  renderSupportReply,
  toProcurementLocale,
  toSupportLocale,
  type ProcurementLocale,
} from '@amclub/shared'
import { nowOf, recordTurn, type ProcurementRuntimeDeps, type SessionRow } from './store'

/**
 * S3.1 — delivery. Every reply is a template rendered by code (the model never writes a sentence the buyer reads).
 * It is recorded as an agent turn (the web mirror shows it, with the proposal's buttons) and, when the buyer holds a
 * WhatsApp grant carrying the procurement scopes, sent there: text / reply buttons inside the 24 h window, the
 * `procurement_update` template (one line + the assistant link) outside it — decisions then happen in the app.
 */

interface ConversationRow { id: string; phone_e164: string; window_open_until: string | null }

async function conversationFor(admin: SupabaseClient, row: SessionRow): Promise<ConversationRow | null> {
  if (row.conversation_id) {
    const { data } = await admin.from('wa_conversations').select('id, phone_e164, window_open_until').eq('id', row.conversation_id).maybeSingle()
    if (data) return data as ConversationRow
  }
  const { data } = await admin.from('wa_conversations').select('id, phone_e164, window_open_until, last_inbound_at').eq('user_id', row.user_id).order('last_inbound_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
  return (data as ConversationRow | null) ?? null
}

export function renderReply(r: ProcurementReply, locale: ProcurementLocale): string {
  return r.source === 'procurement' ? renderProcurementCopy(r.key, r.slots, locale) : renderSupportReply(r.key, r.slots, toSupportLocale(locale))
}

function waLocale(l: ProcurementLocale): WaLocale {
  return l === 'ta' ? 'en' : l
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

async function recordOutbound(deps: ProcurementRuntimeDeps, conv: ConversationRow, kind: 'text' | 'button' | 'template', body: string | null, r: { ok: boolean; vendorMessageId: string | null; detail: string }, extra: Record<string, unknown>): Promise<string | null> {
  const { data } = await deps.admin
    .from('wa_messages')
    .insert({ conversation_id: conv.id, direction: 'out', vendor_message_id: r.vendorMessageId, kind, body, status: r.ok ? (r.detail === 'stub' ? 'stub' : 'sent') : 'failed', payload: { detail: r.detail, procurement: true, ...extra }, ...(kind === 'template' && typeof extra['template_name'] === 'string' ? { template_name: extra['template_name'] } : {}) })
    .select('id')
    .single()
  if (r.ok) await deps.admin.from('wa_conversations').update({ last_outbound_at: nowOf(deps).toISOString() }).eq('id', conv.id)
  return (data as { id: string } | null)?.id ?? null
}

/** Send one reply on WhatsApp (window-aware). Returns the wa_messages id, or null when nothing was sent. */
async function sendWhatsApp(deps: ProcurementRuntimeDeps, row: SessionRow, text: string, buttons: { id: string; title: string }[], extra: Record<string, unknown>): Promise<string | null> {
  if (!deps.agentEnabled) return null
  const conv = await conversationFor(deps.admin, row)
  if (!conv) return null
  const locale = toProcurementLocale(row.locale)
  const inWindow = !!conv.window_open_until && new Date(conv.window_open_until).getTime() > nowOf(deps).getTime()
  if (inWindow) {
    if (buttons.length) {
      const r = await deps.whatsapp.sendButtons(conv.phone_e164, text.slice(0, 1024), buttons)
      return recordOutbound(deps, conv, 'button', text, r, { ...extra, buttons: buttons.map((b) => b.id) })
    }
    const r = await deps.whatsapp.sendText(conv.phone_e164, text)
    return recordOutbound(deps, conv, 'text', text, r, extra)
  }
  const tpl = templateFor('procurement_update', waLocale(locale))
  if (!tpl) return null
  const line = text.split('\n')[0]!.replace(/\s+/g, ' ').slice(0, 300)
  const params = [line, `${deps.apiUrl}/app/assistant`]
  const r = await deps.whatsapp.sendTemplate(conv.phone_e164, tpl.name, waLocale(locale), params)
  return recordOutbound(deps, conv, 'template', null, r, { ...extra, template_name: tpl.name, params })
}

/**
 * Deliver an agent output: each reply → an agent turn (+ WhatsApp when `whatsapp`). A proposal's card carries the
 * run id so the web mirror and the buttons resolve the same parked run.
 */
export async function deliver(deps: ProcurementRuntimeDeps, row: SessionRow, out: Pick<ProcurementAgentOutput, 'replies' | 'proposal'>, ctx: { runId: string | null; whatsapp: boolean; messageId: string | null }): Promise<{ sent: number; whatsapp: number }> {
  const locale = toProcurementLocale(row.locale)
  let sent = 0
  let whatsapp = 0
  for (const [i, x] of out.replies.entries()) {
    const text = renderReply(x.reply, locale)
    const isCard = !!out.proposal && i === out.replies.length - 1 && x.buttons?.kind === 'decision'
    const buttons = buttonsFor(x.buttons, locale, { runId: isCard ? ctx.runId : null, sessionId: row.id, messageId: ctx.messageId })
    const proposal = isCard && out.proposal ? { run_id: ctx.runId, tool: out.proposal.tool, status: 'open', edit: x.buttons?.kind === 'decision' && x.buttons.edit } : x.buttons?.kind === 'labels' ? { labels: x.buttons.labels, status: 'open' } : x.buttons?.kind === 'session' ? { session_choice: true, message_id: ctx.messageId, status: 'open' } : null
    await recordTurn(deps, { sessionId: row.id, userId: row.user_id, role: 'agent', surface: row.surface, body: text, runId: isCard ? ctx.runId : null, proposal: proposal ? { ...proposal, key: x.reply.key } : { key: x.reply.key } })
    sent++
    if (ctx.whatsapp) {
      const id = await sendWhatsApp(deps, row, text, buttons, { procurement_session_id: row.id, reply_key: x.reply.key, ...(isCard ? { run_id: ctx.runId } : {}) })
      if (id) whatsapp++
    }
  }
  return { sent, whatsapp }
}
