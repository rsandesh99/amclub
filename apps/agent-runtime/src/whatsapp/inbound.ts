import {
  classifyKeyword,
  createWhatsAppProvider,
  metaVerifyChallenge,
  templateFor,
  whatsappConfigFromEnv,
  whatsappIsLive,
  type InboundMessage,
  type WaLocale,
} from '@amclub/agent-core'
import type { AgentPersona } from '@amclub/shared'
import { admin } from '../deps'
import { RUNTIME_ENV } from '../env'
import { isAgentEnabledForUser, onboardingSessionTtlHours } from '../settings'
import { routeMunshiInbound } from '../agents/munshi/index'
import { routeSupportInbound } from '../agents/support/index'
import { routeProcurementInbound } from '../agents/procurement/index'
import type { ProcurementDecideJob, ProcurementTurnJob } from '../agents/procurement/index'
import { buttonPayloadOf } from '../agents/onboarding/index'

/**
 * WhatsApp inbound (S0.5). Two halves:
 *  - ingestWaWebhook: verify → parse → upsert conversation → insert message
 *    idempotently on vendor_message_id → download media → enqueue wa.inbound.
 *    Status callbacks update wa_messages.status. Never replies.
 *  - handleWaInbound (the job): opt-in keyword → agent_grants row for the user
 *    matched by phone (channel=whatsapp) + confirmation template; STOP →
 *    revoke + confirmation; anything else while no agent is enabled → a polite
 *    holding reply at most once per 24h. ALL replies are gated on the
 *    runtime's AGENT_ENABLED (dark ⇒ store only, reply nothing) and on a live
 *    driver (stub ⇒ logs). Service role touches only wa_* + agent_grants (the
 *    user's own consent row, created from their own phone).
 */

const HOLDING_REPLY_GAP_MS = 24 * 3600 * 1000
const WINDOW_MS = 24 * 3600 * 1000

export function waVerifyChallenge(query: Record<string, string | undefined>): string | null {
  const cfg = whatsappConfigFromEnv()
  return metaVerifyChallenge(query, cfg.verifyToken)
}

export interface IngestResult {
  ok: boolean
  status: 200 | 401 | 400
  error?: string
  stored: number
  statuses: number
}

/** Enqueue hook (injected by the server) so this module never imports the worker — no import cycle. */
export type EnqueueFn = (messageId: string) => Promise<string | null>

/** S1.6 — hooks the worker injects into the inbound job (no import cycle). */
export interface InboundHooks {
  enqueueOnboarding?: (turn: { kind: 'start' | 'message'; sessionId: string; messageId?: string }) => Promise<string | null>
  /** S2.2 — a Munshi button (approve | edit | skip:<runId>) or an utterance while a draft is open. */
  enqueueMunshiDecide?: (job: { runId: string; messageId: string; action: 'approve' | 'edit' | 'skip' | 'utterance' }) => Promise<string | null>
  /** S2.3 — a support turn, or the Yes / No on a nudge offer. */
  enqueueSupportReply?: (job: { conversationId: string; messageId: string }) => Promise<string | null>
  enqueueSupportDecide?: (job: { runId: string; messageId: string; action: 'yes' | 'no' }) => Promise<string | null>
  /** S3.1 — a procurement turn (a message in an active session, a label / session button) or a decision (pr:ok|edit|no). */
  enqueueProcurementTurn?: (job: Omit<ProcurementTurnJob, 'kind'>) => Promise<string | null>
  enqueueProcurementDecide?: (job: Omit<ProcurementDecideJob, 'kind'>) => Promise<string | null>
}

