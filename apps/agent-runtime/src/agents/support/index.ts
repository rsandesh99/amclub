import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  runSupportTurn,
  signRuntimeCredential,
  stubSupportIntent,
  supportIntentSchema,
  templateFor,
  type AgentDefinition,
  type RunAgentDeps,
  type SupportLookups,
  type WaLocale,
  type WhatsAppProvider,
} from '@amclub/agent-core'
import { getPrompt, runAgent } from '@amclub/agent-core'
import {
  formatRupees,
  orderIsActive,
  renderSupportReply,
  rfqIsActive,
  ticketRefFromId,
  toSupportLocale,
  type SupportIntent,
  type SupportIntentOutput,
  type SupportLocale,
  type SupportOrderView,
  type SupportRfqView,
} from '@amclub/shared'
import { isAgentEnabledForUser, readAgentSettings } from '../../settings'
import { transcribeVoiceNote } from '../onboarding/stt'
import { buttonPayloadOf } from '../onboarding/index'

/**
 * The Support agent — the WhatsApp side (BUILD_PROMPTS S2.3).
 *
 *   support.reply (one job per inbound message): ONE run per turn. The model
 *     only classifies (`support_intent@v1`); the reply is a template from
 *     shared copy filled by `runSupportTurn` from reads made **under the
 *     user's delegated token** (`readUnderToken`, a scripted GET logged as a
 *     `tool_called` event — never a model-proposed tool). An offered action
 *     parks the run on `nudge_counterparty` (confirm:true) and sends buttons.
 *     An escalation opens a ticket through the web's runtime-credential route
 *     and the agent goes quiet on that conversation.
 *   support.decide: the Yes / No buttons on a nudge — Yes posts the decision
 *     route under the token (ai_decisions, feature support_nudge) and the
 *     resume runs the ORDINARY nudge route.
 *
 * The service role here touches only support tables, `wa_*` and the ledgers.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SupportRuntimeDeps {
  core: RunAgentDeps
  admin: SupabaseClient
  whatsapp: WhatsAppProvider
  apiUrl: string
  agentEnabled: boolean
  /** Mints the run's delegated token; `persona` = the user's WhatsApp grant persona (the token route requires a grant for it). */
  tokenFor: (args: { runId: string; userId: string; persona?: 'buyer' | 'provider' }) => Promise<string>
  mediaBucket: string
  runtimeSecret: string
  now?: () => Date
  capture?: (userId: string, event: string, props?: Record<string, unknown>) => void
  fetchImpl?: typeof fetch
  /** Keyless classifier (the rig, CI); absent → `stubSupportIntent`. */
  stubIntent?: (text: string, locale: SupportLocale, orderNumbers: readonly string[]) => SupportIntentOutput
}

export interface SupportReplyJob { kind: 'reply'; conversationId: string; messageId: string; jobId?: string | null }
export interface SupportDecideJob { kind: 'decide'; runId: string; messageId: string; action: 'yes' | 'no'; jobId?: string | null }
export type SupportJob = SupportReplyJob | SupportDecideJob
export type SupportJobResult = { status: 'ok'; detail: Record<string, unknown> } | { status: 'failed'; error: string }

export const SUPPORT_BUTTON_RE = /^nudge:(yes|no):([0-9a-f-]{36})$/i

// ── settings + SLA copy (the ONE source is the web's lib/legal/grievance.ts; mirrored here for the runtime) ──

const SLA = { acknowledge_hours: 24, resolve_days: 15 }
const CONTACT = 'support@amclub.in / +91 83411 15455'

async function supportSettings(admin: SupabaseClient) {
  const s = await readAgentSettings(admin, ['support_escalate_after_turns', 'support_nudge_cooldown_hours'])
  const int = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : d)
  return { escalateAfterTurns: int(s.support_escalate_after_turns, 2, 1, 5), nudgeCooldownHours: int(s.support_nudge_cooldown_hours, 24, 1, 168) }
}

// ── reads under the delegated token (scripted GETs; each one logs a tool_called event) ──

