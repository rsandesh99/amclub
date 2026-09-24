import type { SupabaseClient } from '@supabase/supabase-js'
import {
  MediaRefusedError,
  PENDING_MEDIA_KEY,
  classifyKeyword,
  createSupabaseLedger,
  createWhatsAppProvider,
  mediaExtension,
  mediaLimitsFromEnv,
  metaVerifyChallenge,
  pendingMediaRef,
  templateFor,
  whatsappConfigFromEnv,
  whatsappIsLive,
  type WaLocale,
  type WhatsAppProvider,
} from '@amclub/agent-core'
import type { AgentPersona } from '@amclub/shared'
import { admin } from '../deps'
import { RUNTIME_ENV } from '../env'
import { isAgentEnabledForUser, onboardingSessionTtlHours } from '../settings'
import { routeMunshiInbound } from '../agents/munshi/index'
import type { MunshiDecideJob } from '../agents/munshi/index'
import { routeSupportInbound } from '../agents/support/index'
import { routeProcurementInbound } from '../agents/procurement/index'
import type { ProcurementDecideJob, ProcurementTurnJob } from '../agents/procurement/index'
import { buttonPayloadOf } from '../agents/onboarding/index'
import { phoneDigits, reconcileConversationOwner, userByPhone, whatsappGrantsFor } from './binding'
import { routeFreeText } from './confirmations'

/**
 * WhatsApp inbound (S0.5). Two halves:
 *  - ingestWaWebhook: verify → parse → upsert conversation → insert message
 *    idempotently on vendor_message_id → enqueue wa.inbound. Status callbacks
 *    update wa_messages.status. Never replies, never downloads media (audit M34:
 *    the vendor media id is stored in the payload and the JOB fetches it). A
 *    store failure answers 5xx so the vendor retries (audit M33).
 *  - handleWaInbound (the job): re-derive the conversation's owner from
 *    users.phone (audit M41) → STOP → media for a bound, opted-in number (capped)
 *    → the dispatcher → mark the row processed (audit M33: `sweepUnprocessedInbound`
 *    re-enqueues rows the job never finished). ALL replies are gated on the
 *    runtime's AGENT_ENABLED (dark ⇒ store only, reply nothing) and on a live
 *    driver (stub ⇒ logs). Service role touches only wa_* + agent_grants (the
 *    user's own consent row, created from their own phone) + the agents' own tables.
 */

const HOLDING_REPLY_GAP_MS = 24 * 3600 * 1000
const WINDOW_MS = 24 * 3600 * 1000

export function waVerifyChallenge(query: Record<string, string | undefined>): string | null {
  const cfg = whatsappConfigFromEnv()
  return metaVerifyChallenge(query, cfg.verifyToken)
}

export interface IngestResult {
  ok: boolean
  status: 200 | 400 | 401 | 500
  error?: string
  stored: number
  statuses: number
}

/** Enqueue hook (injected by the server) so this module never imports the worker — no import cycle. */
export type EnqueueFn = (messageId: string) => Promise<string | null>

/** S1.6 — hooks the worker injects into the inbound job (no import cycle). */
export interface InboundHooks {
  enqueueOnboarding?: (turn: { kind: 'start' | 'message'; sessionId: string; messageId?: string }) => Promise<string | null>
  /** S2.2 — a Munshi button (approve | edit | skip:<runId>); a bound utterance / a buttons re-send (audit M42). */
  enqueueMunshiDecide?: (job: Omit<MunshiDecideJob, 'kind'>) => Promise<string | null>
  /** S2.3 — a support turn, or the Yes / No on a nudge offer. */
  enqueueSupportReply?: (job: { conversationId: string; messageId: string }) => Promise<string | null>
  enqueueSupportDecide?: (job: { runId: string; messageId: string; action: 'yes' | 'no' }) => Promise<string | null>
  /** S3.1 — a procurement turn (a message in an active session, a label / session button) or a decision (pr:ok|edit|no). */
  enqueueProcurementTurn?: (job: Omit<ProcurementTurnJob, 'kind'>) => Promise<string | null>
  enqueueProcurementDecide?: (job: Omit<ProcurementDecideJob, 'kind'>) => Promise<string | null>
}