export async function ingestWaWebhook(rawBody: string, headers: Record<string, string | undefined>, enqueue: EnqueueFn): Promise<IngestResult> {
  const cfg = whatsappConfigFromEnv()
  const provider = createWhatsAppProvider(cfg)
  // A live driver must prove the vendor signature; the stub accepts (dev only).
  if (whatsappIsLive(cfg) && !provider.verifySignature(rawBody, headers)) {
    return { ok: false, status: 401, error: 'bad_signature', stored: 0, statuses: 0 }
  }
  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return { ok: false, status: 400, error: 'bad_json', stored: 0, statuses: 0 }
  }
  const parsed = provider.parseInbound(body)
  const db = admin()
  let stored = 0
  for (const m of parsed.messages) {
    const conv = await upsertConversation(m.fromE164, m.timestamp)
    const mediaRef = await storeMedia(provider, conv.id, m).catch((e) => {
      console.error('[wa] media download failed', (e as Error).message)
      return null
    })
    const { data: inserted, error } = await db
      .from('wa_messages')
      .insert({
        conversation_id: conv.id,
        direction: 'in',
        vendor_message_id: m.vendorMessageId,
        kind: m.kind,
        body: m.body,
        media_ref: mediaRef,
        mime: m.mime,
        status: 'received',
        payload: m.raw as Record<string, unknown>,
      })
      .select('id')
      .maybeSingle()
    if (error) {
      // 23505 = replayed webhook (vendor_message_id unique) → idempotent no-op.
      if ((error as { code?: string }).code !== '23505') console.error('[wa] message insert failed', error.message)
      continue
    }
    if (inserted?.id) {
      stored++
      await enqueue(inserted.id as string)
    }
  }
  let statuses = 0
  for (const s of parsed.statuses) {
    const { error } = await db.from('wa_messages').update({ status: s.status }).eq('vendor_message_id', s.vendorMessageId)
    if (!error) statuses++
  }
  return { ok: true, status: 200, stored, statuses }
}

async function upsertConversation(phoneE164: string, inboundAtIso: string): Promise<{ id: string; user_id: string | null; locale: string }> {
  const db = admin()
  const windowUntil = new Date(new Date(inboundAtIso).getTime() + WINDOW_MS).toISOString()
  const { data: existing } = await db.from('wa_conversations').select('id, user_id, locale').eq('phone_e164', phoneE164).maybeSingle()
  if (existing) {
    await db.from('wa_conversations').update({ last_inbound_at: inboundAtIso, window_open_until: windowUntil }).eq('id', existing.id)
    if (!existing.user_id) {
      const user = await userByPhone(phoneE164)
      if (user) await db.from('wa_conversations').update({ user_id: user.id, locale: user.locale }).eq('id', existing.id)
      return { id: existing.id as string, user_id: user?.id ?? null, locale: user?.locale ?? (existing.locale as string) }
    }
    return existing as { id: string; user_id: string | null; locale: string }
  }
  const user = await userByPhone(phoneE164)
  const { data: created, error } = await db
    .from('wa_conversations')
    .insert({ phone_e164: phoneE164, user_id: user?.id ?? null, locale: user?.locale ?? 'en', last_inbound_at: inboundAtIso, window_open_until: windowUntil })
    .select('id, user_id, locale')
    .single()
  if (error || !created) throw new Error(`wa_conversations insert: ${error?.message}`)
  return created as { id: string; user_id: string | null; locale: string }
}

/** users.phone is stored WITH the leading '+' (Supabase auth format); vendors send bare digits. */
async function userByPhone(digits: string): Promise<{ id: string; locale: WaLocale; roles: string[] } | null> {
  const { data } = await admin().from('users').select('id, preferred_locale, roles').eq('phone', `+${digits}`).maybeSingle()
  if (!data) return null
  const pl = (data as { preferred_locale?: string }).preferred_locale
  return { id: (data as { id: string }).id, locale: pl === 'hi' || pl === 'te' ? pl : 'en', roles: ((data as { roles?: string[] }).roles ?? []) }
}