const ordersSchema = z.object({ orders: z.array(z.object({ id: z.string(), order_number: z.string(), title: z.string(), status: z.string(), total_paise: z.union([z.number(), z.string()]), provider_earning_paise: z.union([z.number(), z.string()]).nullable().optional(), created_at: z.string() }).passthrough()) })
const orderDetailSchema = z.object({ order: z.object({ id: z.string(), order_number: z.string(), title: z.string(), status: z.string(), total_paise: z.union([z.number(), z.string()]), provider_earning_paise: z.union([z.number(), z.string()]).nullable().optional(), due_at: z.string().nullable().optional(), updated_at: z.string().optional() }).passthrough(), viewerRole: z.string().optional() })
const rfqMineSchema = z.object({ rfqs: z.array(z.object({ id: z.string(), title: z.string(), status: z.string(), quoteCount: z.number(), maxQuotes: z.number(), expiresAt: z.string().nullable().optional() }).passthrough()) })
const myQuotesSchema = z.object({ quotes: z.array(z.object({ rfqId: z.string(), title: z.string(), rfqStatus: z.string(), quoteCount: z.number(), maxQuotes: z.number(), expiresAt: z.string().nullable().optional(), quoteStatus: z.string(), pricePaise: z.number() }).passthrough()) })
const rfqMatchedSchema = z.object({ rfqs: z.array(z.object({ rfqId: z.string(), title: z.string(), status: z.string(), quoteCount: z.number(), maxQuotes: z.number(), expiresAt: z.string().nullable().optional(), quoted: z.boolean(), declined: z.boolean() }).passthrough()) })

function istDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}
const paise = (v: unknown) => Number(v ?? 0)