/** Unsigned (stub-driver) webhooks: only outside production, and only when a developer opts in. */
export function acceptsUnsignedWebhooks(env: Record<string, string | undefined> = process.env): boolean {
  return env['NODE_ENV'] !== 'production' && env['WHATSAPP_WEBHOOK_ALLOW_UNSIGNED'] === 'true'
}

export async function ingestWaWebhook(rawBody: string, headers: Record<string, string | undefined>, enqueue: EnqueueFn): Promise<IngestResult> {
  const cfg = whatsappConfigFromEnv()
  const provider = createWhatsAppProvider(cfg)
  // A live driver must prove the vendor signature. The stub cannot, so it
  // accepts nothing unless a developer opts in outside production (audit H4):
  // otherwise anyone could post a message "from" any registered number.
  if (whatsappIsLive(cfg)) {
    if (!provider.verifySignature(rawBody, headers)) return { ok: false, status: 401, error: 'bad_signature', stored: 0, statuses: 0 }
  } else if (!acceptsUnsignedWebhooks()) {
    return { ok: false, status: 401, error: 'webhook_not_configured', stored: 0, statuses: 0 }
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
  let failed = 0
  for (const m of parsed.messages) {
    try {
      const conv = await upsertConversation(db, m.fromE164, m.timestamp)
      // audit M34: no download here — the vendor media ref rides in the payload; the job fetches it (capped) for a
      // bound, opted-in number only
      const raw = (m.raw && typeof m.raw === 'object' ? m.raw : { raw: m.raw }) as Record<string, unknown>
      const payload = m.mediaRef ? { ...raw, [PENDING_MEDIA_KEY]: m.mediaRef } : raw
      const { data: inserted, error } = await insertInbound(db, { conversation_id: conv.id, direction: 'in', vendor_message_id: m.vendorMessageId, kind: m.kind, body: m.body, media_ref: null, mime: m.mime, status: 'received', payload })
      if (error) {
        // 23505 = replayed webhook (vendor_message_id unique) → idempotent. If the first delivery never got processed
        // (the enqueue failed), re-enqueue: the job id is the message id, so this can never create a second job.
        if ((error as { code?: string }).code === '23505') {
          await reenqueueIfUnprocessed(db, m.vendorMessageId, enqueue)
          continue
        }
        throw new Error(`wa_messages insert: ${error.message}`)
      }
      if (inserted?.id) {
        stored++
        // the message is stored: an enqueue failure is logged and the sweep picks the row up
        await enqueue(inserted.id as string).catch((e: Error) => console.error('[wa] enqueue failed (the sweep will retry)', e.message))
      }
    } catch (e) {
      failed++
      console.error('[wa] inbound store failed — answering 5xx so the vendor retries', (e as Error).message)
    }
  }
  let statuses = 0
  for (const s of parsed.statuses) {
    const { error } = await db.from('wa_messages').update({ status: s.status }).eq('vendor_message_id', s.vendorMessageId)
    if (!error) statuses++
  }
  if (failed > 0) return { ok: false, status: 500, error: 'store_failed', stored, statuses }
  return { ok: true, status: 200, stored, statuses }
}

let processedColumnMissingOnInsert = false

/**
 * Insert an inbound row as UNPROCESSED (processed_at null — 0079's column default
 * is now(), so rows written by anything else never enter the sweep). Before 0079
 * is applied the column is unknown: the row is stored without it (logged once) —
 * a store must never fail on the sweep's bookkeeping.
 */
async function insertInbound(db: SupabaseClient, row: Record<string, unknown>): Promise<{ data: { id: string } | null; error: { message: string; code?: string } | null }> {
  if (!processedColumnMissingOnInsert) {
    const r = await db.from('wa_messages').insert({ ...row, processed_at: null }).select('id').maybeSingle()
    const code = (r.error as { code?: string } | null)?.code
    if (!r.error || code === '23505' || !/processed_at/.test(r.error.message)) return r as { data: { id: string } | null; error: { message: string; code?: string } | null }
    processedColumnMissingOnInsert = true
    console.error('[wa] wa_messages.processed_at missing — storing without it; apply migration 0079 (the inbound sweep is off until then)')
  }
  const r = await db.from('wa_messages').insert(row).select('id').maybeSingle()
  return r as { data: { id: string } | null; error: { message: string; code?: string } | null }
}

async function reenqueueIfUnprocessed(db: SupabaseClient, vendorMessageId: string, enqueue: EnqueueFn): Promise<void> {
  const { data, error } = await db.from('wa_messages').select('id, processed_at').eq('vendor_message_id', vendorMessageId).maybeSingle()
  if (error || !data) return // (a database without 0079's processed_at: the sweep is off too; nothing to decide here)
  if ((data as { processed_at: string | null }).processed_at) return
  await enqueue((data as { id: string }).id).catch((e: Error) => console.error('[wa] re-enqueue failed', e.message))
}

async function upsertConversation(db: SupabaseClient, phoneE164: string, inboundAtIso: string): Promise<{ id: string; user_id: string | null; locale: string }> {
  const windowUntil = new Date(new Date(inboundAtIso).getTime() + WINDOW_MS).toISOString()
  const { data: existing, error: readErr } = await db.from('wa_conversations').select('id, user_id, locale').eq('phone_e164', phoneE164).maybeSingle()
  if (readErr) throw new Error(`wa_conversations read: ${readErr.message}`)
  if (existing) {
    await db.from('wa_conversations').update({ last_inbound_at: inboundAtIso, window_open_until: windowUntil }).eq('id', existing.id)
    // the binding is (re-)derived by the job before anything acts on it (audit M41)
    return existing as { id: string; user_id: string | null; locale: string }
  }
  const user = await userByPhone(db, phoneE164)
  const locale = user?.preferred_locale === 'hi' || user?.preferred_locale === 'te' ? user.preferred_locale : 'en'
  const { data: created, error } = await db
    .from('wa_conversations')
    .insert({ phone_e164: phoneE164, user_id: user?.id ?? null, locale, last_inbound_at: inboundAtIso, window_open_until: windowUntil })
    .select('id, user_id, locale')
    .single()
  if (error || !created) {
    // a concurrent first message from the same phone created it: read it back
    const { data: again } = await db.from('wa_conversations').select('id, user_id, locale').eq('phone_e164', phoneE164).maybeSingle()
    if (again) return again as { id: string; user_id: string | null; locale: string }
    throw new Error(`wa_conversations insert: ${error?.message}`)
  }
  return created as { id: string; user_id: string | null; locale: string }
}

// ── the wa.inbound job ───────────────────────────────────────────────────────

/**
 * One inbound message. Marks the row processed when the dispatcher finished (a
 * throw leaves it unprocessed: pg-boss retries, and the sweep reports it).
 */
export async function handleWaInbound(messageId: string, hooks: InboundHooks = {}): Promise<void> {
  await dispatchWaInbound(messageId, hooks)
  await markProcessed(admin(), messageId)
}

let processedColumnMissingLogged = false
async function markProcessed(db: SupabaseClient, messageId: string): Promise<void> {
  const { error } = await db.from('wa_messages').update({ processed_at: new Date().toISOString() }).eq('id', messageId).is('processed_at', null)
  if (error && !processedColumnMissingLogged) {
    processedColumnMissingLogged = true
    console.error('[wa] could not mark the message processed (apply migration 0079: wa_messages.processed_at)', error.message)
  }
}

async function dispatchWaInbound(messageId: string, hooks: InboundHooks): Promise<void> {
  const db = admin()
  const { data: msg } = await db.from('wa_messages').select('id, conversation_id, kind, body, payload, media_ref, mime').eq('id', messageId).maybeSingle()
  if (!msg) return
  const { data: conv } = await db.from('wa_conversations').select('id, phone_e164, user_id, locale, last_holding_reply_at, active_session_id, support_ticket_id').eq('id', msg.conversation_id).maybeSingle()
  if (!conv) return

  // audit M41 — the owner is re-derived from users.phone on EVERY message, before anything acts on the binding: a
  // conversation whose user no longer holds this phone is unbound (grants from this phone revoked, the drafts and
  // proposals delivered here cancelled) and the phone's current holder is bound.
  const rec = await reconcileConversationOwner(db, { id: conv.id as string, phone_e164: conv.phone_e164 as string, user_id: (conv.user_id as string | null) ?? null }, { ledger: createSupabaseLedger(db) })
  if (rec.userId !== conv.user_id) {
    conv.user_id = rec.userId
    conv.active_session_id = null
    conv.support_ticket_id = null
    if (rec.locale) conv.locale = rec.locale
  }
  const locale = (conv.locale === 'hi' || conv.locale === 'te' ? conv.locale : 'en') as WaLocale
  const phone = conv.phone_e164 as string
  const row = { kind: msg.kind as string, body: (msg.body as string | null) ?? null, payload: (msg.payload as Record<string, unknown> | null) ?? null }
  // S2.3 — a button tap is classified by its PAYLOAD id, never its visible title: the nudge offer's "No" / "नहीं"
  // (payload nudge:no:<runId>) is not the S0.5 opt-out keyword "no", while a template quick-reply whose payload IS a
  // keyword (STOP) still opts out. Typed text is classified exactly as before.
  const intent = classifyKeyword(row.kind === 'button' ? buttonPayloadOf(row) : row.body)

  if (intent === 'opt_out') {
    // STOP revokes every WhatsApp grant of the (re-derived) owner of this phone — consent withdrawal is never narrowed
    if (conv.user_id) {
      await db.from('agent_grants').update({ revoked_at: new Date().toISOString() }).eq('user_id', conv.user_id).eq('channel', 'whatsapp').is('revoked_at', null)
    }
    await reply(conv, 'wa_opt_out_confirmed', locale)
    return
  }

  // audit M34 — media is fetched here, capped, and only for a bound number that opted in from this phone
  if (pendingMediaRef(row.payload) && !msg.media_ref) {
    const grants = conv.user_id ? await whatsappGrantsFor(db, conv.user_id as string, phone) : []
    await resolveInboundMedia(db, { id: msg.id as string, conversation_id: conv.id as string, media_ref: null, mime: (msg.mime as string | null) ?? null, payload: row.payload }, grants)
  }

  // S1.6 — dispatcher order: STOP (above; opt-out always wins) → active onboarding session → opt-in keywords →
  // JOIN → holding reply. An active session routes EVERY other message into the interview (one turn per message):
  // a typed "yes" / "ok" / "hi" is an answer there, not an opt-in (the user already holds a grant). Without an
  // active session the S0.5 order is unchanged.
  if (RUNTIME_ENV.AGENT_ENABLED && conv.user_id && conv.active_session_id && hooks.enqueueOnboarding) {
    await hooks.enqueueOnboarding({ kind: 'message', sessionId: String(conv.active_session_id), messageId })
    return
  }
  if (RUNTIME_ENV.AGENT_ENABLED && conv.user_id) {
    // S2.2 — a Munshi button whose run belongs to this user.
    if (hooks.enqueueMunshiDecide && (await routeMunshiInbound(db, { messageId, userId: conv.user_id as string, row }, hooks))) return
    // S3.1 — the procurement agent's pr: buttons, beside Munshi and BEFORE the opt-in keywords. The session pointer is
    // read HERE, not in the conversation select above: a missing column (0045 not applied yet) then costs this branch
    // only, never the rest of the dispatcher (the S2.4 staged-column lesson).
    const { data: ps } = await db.from('wa_conversations').select('procurement_session_id').eq('id', conv.id as string).maybeSingle()
    const procurementSessionId = ((ps as { procurement_session_id?: string | null } | null)?.procurement_session_id as string | null) ?? null
    if (hooks.enqueueProcurementTurn && (await routeProcurementInbound(db, { messageId, conversationId: conv.id as string, userId: conv.user_id as string, row, procurementSessionId }, hooks))) return
    // audit M42 — free text vs the open proposals: bound to at most ONE across Munshi / procurement / support (a quoted
    // card binds exactly that card); ambiguous → the cards are re-sent and nothing is approved. Still BEFORE the opt-in
    // keywords: "yes" / "ok" / "hi" are S0.5 opt-in words.
    const free = await routeFreeText(db, { messageId, conversationId: conv.id as string, userId: conv.user_id as string, locale, row, procurementSessionId }, hooks)
    if (free.routed) return
  }
  if (intent === 'opt_in') {
    if (conv.user_id) {
      await grantWhatsApp(conv.user_id as string, phone, locale)
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
    if (!(await activeWhatsAppGrant(conv.user_id as string, phone))) {
      // No grant yet: JOIN keeps its S0.5 meaning (opt-in + confirmation), flag-independent, so the
      // dark behaviour of JOIN is byte-identical. The provider sends JOIN again to start the interview.
      await grantWhatsApp(conv.user_id as string, phone, locale)
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
  if (RUNTIME_ENV.AGENT_ENABLED && conv.user_id && (await activeWhatsAppGrant(conv.user_id as string, phone))) {
    const routed = await routeSupportInbound(db, { messageId, conversationId: conv.id as string, userId: conv.user_id as string, row, supportTicketId: (conv.support_ticket_id as string | null) ?? null }, hooks)
    if (routed) return
  }
  // Anything else → polite holding reply, ≤ 1 per 24h.
  await holdingReply(conv, locale)
}

/** Audit M41: a WhatsApp grant counts only when it was given from THIS phone. */
async function activeWhatsAppGrant(userId: string, phoneE164: string): Promise<boolean> {
  return (await whatsappGrantsFor(admin(), userId, phoneE164)).length > 0
}

// ── media (audit M34) ────────────────────────────────────────────────────────

function provider(): WhatsAppProvider {
  return createWhatsAppProvider(whatsappConfigFromEnv())
}

/**
 * Download the message's media into the private bucket — only for a number bound
 * to a user who opted in from it (an unknown or non-opted-in number's media is
 * never fetched: nothing downstream may read it), with the driver's caps
 * (timeout per fetch, MIME allow-list, Content-Length + streamed byte cap). A
 * refusal is logged and recorded on the payload; the message is still handled
 * (without media).
 */
export async function resolveInboundMedia(
  db: SupabaseClient,
  msg: { id: string; conversation_id: string; media_ref: string | null; mime: string | null; payload: Record<string, unknown> | null },
  grants: readonly unknown[],
  deps: { provider?: WhatsAppProvider; bucket?: string } = {},
): Promise<'none' | 'stored' | 'skipped_not_opted_in' | 'refused'> {
  const ref = pendingMediaRef(msg.payload)
  if (!ref || msg.media_ref) return 'none'
  const p = deps.provider ?? provider()
  if (p.name === 'stub') return 'none'
  const mark = async (status: string, detail?: string) => {
    await db.from('wa_messages').update({ payload: { ...(msg.payload ?? {}), amc_media_status: status, ...(detail ? { amc_media_detail: detail.slice(0, 200) } : {}) } }).eq('id', msg.id)
  }
  if (grants.length === 0) {
    await mark('skipped_not_opted_in')
    return 'skipped_not_opted_in'
  }
  try {
    const { bytes, mime } = await p.downloadMedia(ref, mediaLimitsFromEnv())
    const vendorId = String((msg.payload?.['id'] as string | undefined) ?? msg.id)
    const path = `${msg.conversation_id}/${vendorId.replace(/[^A-Za-z0-9._-]/g, '_')}.${mediaExtension(mime)}`
    const { error } = await db.storage.from(deps.bucket ?? RUNTIME_ENV.WA_MEDIA_BUCKET).upload(path, bytes, { contentType: mime, upsert: true })
    if (error) throw new Error(error.message)
    await db.from('wa_messages').update({ media_ref: path, mime }).eq('id', msg.id)
    msg.media_ref = path
    msg.mime = mime
    return 'stored'
  } catch (e) {
    const code = e instanceof MediaRefusedError ? e.code : 'error'
    console.warn('[wa] media not stored', code, (e as Error).message.slice(0, 200))
    await mark(`refused:${code}`, (e as Error).message)
    return 'refused'
  }
}

// ── the sweep (audit M33) ────────────────────────────────────────────────────

export interface SweepResult {
  /** Unprocessed inbound rows older than a minute, inside the window. */
  pending: number
  /** Of those, how many got a NEW job (their first enqueue had failed). */
  requeued: number
  /** Unprocessed rows older than the window (reported, never re-driven: a reply that late is worse than none). */
  stale: number
  error: string | null
}

export const SWEEP_MIN_AGE_MS = 60 * 1000
export const SWEEP_MAX_AGE_MS = 6 * 3600 * 1000

/**
 * Re-enqueue inbound messages stored but never processed (the enqueue failed, the
 * worker was down, the job died). The job id IS the message id, so a message whose
 * job still exists (queued, active, retrying, or failed — pg-boss keeps it ≥ 12 h)
 * gets no second job; only a message with no job at all is re-driven.
 */
export async function sweepUnprocessedInbound(db: SupabaseClient, enqueue: EnqueueFn, now: Date = new Date()): Promise<SweepResult> {
  const newest = new Date(now.getTime() - SWEEP_MIN_AGE_MS).toISOString()
  const oldest = new Date(now.getTime() - SWEEP_MAX_AGE_MS).toISOString()
  const { data, error } = await db.from('wa_messages').select('id').eq('direction', 'in').is('processed_at', null).lt('created_at', newest).gte('created_at', oldest).order('created_at', { ascending: true }).limit(200)
  if (error) return { pending: 0, requeued: 0, stale: 0, error: `sweep_read_failed:${error.message}` }
  let requeued = 0
  for (const r of (data as { id: string }[] | null) ?? []) {
    const jobId = await enqueue(r.id).catch(() => null)
    if (jobId) requeued++
  }
  const { count } = await db.from('wa_messages').select('id', { count: 'exact', head: true }).eq('direction', 'in').is('processed_at', null).lt('created_at', oldest).gte('created_at', new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString())
  return { pending: (data ?? []).length, requeued, stale: count ?? 0, error: null }
}

// ── consent, onboarding attach, replies ─────────────────────────────────────

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
  const identity = `+${phoneDigits(phoneE164)}`
  // Revoke any stale active grant on this channel, then insert the fresh consent. S3.1: a re-sent opt-in keyword ("hi",
  // "ok", "yes" with no session open) refreshes the consent but KEEPS the scopes a Munshi / procurement enable widened it
  // to — it used to re-insert [] and silently drop them. A first opt-in still grants no tools ([]). Audit M41: only the
  // scopes consented from THIS phone carry over; a grant from another phone is revoked, never inherited.
  const { data: prior } = await db.from('agent_grants').select('scopes, channel_identity').eq('user_id', userId).eq('persona', persona).eq('channel', 'whatsapp').is('revoked_at', null)
  const keep = [...new Set((((prior as { scopes: string[] | null; channel_identity: string | null }[] | null) ?? []).filter((g) => phoneDigits(g.channel_identity) === phoneDigits(phoneE164)).flatMap((g) => g.scopes ?? [])))]
  await db.from('agent_grants').update({ revoked_at: new Date().toISOString() }).eq('user_id', userId).eq('persona', persona).eq('channel', 'whatsapp').is('revoked_at', null)
  await db.from('agent_grants').insert({
    user_id: userId,
    persona,
    scopes: keep,
    channel: 'whatsapp',
    channel_identity: identity,
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
  const r = await provider().sendTemplate(String(conv.phone_e164), tpl.name, locale, [])
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