async function storeMedia(provider: ReturnType<typeof createWhatsAppProvider>, conversationId: string, m: InboundMessage): Promise<string | null> {
  if (!m.mediaRef || provider.name === 'stub') return null
  const { bytes, mime } = await provider.downloadMedia(m.mediaRef)
  const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('png') ? 'png' : mime.includes('ogg') ? 'ogg' : mime.includes('pdf') ? 'pdf' : 'bin'
  const path = `${conversationId}/${m.vendorMessageId.replace(/[^A-Za-z0-9._-]/g, '_')}.${ext}`
  const { error } = await admin().storage.from(RUNTIME_ENV.WA_MEDIA_BUCKET).upload(path, bytes, { contentType: mime, upsert: true })
  if (error) throw new Error(error.message)
  return path
}

// ── the wa.inbound job ───────────────────────────────────────────────────────

export async function handleWaInbound(messageId: string, hooks: InboundHooks = {}): Promise<void> {
  const db = admin()
  const { data: msg } = await db.from('wa_messages').select('id, conversation_id, kind, body, payload').eq('id', messageId).maybeSingle()
  if (!msg) return
  const { data: conv } = await db.from('wa_conversations').select('id, phone_e164, user_id, locale, last_holding_reply_at, active_session_id, support_ticket_id').eq('id', msg.conversation_id).maybeSingle()
  if (!conv) return
  const locale = (conv.locale === 'hi' || conv.locale === 'te' ? conv.locale : 'en') as WaLocale
  // S2.3 — a button tap is classified by its PAYLOAD id, never its visible title: the nudge offer's "No" / "नहीं"
  // (payload nudge:no:<runId>) is not the S0.5 opt-out keyword "no", while a template quick-reply whose payload IS a
  // keyword (STOP) still opts out. Typed text is classified exactly as before.
  const intent = classifyKeyword(msg.kind === 'button' ? buttonPayloadOf({ kind: 'button', body: (msg.body as string | null) ?? null, payload: (msg.payload as Record<string, unknown> | null) ?? null }) : (msg.body as string | null))

  if (intent === 'opt_out') {
    if (conv.user_id) {
      await db.from('agent_grants').update({ revoked_at: new Date().toISOString() }).eq('user_id', conv.user_id).eq('channel', 'whatsapp').is('revoked_at', null)
    }
    await reply(conv, 'wa_opt_out_confirmed', locale)
    return
  }
  // S1.6 — dispatcher order: STOP (above; opt-out always wins) → active onboarding session → opt-in keywords →
  // JOIN → holding reply. An active session routes EVERY other message into the interview (one turn per message):
  // a typed "yes" / "ok" / "hi" is an answer there, not an opt-in (the user already holds a grant). Without an
  // active session the S0.5 order is unchanged.
  if (RUNTIME_ENV.AGENT_ENABLED && conv.user_id && conv.active_session_id && hooks.enqueueOnboarding) {
    await hooks.enqueueOnboarding({ kind: 'message', sessionId: String(conv.active_session_id), messageId })
    return
  }
  // S2.2 — after the active-session branch, before the opt-in keywords: a Munshi button whose run belongs to this
  // user, or any text / audio while the user has a proposed draft delivered on WhatsApp in the last 24 h.
  if (RUNTIME_ENV.AGENT_ENABLED && conv.user_id && hooks.enqueueMunshiDecide) {
    const routed = await routeMunshiInbound(db, { messageId, userId: conv.user_id as string, row: { kind: msg.kind as string, body: msg.body as string | null, payload: (msg.payload as Record<string, unknown> | null) ?? null } }, hooks)
    if (routed) return
  }
  // S3.1 — the procurement agent, beside Munshi and BEFORE the opt-in keywords: "yes" / "ok" / "hi" are S0.5 opt-in
  // words, so a buyer's typed yes to a draft must reach the session first. A pr: button of this user, or any message
  // while the conversation's procurement session is active (the S2.3 ticket halt applies inside the turn).
  if (RUNTIME_ENV.AGENT_ENABLED && conv.user_id && hooks.enqueueProcurementTurn) {
    // the session pointer is read HERE, not in the conversation select above: a missing column (0045 not applied yet)
    // then costs this branch only, never the rest of the dispatcher (the S2.4 staged-column lesson)
    const { data: ps } = await db.from('wa_conversations').select('procurement_session_id').eq('id', conv.id as string).maybeSingle()
    const routed = await routeProcurementInbound(db, { messageId, conversationId: conv.id as string, userId: conv.user_id as string, row: { kind: msg.kind as string, body: msg.body as string | null, payload: (msg.payload as Record<string, unknown> | null) ?? null }, procurementSessionId: ((ps as { procurement_session_id?: string | null } | null)?.procurement_session_id as string | null) ?? null }, hooks)
    if (routed) return
  }
  if (intent === 'opt_in') {
    if (conv.user_id) {
      await grantWhatsApp(conv.user_id as string, conv.phone_e164 as string, locale)
      await reply(conv, 'wa_opt_in_confirmed', locale)
    } else {
      // Unknown number: nothing to grant; a holding reply explains how to link.
      await holdingReply(conv, locale)
    }
    return
  }
  if (intent === 'onboard') {
    if (!conv.user_id) {
      await holdingReply(conv, locale)
      return
    }
    if (!(await activeWhatsAppGrant(conv.user_id as string))) {
      // No grant yet: JOIN keeps its S0.5 meaning (opt-in + confirmation), flag-independent, so the
      // dark behaviour of JOIN is byte-identical. The provider sends JOIN again to start the interview.
      await grantWhatsApp(conv.user_id as string, conv.phone_e164 as string, locale)
      await reply(conv, 'wa_opt_in_confirmed', locale)
      return
    }
    if (RUNTIME_ENV.AGENT_ENABLED && hooks.enqueueOnboarding && (await isAgentEnabledForUser(db, 'onboarding', conv.user_id as string))) {
      const sessionId = await attachOrCreateOnboardingSession(conv.id as string, conv.user_id as string, locale)
      if (sessionId) {
        await hooks.enqueueOnboarding({ kind: 'start', sessionId })
        return
      }
    }
    await holdingReply(conv, locale)
    return
  }
  // S2.3 — the Support agent: after the Munshi branch, before the holding reply. A nudge button, or any text /
  // audio from a granted, enabled user. An open ticket stores the message and replies nothing (the agent is quiet
  // until a human resolves it). Everything else still falls through to the S0.5 holding reply.
  if (RUNTIME_ENV.AGENT_ENABLED && conv.user_id && (await activeWhatsAppGrant(conv.user_id as string))) {
    const routed = await routeSupportInbound(
      db,
      { messageId, conversationId: conv.id as string, userId: conv.user_id as string, row: { kind: msg.kind as string, body: msg.body as string | null, payload: (msg.payload as Record<string, unknown> | null) ?? null }, supportTicketId: (conv.support_ticket_id as string | null) ?? null },
      hooks,
    )
    if (routed) return
  }
  // Anything else → polite holding reply, ≤ 1 per 24h.
  await holdingReply(conv, locale)
}