/** A scripted GET under the run's delegated token, recorded on the run as a tool_called event (S1.6 STT precedent). */
async function readUnderToken(deps: SupportRuntimeDeps, run: { runId: string; userId: string; persona?: 'buyer' | 'provider' }, path: string): Promise<unknown | null> {
  const f = deps.fetchImpl ?? fetch
  try {
    const token = await deps.tokenFor({ runId: run.runId, userId: run.userId, ...(run.persona ? { persona: run.persona } : {}) })
    const res = await f(`${deps.apiUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    await deps.core.ledger.appendEvent({ runId: run.runId, kind: 'tool_called', tool: 'support_lookup', actor: 'agent', payload: { path, status: res.status, ok: res.ok } })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch (e) {
    console.warn('[support] read failed', path, (e as Error).message)
    return null
  }
}

export function runtimeSupportLookups(deps: SupportRuntimeDeps, run: { runId: string; userId: string; persona?: 'buyer' | 'provider' }, nudgeCapped: (kind: 'order' | 'rfq', id: string) => Promise<boolean>): SupportLookups {
  const orderView = (o: any, role: 'buyer' | 'provider'): SupportOrderView => ({
    id: o.id,
    order_number: String(o.order_number),
    title: String(o.title ?? ''),
    status: String(o.status),
    amount: formatRupees(paise(o.total_paise)),
    earning: role === 'provider' ? formatRupees(paise(o.provider_earning_paise)) : null,
    eta_date: istDate(o.due_at),
    updated_at: String(o.updated_at ?? o.created_at ?? ''),
    payout: null,
    refund: null,
  })
  return {
    async listOrders(role) {
      const body = await readUnderToken(deps, run, `/api/v1/orders?role=${role === 'provider' ? 'provider' : 'msme'}`)
      const parsed = ordersSchema.safeParse(body)
      return parsed.success ? parsed.data.orders.slice(0, 10).map((o) => orderView(o, role)) : []
    },
    async getOrder(ref, role) {
      const list = await this.listOrders(role)
      const found = list.find((o) => o.order_number.toLowerCase() === ref.toLowerCase())
      if (!found) return null
      const body = await readUnderToken(deps, run, `/api/v1/orders/${found.id}`)
      const parsed = orderDetailSchema.safeParse(body)
      return parsed.success ? orderView(parsed.data.order, role) : found
    },
    async listRfqs(role) {
      if (role === 'buyer') {
        const body = await readUnderToken(deps, run, '/api/v1/rfq/mine')
        const parsed = rfqMineSchema.safeParse(body)
        return parsed.success ? parsed.data.rfqs.slice(0, 10).map((r) => ({ id: r.id, title: r.title, status: r.status, quote_count: r.quoteCount, max_quotes: r.maxQuotes, expires_at: istDate(r.expiresAt), my_quote: null } as SupportRfqView)) : []
      }
      // my quotes (real status + price, GET /partner/quotes) first, then matched requests I have not quoted — never a
      // status inferred from the matched list's `quoted` flag
      const [mineBody, matchedBody] = await Promise.all([readUnderToken(deps, run, '/api/v1/partner/quotes'), readUnderToken(deps, run, '/api/v1/rfq/matched')])
      const mine = myQuotesSchema.safeParse(mineBody)
      const matched = rfqMatchedSchema.safeParse(matchedBody)
      const out = new Map<string, SupportRfqView>()
      if (mine.success) for (const q of mine.data.quotes) out.set(q.rfqId, { id: q.rfqId, title: q.title, status: q.rfqStatus, quote_count: q.quoteCount, max_quotes: q.maxQuotes, expires_at: istDate(q.expiresAt), my_quote: { status: q.quoteStatus, price: formatRupees(q.pricePaise) } })
      if (matched.success) for (const r of matched.data.rfqs) if (!out.has(r.rfqId) && !r.quoted && !r.declined) out.set(r.rfqId, { id: r.rfqId, title: r.title, status: r.status, quote_count: r.quoteCount, max_quotes: r.maxQuotes, expires_at: istDate(r.expiresAt), my_quote: null })
      return [...out.values()].slice(0, 10)
    },
    async getRfq(ref, role) {
      const all = await this.listRfqs(role)
      return all.find((r) => r.title.toLowerCase() === ref.toLowerCase()) ?? null
    },
    async nudgeState(subject, role) {
      const capped = await nudgeCapped(subject.kind, subject.id)
      if (subject.kind === 'order') {
        const o = (await this.listOrders(role)).find((x) => x.id === subject.id)
        return { active: !!o && orderIsActive(o.status), capped }
      }
      const r = (await this.listRfqs(role)).find((x) => x.id === subject.id)
      return { active: !!r && rfqIsActive(r.status), capped }
    },
  }
}

// ── WhatsApp send helpers ────────────────────────────────────────────────────

interface ConversationRow {
  id: string
  phone_e164: string
  user_id: string | null
  locale: string | null
  window_open_until: string | null
  support_ticket_id: string | null
  support_last_intents: SupportIntent[] | null
  support_unclear_streak: number | null
}

function waLocale(l: SupportLocale): WaLocale {
  return l === 'ta' ? 'en' : l
}
function inWindow(deps: SupportRuntimeDeps, conv: ConversationRow): boolean {
  return !!conv.window_open_until && new Date(conv.window_open_until).getTime() > (deps.now ?? (() => new Date()))().getTime()
}

async function recordOutbound(deps: SupportRuntimeDeps, conv: ConversationRow, kind: 'text' | 'button' | 'template', body: string | null, r: { ok: boolean; vendorMessageId: string | null; detail: string }, extra: Record<string, unknown>): Promise<string | null> {
  const { data } = await deps.admin
    .from('wa_messages')
    .insert({ conversation_id: conv.id, direction: 'out', vendor_message_id: r.vendorMessageId, kind, body, status: r.ok ? (r.detail === 'stub' ? 'stub' : 'sent') : 'failed', payload: { detail: r.detail, support: true, ...extra }, ...(kind === 'template' && typeof extra['template_name'] === 'string' ? { template_name: extra['template_name'] } : {}) })
    .select('id')
    .single()
  if (r.ok) await deps.admin.from('wa_conversations').update({ last_outbound_at: (deps.now ?? (() => new Date()))().toISOString() }).eq('id', conv.id)
  return (data as { id: string } | null)?.id ?? null
}

/** Text inside the 24 h window; the `support_reply` template outside it. */
async function sendReply(deps: SupportRuntimeDeps, conv: ConversationRow, locale: SupportLocale, text: string, extra: Record<string, unknown>): Promise<string | null> {
  if (!deps.agentEnabled) return null
  if (inWindow(deps, conv)) {
    const r = await deps.whatsapp.sendText(conv.phone_e164, text)
    return recordOutbound(deps, conv, 'text', text, r, extra)
  }
  const tpl = templateFor('support_reply', waLocale(locale))
  if (!tpl) return null
  const title = text.split(/[.\n]/)[0]?.slice(0, 60) ?? 'AMClub'
  const r = await deps.whatsapp.sendTemplate(conv.phone_e164, tpl.name, waLocale(locale), [title, text.slice(0, 600)])
  return recordOutbound(deps, conv, 'template', null, r, { ...extra, template_name: tpl.name })
}

const YES_NO: Record<SupportLocale, { yes: string; no: string }> = {
  en: { yes: 'Yes, send it', no: 'No' },
  hi: { yes: 'हाँ, भेजें', no: 'नहीं' },
  te: { yes: 'అవును, పంపండి', no: 'వద్దు' },
  ta: { yes: 'ஆம், அனுப்பு', no: 'வேண்டாம்' },
}

async function sendNudgeButtons(deps: SupportRuntimeDeps, conv: ConversationRow, locale: SupportLocale, runId: string, text: string): Promise<string | null> {
  if (!deps.agentEnabled || !inWindow(deps, conv)) return sendReply(deps, conv, locale, text, { nudge_offer: true })
  const t = YES_NO[locale]
  const buttons = [{ id: `nudge:yes:${runId}`, title: t.yes }, { id: `nudge:no:${runId}`, title: t.no }]
  const r = await deps.whatsapp.sendButtons(conv.phone_e164, text, buttons)
  return recordOutbound(deps, conv, 'button', text, r, { buttons: buttons.map((b) => b.id), run_id: runId })
}

// ── the agent definition: one run per turn ───────────────────────────────────

interface SupportTurnAgentInput {
  conv: ConversationRow
  messageId: string
  text: string
  locale: SupportLocale
  roles: ('buyer' | 'provider')[]
  previousText: string | null
}

interface SupportTurnAgentOutput {
  intent: string | null
  replyKey: string
  escalate: { reason: string; summary: string | null } | null
  action: { kind: 'order' | 'rfq'; id: string } | null
  replyText: string
  unclearStreak: number
  lookupRefs: { order_id?: string; rfq_id?: string }
  role: 'buyer' | 'provider'
}

function supportTurnAgent(deps: SupportRuntimeDeps, settings: { escalateAfterTurns: number; nudgeCooldownHours: number }, persona: 'buyer' | 'provider'): AgentDefinition<SupportTurnAgentInput, SupportTurnAgentOutput> {
  return {
    name: 'support',
    // the token's persona = the user's WhatsApp grant persona (a provider-only user holds a 'provider' grant); the engine
    // still picks the hat per turn (as_role) and every read is the user's own
    persona,
    async run(run, input) {
      const nudgeCapped = async (kind: 'order' | 'rfq', id: string): Promise<boolean> => {
        const since = new Date(Date.now() - settings.nudgeCooldownHours * 3600 * 1000).toISOString()
        const { count } = await deps.admin.from('nudges').select('id', { count: 'exact', head: true }).eq('subject_kind', kind).eq('subject_id', id).eq('from_user_id', input.conv.user_id ?? '').gte('created_at', since)
        return (count ?? 0) > 0
      }
      const lookups = runtimeSupportLookups(deps, { runId: run.runId, userId: input.conv.user_id ?? '', persona }, nudgeCapped)
      const turn = await runSupportTurn(
        {
          classify: async (parts) =>
            run.callModel<SupportIntentOutput>({
              taskClass: 'support_intent',
              prompt: getPrompt('support_intent', 'v1'),
              schema: supportIntentSchema,
              parts,
              temperature: 0,
              feature: 'support',
              stub: () => (deps.stubIntent ?? stubSupportIntent)(input.text, input.locale, (parts.trusted ?? []).flatMap((l) => (l.startsWith('order_numbers: ') ? l.slice(15).split(' | ') : []))),
            }),
          lookups,
          settings,
          sla: SLA,
          supportContact: CONTACT,
        },
        { text: input.text, messageId: input.messageId, channel: 'whatsapp', roles: input.roles, locale: input.locale, history: { intents: input.conv.support_last_intents ?? [], unclearStreak: input.conv.support_unclear_streak ?? 0, previousText: input.previousText }, openTicket: false },
      )
      if (!turn.numbers.ok) console.error('[support] numbers rule violated', turn.reply.key, turn.numbers.missing)
      if (turn.action) await run.proposeTool('nudge_counterparty', { subject_kind: turn.action.subject.kind, subject_id: turn.action.subject.id })
      return {
        intent: turn.intent?.intent ?? null,
        replyKey: turn.reply.key,
        replyText: turn.reply.text,
        escalate: turn.escalate ?? null,
        action: turn.action ? { kind: turn.action.subject.kind, id: turn.action.subject.id } : null,
        unclearStreak: turn.unclearStreak,
        lookupRefs: turn.lookupRefs,
        role: turn.role,
      }
    },
  }
}

// ── support.reply ────────────────────────────────────────────────────────────

async function conversationRow(admin: SupabaseClient, id: string): Promise<ConversationRow | null> {
  const { data } = await admin.from('wa_conversations').select('id, phone_e164, user_id, locale, window_open_until, support_ticket_id, support_last_intents, support_unclear_streak').eq('id', id).maybeSingle()
  return (data as ConversationRow | null) ?? null
}

/** The persona of the user's active WhatsApp grant (START stores 'buyer' for an msme user, else 'provider'). */
async function whatsappPersona(admin: SupabaseClient, userId: string, roles: readonly ('buyer' | 'provider')[]): Promise<'buyer' | 'provider'> {
  const { data } = await admin.from('agent_grants').select('persona').eq('user_id', userId).eq('channel', 'whatsapp').is('revoked_at', null).order('created_at', { ascending: false }).limit(1).maybeSingle()
  const p = (data as { persona?: string } | null)?.persona
  return p === 'provider' || p === 'buyer' ? p : roles.includes('buyer') ? 'buyer' : 'provider'
}

async function userRoles(admin: SupabaseClient, userId: string): Promise<('buyer' | 'provider')[]> {
  const [{ data: m }, { data: p }] = await Promise.all([admin.from('msme_profiles').select('id').eq('user_id', userId).maybeSingle(), admin.from('provider_profiles').select('id').eq('user_id', userId).maybeSingle()])
  return [...(m ? ['buyer' as const] : []), ...(p ? ['provider' as const] : [])]
}

export async function runSupportReply(deps: SupportRuntimeDeps, job: SupportReplyJob): Promise<SupportJobResult> {
  if (!deps.agentEnabled) return { status: 'failed', error: 'agent_disabled' }
  const conv = await conversationRow(deps.admin, job.conversationId)
  if (!conv?.user_id) return { status: 'failed', error: 'conversation_not_found' }
  if (conv.support_ticket_id) return { status: 'failed', error: 'ticket_open' }
  if (!(await isAgentEnabledForUser(deps.admin, 'support', conv.user_id))) return { status: 'failed', error: 'agent_disabled' }
  const { data: msg } = await deps.admin.from('wa_messages').select('id, conversation_id, kind, body, media_ref, mime').eq('id', job.messageId).maybeSingle()
  if (!msg) return { status: 'failed', error: 'message_not_found' }
  if ((msg as any).conversation_id !== conv.id) return { status: 'failed', error: 'message_conversation_mismatch' }
  const locale = toSupportLocale(conv.locale)
  const roles = await userRoles(deps.admin, conv.user_id)
  if (!roles.length) return { status: 'failed', error: 'no_profile' }
  const settings = await supportSettings(deps.admin)
  const persona = await whatsappPersona(deps.admin, conv.user_id, roles)

  // audio → the existing web STT route under the user's token (S1.6 precedent)
  let text = String((msg as any).body ?? '')
  if ((msg as any).kind === 'audio' && (msg as any).media_ref) {
    const tmpRunId = '00000000-0000-0000-0000-000000000000'
    const token = await deps.tokenFor({ runId: tmpRunId, userId: conv.user_id, persona }).catch(() => '')
    if (token) {
      const t = await transcribeVoiceNote({ admin: deps.admin, bucket: deps.mediaBucket, mediaRef: (msg as any).media_ref, mime: (msg as any).mime, apiUrl: deps.apiUrl, token, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) })
      if (t.ok) text = t.text
    }
  }
  if (!text.trim()) return { status: 'failed', error: 'empty_message' }

  const { data: prev } = await deps.admin.from('wa_messages').select('body').eq('conversation_id', conv.id).eq('direction', 'in').neq('id', job.messageId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  const result = await runAgent(
    supportTurnAgent(deps, settings, persona),
    { ...deps.core, scopes: null, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
    { userId: conv.user_id, surface: 'whatsapp', subjectType: 'wa_conversation', subjectId: conv.id, jobId: job.jobId ?? null, meta: { agent: 'support', message_id: job.messageId } },
    { conv, messageId: job.messageId, text, locale, roles, previousText: (prev as { body?: string } | null)?.body ?? null },
  )
  if (result.status === 'failed') return { status: 'failed', error: result.error }
  const out = result.output

  // escalation → a ticket through the web (runtime credential), then quiet
  if (out.escalate) {
    const ticketArgs = { conv, userId: conv.user_id, role: out.role, locale, reason: out.escalate.reason, intent: out.intent, orderId: out.lookupRefs.order_id ?? null, rfqId: out.lookupRefs.rfq_id ?? null, runId: result.runId, text }
    // the halt must hold even when the web is unreachable: a bare ticket row (support table, service role) marks the conversation
    const ticket = (await openTicketViaWeb(deps, { ...ticketArgs, persona })) ?? (await openTicketFallback(deps, ticketArgs))
    const replyText = renderSupportReply('escalated', { sla_hours: SLA.acknowledge_hours, sla_days: SLA.resolve_days, contact: CONTACT, ticket_ref: ticket?.ref ?? '' }, locale)
    await sendReply(deps, conv, locale, replyText, { support: true, escalated: true })
    await deps.admin.from('wa_conversations').update({ support_last_intents: [...(conv.support_last_intents ?? []), (out.intent ?? 'other') as SupportIntent].slice(-5), support_unclear_streak: 0 }).eq('id', conv.id)
    deps.capture?.(conv.user_id, 'support_turn', { channel: 'whatsapp', intent: out.intent, escalated: true, reply_key: 'escalated' })
    return { status: 'ok', detail: { outcome: 'escalated', ticket: ticket?.ref ?? null } }
  }

  if (out.action) await sendNudgeButtons(deps, conv, locale, result.runId, out.replyText)
  else await sendReply(deps, conv, locale, out.replyText, { support: true, reply_key: out.replyKey })
  await deps.admin.from('wa_conversations').update({ support_last_intents: [...(conv.support_last_intents ?? []), (out.intent ?? 'other') as SupportIntent].slice(-5), support_unclear_streak: out.unclearStreak }).eq('id', conv.id)
  deps.capture?.(conv.user_id, 'support_turn', { channel: 'whatsapp', intent: out.intent, escalated: false, reply_key: out.replyKey })
  return { status: 'ok', detail: { outcome: out.action ? 'nudge_offered' : 'answered', reply_key: out.replyKey, run_id: result.runId } }
}

async function openTicketViaWeb(deps: SupportRuntimeDeps, args: { conv: ConversationRow; userId: string; role: 'buyer' | 'provider'; locale: SupportLocale; reason: string; intent: string | null; orderId: string | null; rfqId: string | null; runId: string; text: string; persona: 'buyer' | 'provider' }): Promise<{ id: string; ref: string } | null> {
  if (!deps.runtimeSecret) return null
  const { data: msgs } = await deps.admin.from('wa_messages').select('id, direction, body').eq('conversation_id', args.conv.id).order('created_at', { ascending: false }).limit(6)
  const transcript = (((msgs as any[]) ?? []).reverse()).map((m) => ({ id: String(m.id), role: (m.direction === 'in' ? 'user' : 'assistant') as 'user' | 'assistant', text: String(m.body ?? '').slice(0, 2000) })).filter((t) => t.text)
  try {
    const cred = signRuntimeCredential(deps.runtimeSecret, { userId: args.userId, persona: args.persona, runId: args.runId })
    const f = deps.fetchImpl ?? fetch
    const res = await f(`${deps.apiUrl}/api/v1/agent/admin/support/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `AMC-Runtime ${cred}` },
      body: JSON.stringify({ user_id: args.userId, role: args.role, channel: 'whatsapp', conversation_id: args.conv.id, locale: args.locale, reason: args.reason, intent: args.intent, order_id: args.orderId, rfq_id: args.rfqId, run_id: args.runId, transcript }),
    })
    const body = (await res.json().catch(() => null)) as { ticket_id?: string; ticket_ref?: string } | null
    if (!res.ok || !body?.ticket_id) return null
    return { id: body.ticket_id, ref: body.ticket_ref ?? ticketRefFromId(body.ticket_id) }
  } catch (e) {
    console.warn('[support] ticket route failed', (e as Error).message)
    return null
  }
}