async function activeWhatsAppGrant(userId: string): Promise<boolean> {
  const { data } = await admin().from('agent_grants').select('id').eq('user_id', userId).eq('channel', 'whatsapp').is('revoked_at', null).limit(1)
  return Array.isArray(data) && data.length > 0
}

/**
 * S1.6 — the user's active session (a web-started one has no conversation yet:
 * JOIN attaches it) or a fresh one; wa_conversations.active_session_id is the
 * dispatcher's O(1) route for every later message.
 */
async function attachOrCreateOnboardingSession(conversationId: string, userId: string, locale: WaLocale): Promise<string | null> {
  const db = admin()
  const { data: existing } = await db
    .from('onboarding_sessions')
    .select('id')
    .eq('user_id', userId)
    .not('state', 'in', '("handed_off","abandoned","failed")')
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle()
  let sessionId = (existing as { id: string } | null)?.id ?? null
  if (sessionId) {
    await db.from('onboarding_sessions').update({ conversation_id: conversationId }).eq('id', sessionId)
  } else {
    const ttl = await onboardingSessionTtlHours(db)
    const { data: created, error } = await db
      .from('onboarding_sessions')
      .insert({ user_id: userId, conversation_id: conversationId, surface: 'whatsapp', locale, state: 'language', expires_at: new Date(Date.now() + ttl * 3600 * 1000).toISOString() })
      .select('id')
      .single()
    if (error || !created) {
      console.error('[wa] onboarding session insert failed', error?.message)
      return null
    }
    sessionId = (created as { id: string }).id
  }
  await db.from('wa_conversations').update({ active_session_id: sessionId }).eq('id', conversationId)
  return sessionId
}