/**
 * The web ticket route failed (runtime secret unset, web down, 5xx): open a bare ticket directly so the escalation
 * still halts the agent on this conversation. No model summary and no notifications here — the admin queue lists it
 * (summary = the fixed fallback) and the transcript is on the conversation. One open ticket per (user, channel).
 */
async function openTicketFallback(deps: SupportRuntimeDeps, args: { conv: ConversationRow; userId: string; role: 'buyer' | 'provider'; reason: string; intent: string | null; orderId: string | null; rfqId: string | null; runId: string }): Promise<{ id: string; ref: string } | null> {
  const cols = 'id'
  const existing = async () => (await deps.admin.from('support_tickets').select(cols).eq('user_id', args.userId).eq('channel', 'whatsapp').neq('status', 'resolved').is('deleted_at', null).maybeSingle()).data as { id: string } | null
  let row = await existing()
  if (!row) {
    const { data, error } = await deps.admin
      .from('support_tickets')
      .insert({ user_id: args.userId, role: args.role, channel: 'whatsapp', conversation_id: args.conv.id, order_id: args.orderId, rfq_id: args.rfqId, intent: args.intent, reason: args.reason, summary: 'See the transcript — the automatic summary was not available.', run_id: args.runId })
      .select(cols)
      .single()
    row = (data as { id: string } | null) ?? (error ? await existing() : null)
  }
  if (!row) return null
  await deps.admin.from('wa_conversations').update({ support_ticket_id: row.id }).eq('id', args.conv.id)
  console.warn('[support] ticket opened by the runtime fallback (web route unavailable)', row.id)
  return { id: row.id, ref: ticketRefFromId(row.id) }
}