async function grantWhatsApp(userId: string, phoneE164: string, locale: WaLocale): Promise<void> {
  const db = admin()
  const { data: user } = await db.from('users').select('roles').eq('id', userId).maybeSingle()
  const roles = ((user as { roles?: string[] } | null)?.roles ?? []) as string[]
  const persona: AgentPersona = roles.includes('msme') ? 'buyer' : roles.includes('provider') ? 'provider' : 'buyer'
  const { data: setting } = await db.from('agent_settings').select('value').eq('key', 'whatsapp_opt_in_text_version').maybeSingle()
  const textVersion = typeof setting?.value === 'string' ? setting.value : 'v1'
  // Revoke any stale active grant on this channel, then insert the fresh consent. S3.1: a re-sent opt-in keyword ("hi",
  // "ok", "yes" with no session open) refreshes the consent but KEEPS the scopes a Munshi / procurement enable widened it
  // to — it used to re-insert [] and silently drop them. A first opt-in still grants no tools ([]).
  const { data: prior } = await db.from('agent_grants').select('scopes').eq('user_id', userId).eq('persona', persona).eq('channel', 'whatsapp').is('revoked_at', null)
  const keep = [...new Set((((prior as { scopes: string[] | null }[] | null) ?? []).flatMap((g) => g.scopes ?? [])))]
  await db.from('agent_grants').update({ revoked_at: new Date().toISOString() }).eq('user_id', userId).eq('persona', persona).eq('channel', 'whatsapp').is('revoked_at', null)
  await db.from('agent_grants').insert({
    user_id: userId,
    persona,
    scopes: keep,
    channel: 'whatsapp',
    channel_identity: `+${phoneE164}`,
    consent: { locale, surface: 'whatsapp', ip: null, user_agent: 'whatsapp', text_version: textVersion, keyword: 'START', at: new Date().toISOString() },
  })
}

async function holdingReply(conv: { id: unknown; phone_e164: unknown; last_holding_reply_at?: unknown }, locale: WaLocale): Promise<void> {
  const last = conv.last_holding_reply_at ? new Date(String(conv.last_holding_reply_at)).getTime() : 0
  if (Date.now() - last < HOLDING_REPLY_GAP_MS) return
  const sent = await reply(conv, 'wa_holding_reply', locale)
  if (sent) await admin().from('wa_conversations').update({ last_holding_reply_at: new Date().toISOString() }).eq('id', conv.id as string)
}

/** Send a system template. Gated on runtime AGENT_ENABLED; stub logs; records the outbound row. */
async function reply(conv: { id: unknown; phone_e164: unknown }, kind: string, locale: WaLocale): Promise<boolean> {
  if (!RUNTIME_ENV.AGENT_ENABLED) return false // dark: store only, reply nothing
  const tpl = templateFor(kind, locale)
  if (!tpl) return false
  const cfg = whatsappConfigFromEnv()
  const provider = createWhatsAppProvider(cfg)
  const r = await provider.sendTemplate(String(conv.phone_e164), tpl.name, locale, [])
  await admin().from('wa_messages').insert({
    conversation_id: conv.id as string,
    direction: 'out',
    vendor_message_id: r.vendorMessageId,
    kind: 'template',
    template_name: tpl.name,
    status: r.ok ? (r.detail === 'stub' ? 'stub' : 'sent') : 'failed',
    payload: { detail: r.detail },
  })
  if (r.ok) await admin().from('wa_conversations').update({ last_outbound_at: new Date().toISOString() }).eq('id', conv.id as string)
  return r.ok
}