// ── support.decide (the nudge buttons) ───────────────────────────────────────

export async function runSupportDecide(deps: SupportRuntimeDeps, job: SupportDecideJob): Promise<SupportJobResult> {
  if (!deps.agentEnabled) return { status: 'failed', error: 'agent_disabled' }
  const run = await deps.core.ledger.getRun(job.runId)
  if (!run) return { status: 'failed', error: 'run_gone' }
  const { data: msg } = await deps.admin.from('wa_messages').select('id, conversation_id').eq('id', job.messageId).maybeSingle()
  if (!msg) return { status: 'failed', error: 'message_not_found' }
  const conv = await conversationRow(deps.admin, String((msg as any).conversation_id))
  if (!conv?.user_id || conv.user_id !== run.userId) return { status: 'failed', error: 'message_conversation_mismatch' }
  const locale = toSupportLocale(conv.locale)
  if (run.status !== 'awaiting_confirmation') {
    await sendReply(deps, conv, locale, renderSupportReply('nudge.out_of_window', { contact: CONTACT, sla_hours: SLA.acknowledge_hours, sla_days: SLA.resolve_days }, locale), { support: true, stale: true })
    return { status: 'ok', detail: { outcome: 'stale' } }
  }
  // the proposal's payload is the subject
  const { data: ev } = await deps.admin.from('agent_events').select('payload').eq('run_id', job.runId).eq('kind', 'confirmation_requested').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const payload = ((ev as { payload?: Record<string, unknown> } | null)?.payload ?? {}) as { subject_kind?: string; subject_id?: string }
  const f = deps.fetchImpl ?? fetch
  const runPersona: 'buyer' | 'provider' = run.persona === 'provider' ? 'provider' : 'buyer'
  const token = await deps.tokenFor({ runId: job.runId, userId: conv.user_id, persona: runPersona })
  const decision = await f(`${deps.apiUrl}/api/v1/agent/runs/${job.runId}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(job.action === 'yes' ? { approve: true, final: { subject_kind: payload.subject_kind, subject_id: payload.subject_id }, input_refs: { wa_message_id: job.messageId } } : { approve: false, reason: 'declined', input_refs: { wa_message_id: job.messageId } }),
  })
  const body = (await decision.json().catch(() => null)) as { decision_id?: string; resumed?: boolean; error?: string } | null
  if (job.action === 'no') {
    deps.capture?.(conv.user_id, 'support_nudge_decided', { outcome: 'declined' })
    return { status: 'ok', detail: { outcome: 'declined' } }
  }
  if (!decision.ok && !body?.decision_id) {
    await sendReply(deps, conv, locale, renderSupportReply('nudge.out_of_window', { contact: CONTACT, sla_hours: SLA.acknowledge_hours, sla_days: SLA.resolve_days }, locale), { support: true })
    return { status: 'failed', error: `decision_failed:${decision.status}` }
  }
  // the resume runs the ORDINARY nudge route (the web ping does it when the runtime URL is set; else in-process)
  let capped = false
  if (!body?.resumed) {
    const { AgentRun } = await import('@amclub/agent-core')
    const agentRun = new AgentRun({ runId: job.runId, userId: conv.user_id, persona: run.persona, ledger: deps.core.ledger, gateway: deps.core.gateway, budget: deps.core.makeBudget({ runId: job.runId, userId: conv.user_id, agentName: 'support' }), apiBaseUrl: deps.apiUrl, getToken: () => deps.tokenFor({ runId: job.runId, userId: conv.user_id!, persona: runPersona }), scopes: null, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) })
    try {
      const outcome = await agentRun.resume('nudge_counterparty', { subject_kind: payload.subject_kind, subject_id: payload.subject_id }, body?.decision_id ? { decisionId: body.decision_id } : undefined)
      await agentRun.complete().catch(() => undefined)
      capped = outcome.status === 'done' && outcome.result.status === 429
    } catch (e) {
      await agentRun.fail((e as Error).message)
      await sendReply(deps, conv, locale, renderSupportReply('nudge.out_of_window', { contact: CONTACT, sla_hours: SLA.acknowledge_hours, sla_days: SLA.resolve_days }, locale), { support: true })
      return { status: 'failed', error: (e as Error).message }
    }
  }
  const key = capped ? 'nudge.capped' : 'nudge.sent'
  const { nudgeCooldownHours } = await supportSettings(deps.admin)
  await sendReply(deps, conv, locale, renderSupportReply(key, { hours: nudgeCooldownHours, contact: CONTACT, sla_hours: SLA.acknowledge_hours, sla_days: SLA.resolve_days }, locale), { support: true, reply_key: key })
  deps.capture?.(conv.user_id, 'support_nudge_decided', { outcome: capped ? 'capped' : 'sent' })
  return { status: 'ok', detail: { outcome: capped ? 'capped' : 'sent' } }
}

// ── the dispatcher branch ────────────────────────────────────────────────────

export interface SupportInboundHooks {
  enqueueSupportReply?: (job: { conversationId: string; messageId: string }) => Promise<string | null>
  enqueueSupportDecide?: (job: { runId: string; messageId: string; action: 'yes' | 'no' }) => Promise<string | null>
}

/**
 * True when the message was routed to Support: a `nudge:yes|no:<runId>` button
 * whose run belongs to this user, or any text / audio from a granted, enabled
 * user (an open ticket stores the message and replies nothing).
 */
export async function routeSupportInbound(admin: SupabaseClient, args: { messageId: string; conversationId: string; userId: string; row: { kind: string; body: string | null; payload: Record<string, unknown> | null }; supportTicketId: string | null }, hooks: SupportInboundHooks): Promise<boolean> {
  const payload = buttonPayloadOf(args.row)
  const m = payload ? SUPPORT_BUTTON_RE.exec(payload.trim()) : null
  if (m && hooks.enqueueSupportDecide) {
    const { data } = await admin.from('agent_runs').select('id, user_id').eq('id', m[2]!.toLowerCase()).maybeSingle()
    if (!data || (data as { user_id: string }).user_id !== args.userId) return false
    await hooks.enqueueSupportDecide({ runId: m[2]!.toLowerCase(), messageId: args.messageId, action: m[1]!.toLowerCase() as 'yes' | 'no' })
    return true
  }
  if (!hooks.enqueueSupportReply) return false
  if (args.row.kind !== 'text' && args.row.kind !== 'audio') return false
  if (!(await isAgentEnabledForUser(admin, 'support', args.userId))) return false
  // an open ticket: the message is already stored; the agent stays quiet
  if (args.supportTicketId) return true
  await hooks.enqueueSupportReply({ conversationId: args.conversationId, messageId: args.messageId })
  return true
}
