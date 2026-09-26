import type { SupabaseClient } from '@supabase/supabase-js'
import {
  MediaRefusedError,
  createSupabaseLedger,
  mediaExtension,
  mediaLimitsFromEnv,
  pendingMediaRef,
  type Ledger,
  type WaLocale,
  type WhatsAppProvider,
} from '@amclub/agent-core'
import {
  WA_CONSENT_PURPOSES,
  WA_PAYLOAD_START,
  WA_PAYLOAD_STOP,
  classifyWaKeyword,
  parseWaSystemPayload,
  waCopy,
  waLocaleFor,
  waMenuPayload,
  type WaKeywordIntent,
  type WaMenuItem,
} from '@amclub/shared'
import { admin } from '../deps'
import { RUNTIME_ENV } from '../env'
import { captureRuntimeEvent } from '../analytics'
import { dpdpDueDays, isAgentEnabledForUser, onboardingSessionTtlHours, waRebindDormantDays } from '../settings'
import { routeMunshiInbound } from '../agents/munshi/index'
import type { MunshiDecideJob } from '../agents/munshi/index'
import { routeSupportInbound } from '../agents/support/index'
import { routeProcurementInbound } from '../agents/procurement/index'
import type { ProcurementDecideJob, ProcurementTurnJob } from '../agents/procurement/index'
import { buttonPayloadOf } from '../agents/onboarding/index'
import { haltConversationWork, reconcileConversationOwner, unbindConversation, userByPhone, whatsappGrantsFor } from './binding'
import { routeFreeText } from './confirmations'
import { grantWhatsAppPersonas, isStopped, needsRebindConfirmation, phoneConsentState, recordWaConsent, revokeWhatsAppGrants } from './consent'
import {
  autoReplyDue,
  dataRequest,
  distinctIdOf,
  fixedReply,
  holdingReply,
  joinNeedsStart,
  publicUrl,
  rebindPrompt,
  reportMessage,
  runMenuItem,
  sendLanguageList,
  sendMenu,
  setLanguage,
  sharePhoneReply,
  type SendSystemFn,
  type WaTurn,
} from './menu'
import { type EnqueueFn } from './ingest'
import { runtimeWhatsApp, sendSystem } from './outbound'

// ADR-030: the webhook half (verify → store → enqueue, statuses, account events) lives in ./ingest.
export { acceptsUnsignedWebhooks, ingestWaWebhook, isStaleInbound, waVerifyChallenge, type EnqueueFn, type IngestResult } from './ingest'

/**
 * WhatsApp inbound (S0.5). Two halves:
 *  - ingestWaWebhook (./ingest.ts): verify → parse → upsert conversation → insert
 *    the redacted message idempotently on vendor_message_id → enqueue wa.inbound;
 *    statuses, pricing and account events. Never replies, never downloads media
 *    (audit M34). A store failure answers 5xx so the vendor retries (audit M33).
 *  - handleWaInbound (the job): the dispatcher (ADR-030 §2, below) → mark the
 *    row processed (audit M33: `sweepUnprocessedInbound` re-enqueues rows the job
 *    never finished). Consent and the non-AI HELP menu answer everyone through
 *    the ONE send path (sendSystem → agent-core sendWhatsApp: consent, window,
 *    ledger; a stub driver sends nothing); every model-backed agent is still
 *    gated on the runtime's AGENT_ENABLED + its own switch + cohort. Service role
 *    touches only wa_* + agent_grants (the user's own consent, from their own
 *    phone) + the agents' own tables (+ the user's own preferred_locale).
 */
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

// ── the wa.inbound job ───────────────────────────────────────────────────────

/** What the dispatcher works with; tests and the rigs inject their own (a recording send, a fake database). */
export interface DispatchDeps {
  db: SupabaseClient
  send: SendSystemFn
  now: () => Date
  /** The runtime's AGENT_ENABLED: gates every model-backed agent, never consent or the menu. */
  agentEnabled: boolean
  capture: (distinctId: string, event: string, props?: Record<string, unknown>) => void
  ledger: Ledger | null
}

function resolveDeps(p: Partial<DispatchDeps>): DispatchDeps {
  const db = p.db ?? admin()
  return {
    db,
    send: p.send ?? sendSystem,
    now: p.now ?? (() => new Date()),
    agentEnabled: p.agentEnabled ?? RUNTIME_ENV.AGENT_ENABLED,
    capture: p.capture ?? captureRuntimeEvent,
    ledger: p.ledger !== undefined ? p.ledger : createSupabaseLedger(db),
  }
}

/**
 * One inbound message. Marks the row processed when the dispatcher finished (a
 * throw leaves it unprocessed: pg-boss retries, and the sweep reports it).
 */
export async function handleWaInbound(messageId: string, hooks: InboundHooks = {}, deps: Partial<DispatchDeps> = {}): Promise<void> {
  const d = resolveDeps(deps)
  await dispatchWaInbound(messageId, hooks, d)
  await markProcessed(d.db, messageId)
}

let processedColumnMissingLogged = false
async function markProcessed(db: SupabaseClient, messageId: string): Promise<void> {
  const { error } = await db.from('wa_messages').update({ processed_at: new Date().toISOString() }).eq('id', messageId).is('processed_at', null)
  if (error && !processedColumnMissingLogged) {
    processedColumnMissingLogged = true
    console.error('[wa] could not mark the message processed (apply migration 0079: wa_messages.processed_at)', error.message)
  }
}

/** A message older than the 24-hour window is never answered (a reply that late is worse than none). */
const STALE_MS = 24 * 3600 * 1000
/** An unsolicited menu (free text nobody else took) at most every 10 minutes; a holding reply at most once a day. */
const MENU_GAP_MS = 10 * 60 * 1000
const HOLDING_GAP_MS = 24 * 3600 * 1000
/** The "share your phone number" / "confirm it's you" prompts at most once an hour. */
const PROMPT_GAP_MS = 3600 * 1000

type InboundRow = { kind: string; body: string | null; payload: Record<string, unknown> | null }

/** When the person sent it: Meta's `timestamp` (unix seconds) on the stored payload, else when we stored it. */
export function inboundSentAt(row: { payload: Record<string, unknown> | null; created_at?: string | null }): Date | null {
  const ts = row.payload?.['timestamp']
  const secs = typeof ts === 'string' || typeof ts === 'number' ? Number(ts) : NaN
  if (Number.isFinite(secs) && secs > 1_000_000_000) return new Date(secs * 1000)
  return row.created_at ? new Date(row.created_at) : null
}

function staleForReply(sentAt: Date | null, now: Date): boolean {
  return !!sentAt && now.getTime() - sentAt.getTime() > STALE_MS
}

/** Meta system messages (`type: system`): only the number change matters here. */
export function systemMessageType(row: InboundRow): string | null {
  const p = row.payload ?? {}
  if (row.kind !== 'system' && p['type'] !== 'system') return null
  const sys = p['system'] as { type?: unknown } | undefined
  return typeof sys?.type === 'string' ? sys.type : 'unknown'
}
const NUMBER_CHANGED = new Set(['user_changed_number', 'customer_changed_number'])

/** A tapped reply button / list row (stored as `button`, or `interactive` once 0086 widens the kinds). */
function tappedPayload(row: InboundRow): string | null {
  if (row.kind !== 'button' && row.kind !== 'interactive') return null
  return buttonPayloadOf({ ...row, kind: 'button' })
}

export interface WaSystemIntent {
  intent: WaKeywordIntent | 'menu_item'
  source: 'keyword' | 'button'
  /** Recorded on a consent event: the text actually typed, or `button:<payload>`. */
  keyword: string
  item?: WaMenuItem
  locale?: WaLocale | null
}

/**
 * The runtime's own intents (ADR-030, audit B4). A button is classified by its PAYLOAD id, never its visible title:
 * ours (`wa:start`, `wa:stop`, `wa:menu:<item>`, `wa:lang:<l>`), or a template quick reply whose payload IS the STOP /
 * START keyword; any other payload belongs to an agent (the nudge offer's "No" is `nudge:no:<run>`, never STOP).
 * Typed text goes through shared `classifyWaKeyword`: greetings are never consent, "no" / "cancel" never STOP.
 */
export function systemIntentOf(row: InboundRow): WaSystemIntent | null {
  const payload = tappedPayload(row)
  if (payload !== null) {
    const keyword = `button:${payload}`.slice(0, 60)
    const sys = parseWaSystemPayload(payload)
    if (sys?.kind === 'start') return { intent: 'start', source: 'button', keyword }
    if (sys?.kind === 'stop') return { intent: 'stop', source: 'button', keyword }
    if (sys?.kind === 'menu') return sys.item === 'stop' ? { intent: 'stop', source: 'button', keyword } : { intent: 'menu_item', source: 'button', keyword, item: sys.item }
    if (sys?.kind === 'lang') return { intent: 'language', source: 'button', keyword, locale: sys.locale }
    const k = classifyWaKeyword(payload)
    if (k && (k.intent === 'stop' || k.intent === 'start')) return { intent: k.intent, source: 'button', keyword }
    return null
  }
  if (row.kind !== 'text') return null
  const k = classifyWaKeyword(row.body)
  if (!k) return null
  return { intent: k.intent, source: 'keyword', keyword: String(row.body ?? '').trim().slice(0, 60), ...(k.intent === 'language' ? { locale: k.locale ?? null } : {}) }
}

interface ConvRow {
  id: string
  phone_e164: string
  user_id: string | null
  locale: string | null
  last_holding_reply_at: string | null
  active_session_id: string | null
  support_ticket_id: string | null
}

/**
 * The dispatcher (ADR-030 §2; audit B1 / B3 / B4 / B8). In order:
 *   0. a Meta system message: a number change unbinds the conversation; nothing is ever sent;
 *   1. a business-scoped id with no phone ('u:…'): "share your phone number", nothing else;
 *   2. the owner is re-derived from users.phone (audit M41);
 *   3. STOP (typed in en / hi / te / ta, or a button) always wins: opt-out for every purpose (recorded even for an
 *      unknown number), every WhatsApp grant of the owner revoked, the conversation's work halted, the confirmation
 *      once;
 *   4. a STOPped phone gets nothing more (no model, no media, no menu) — except a later START;
 *   5. an account not signed in for wa_rebind_dormant_days, or after Meta said the number changed hands: "sign in to
 *      confirm it's you", nothing else for that account;
 *   6. START: opt-in (transactional + assistant) and a WhatsApp grant per persona held, then the confirmation;
 *   7. a message older than the window is not answered;
 *   8. media (only for a number with a grant from it), then REPORT / MY DATA / DELETE MY DATA and our menu buttons;
 *   9. the active onboarding interview takes everything else (a language name or "yes" is an answer there);
 *  10. HELP / MENU / "?" → the menu; LANGUAGE / a language name → switch;
 *  11. the agents' buttons and open proposals (Munshi, procurement; a typed yes binds at most one — audit M42);
 *  12. a greeting → the menu; JOIN → the onboarding interview (after START) or the menu;
 *  13. the Support agent for an enabled user with a grant from this phone;
 *  14. anything else: text → the menu (spaced), other kinds → the holding reply (≤ 1 a day). An open support ticket
 *      keeps a person's thread quiet.
 */
async function dispatchWaInbound(messageId: string, hooks: InboundHooks, d: DispatchDeps): Promise<void> {
  const db = d.db
  const now = d.now()
  const { data: msg } = await db.from('wa_messages').select('id, conversation_id, vendor_message_id, kind, body, payload, media_ref, mime, created_at').eq('id', messageId).maybeSingle()
  if (!msg) return
  const { data: convData } = await db.from('wa_conversations').select('id, phone_e164, user_id, locale, last_holding_reply_at, active_session_id, support_ticket_id').eq('id', msg.conversation_id).maybeSingle()
  if (!convData) return
  const conv = convData as ConvRow
  const row: InboundRow = { kind: msg.kind as string, body: (msg.body as string | null) ?? null, payload: (msg.payload as Record<string, unknown> | null) ?? null }
  const vendorMessageId = (msg.vendor_message_id as string | null) ?? null
  const stale = staleForReply(inboundSentAt({ payload: row.payload, created_at: (msg.created_at as string | null) ?? null }), now)
  const turn: WaTurn = { db, send: d.send, conv: { id: conv.id, phone_e164: conv.phone_e164, user_id: conv.user_id }, locale: waLocaleFor(conv.locale), messageId, now, capture: d.capture }

  // 0. Meta system messages are never answered; "user changed number" unbinds (the next message re-derives the owner)
  const sysType = systemMessageType(row)
  if (sysType) {
    if (NUMBER_CHANGED.has(sysType)) await unbindConversation(db, conv, { ledger: d.ledger, now, reason: 'number_changed' })
    return
  }

  // 1. a business-scoped id with no phone: nothing can be linked or recorded
  if (conv.phone_e164.startsWith('u:')) {
    if (!stale && autoReplyDue(conv.last_holding_reply_at, now, PROMPT_GAP_MS)) await sharePhoneReply(turn)
    return
  }

  // 2. audit M41 — the owner is re-derived from users.phone on EVERY message, before anything acts on the binding
  const rec = await reconcileConversationOwner(db, { id: conv.id, phone_e164: conv.phone_e164, user_id: conv.user_id }, { ledger: d.ledger, now })
  if (rec.userId !== conv.user_id) {
    conv.user_id = rec.userId
    conv.active_session_id = null
    conv.support_ticket_id = null
    if (rec.locale) conv.locale = waLocaleFor(rec.locale)
    turn.conv.user_id = rec.userId
    turn.locale = waLocaleFor(conv.locale)
  }
  const phone = conv.phone_e164
  const sys = systemIntentOf(row)

  // 3. STOP always wins
  if (sys?.intent === 'stop') {
    await handleStop(turn, d, sys, { vendorMessageId, stale })
    return
  }

  // 4. a STOPped phone: nothing but a later START
  const consent = await phoneConsentState(db, phone)
  if (consent.ready && isStopped(consent.purposes) && sys?.intent !== 'start') return

  // 5. recycled / shared numbers: an account that has not signed in for a while confirms first
  if (conv.user_id && (await rebindNeeded(db, conv.id, conv.user_id, now))) {
    if (!stale && autoReplyDue(conv.last_holding_reply_at, now, PROMPT_GAP_MS)) await rebindPrompt(turn)
    return
  }

  // 6. START (typed or the button) — the ONLY opt-in on WhatsApp
  if (sys?.intent === 'start') {
    await handleStart(turn, d, sys, { vendorMessageId, stale })
    return
  }

  // 7. never answer a message older than the window
  if (stale) return

  // 8. audit M34 — media is fetched here, capped, and only for a bound number that opted in from this phone
  if (pendingMediaRef(row.payload) && !msg.media_ref) {
    const grants = conv.user_id ? await whatsappGrantsFor(db, conv.user_id, phone) : []
    await resolveInboundMedia(db, { id: msg.id as string, conversation_id: conv.id, media_ref: null, mime: (msg.mime as string | null) ?? null, payload: row.payload }, grants)
  }
  if (sys?.intent === 'report') return reportMessage(turn)
  if (sys?.intent === 'my_data' || sys?.intent === 'delete_data') return dataRequest(turn, sys.intent === 'my_data' ? 'access' : 'erasure', await dpdpDueDays(db))
  if (sys?.intent === 'menu_item' && sys.item) {
    if ((await runMenuItem(turn, sys.item)) === 'stop') await handleStop(turn, d, { ...sys, intent: 'stop' }, { vendorMessageId, stale })
    return
  }
  if (sys?.intent === 'language' && sys.source === 'button' && sys.locale) return setLanguage(turn, sys.locale, 'button')

  // 9. S1.6 — an active onboarding session routes EVERY other message into the interview (one turn per message)
  if (d.agentEnabled && conv.user_id && conv.active_session_id && hooks.enqueueOnboarding) {
    await hooks.enqueueOnboarding({ kind: 'message', sessionId: String(conv.active_session_id), messageId })
    return
  }

  // 10. HELP / MENU / "?" and the language switch
  if (sys?.intent === 'help') return sendMenu(turn, 'keyword')
  if (sys?.intent === 'language') return sys.locale ? setLanguage(turn, sys.locale, 'keyword') : sendLanguageList(turn)

  // 11. the agents' buttons and open proposals — BEFORE the greeting: "yes" / "ok" is a greeting to the menu but an
  //     answer to an open proposal (audit M42 binds a free-text yes to at most ONE proposal)
  if (d.agentEnabled && conv.user_id) {
    const userId = conv.user_id
    // S2.2 — a Munshi button whose run belongs to this user.
    if (hooks.enqueueMunshiDecide && (await routeMunshiInbound(db, { messageId, userId, row }, hooks))) return
    // S3.1 — the procurement pointer is read HERE: a missing column (0045 not applied yet) then costs this branch only.
    const { data: ps } = await db.from('wa_conversations').select('procurement_session_id').eq('id', conv.id).maybeSingle()
    const procurementSessionId = ((ps as { procurement_session_id?: string | null } | null)?.procurement_session_id as string | null) ?? null
    if (hooks.enqueueProcurementTurn && (await routeProcurementInbound(db, { messageId, conversationId: conv.id, userId, row, procurementSessionId }, hooks))) return
    const free = await routeFreeText(db, { messageId, conversationId: conv.id, userId, locale: turn.locale, row, procurementSessionId }, hooks)
    if (free.routed) return
  }

  // 12. a greeting opens the menu (never consent); JOIN starts the provider interview once they opted in
  if (sys?.intent === 'greeting') {
    if (conv.support_ticket_id) return // a person is on this thread
    return sendMenu(turn, 'greeting')
  }
  if (sys?.intent === 'join') return handleJoin(turn, d, hooks)

  // 13. S2.3 — the Support agent for an enabled user with a grant from this phone (an open ticket stores and stays quiet)
  if (d.agentEnabled && conv.user_id && (await whatsappGrantsFor(db, conv.user_id, phone)).length > 0) {
    const routed = await routeSupportInbound(db, { messageId, conversationId: conv.id, userId: conv.user_id, row, supportTicketId: conv.support_ticket_id }, hooks)
    if (routed) return
  }

  // 14. anything else
  if (conv.support_ticket_id) return // a person is on this thread; the message is stored for them
  if (row.kind === 'text' || tappedPayload(row) !== null) {
    if (autoReplyDue(conv.last_holding_reply_at, now, MENU_GAP_MS)) await sendMenu(turn, 'text')
    return
  }
  if (autoReplyDue(conv.last_holding_reply_at, now, HOLDING_GAP_MS)) await holdingReply(turn)
}

/** STOP: every purpose, every grant, the conversation's work halted; the confirmation only when the state changed. */
async function handleStop(turn: WaTurn, d: DispatchDeps, sys: WaSystemIntent, m: { vendorMessageId: string | null; stale: boolean }): Promise<void> {
  const userId = turn.conv.user_id
  const source = sys.source === 'button' ? 'whatsapp_button' : 'whatsapp_keyword'
  const r = await recordWaConsent(d.db, { phone: turn.conv.phone_e164, userId, purposes: WA_CONSENT_PURPOSES, action: 'opt_out', source, keyword: sys.keyword, vendorMessageId: m.vendorMessageId, locale: turn.locale })
  // consent withdrawal is never narrowed: every WhatsApp grant of the owner, whichever phone it came from
  if (userId) await revokeWhatsAppGrants(d.db, userId, turn.now)
  await haltConversationWork(d.db, turn.conv, userId, { ledger: d.ledger, now: turn.now, reason: 'wa_stop' })
  // a STOP that could not be recorded is retried (the job throws; pg-boss retries; grants are already revoked)
  if (!r.ok && r.reason === 'error') throw new Error(`wa_consent_record_failed:${r.error ?? ''}`)
  d.capture(distinctIdOf(turn), 'wa_consent_changed', { purpose: 'all', optIn: false, source, known: !!userId, recorded: r.ok })
  // the one message a stopped phone still gets — once (a repeated STOP changes nothing and gets nothing); without 0086
  // the old behaviour (always confirm)
  if (m.stale || (r.ok && r.changed === 0)) return
  await fixedReply(turn, 'wa_opt_out_confirmed', 'opt_out_confirmed', {}, [{ id: WA_PAYLOAD_START, title: waCopy('button_start_again', turn.locale) }])
}

/** START: transactional + assistant for the phone, a WhatsApp grant per persona the account holds, the confirmation. */
async function handleStart(turn: WaTurn, d: DispatchDeps, sys: WaSystemIntent, m: { vendorMessageId: string | null; stale: boolean }): Promise<void> {
  const userId = turn.conv.user_id
  const source = sys.source === 'button' ? 'whatsapp_button' : 'whatsapp_keyword'
  const r = await recordWaConsent(d.db, { phone: turn.conv.phone_e164, userId, purposes: ['transactional', 'assistant'], action: 'opt_in', source, keyword: sys.keyword, vendorMessageId: m.vendorMessageId, locale: turn.locale })
  if (!r.ok && r.reason === 'error') throw new Error(`wa_consent_record_failed:${r.error ?? ''}`)
  const personas = userId ? await grantWhatsAppPersonas(d.db, userId, turn.conv.phone_e164, { locale: turn.locale, source, keyword: sys.keyword, vendorMessageId: m.vendorMessageId }, turn.now) : []
  d.capture(distinctIdOf(turn), 'wa_consent_changed', { purpose: 'transactional+assistant', optIn: true, source, known: !!userId, recorded: r.ok, personas })
  if (m.stale) return
  if (userId) {
    await fixedReply(turn, 'wa_opt_in_confirmed', 'opt_in_confirmed', {}, [{ id: waMenuPayload('open'), title: waCopy('item_open', turn.locale) }, { id: WA_PAYLOAD_STOP, title: waCopy('item_stop', turn.locale) }])
    return
  }
  // an unknown number: the phone's consent is recorded (it binds when they sign up with it); nothing recorded → the menu
  if (!r.ok) return sendMenu(turn, 'keyword')
  await fixedReply(turn, 'wa_opt_in_confirmed', 'opt_in_confirmed_unknown', { url: publicUrl('/signup', turn.locale) })
}

/** JOIN: the provider interview once this phone opted in (a grant from it); before that, the Start button. */
async function handleJoin(turn: WaTurn, d: DispatchDeps, hooks: InboundHooks): Promise<void> {
  const userId = turn.conv.user_id
  if (!userId) return sendMenu(turn, 'join')
  if ((await whatsappGrantsFor(d.db, userId, turn.conv.phone_e164)).length === 0) return joinNeedsStart(turn)
  if (d.agentEnabled && hooks.enqueueOnboarding && (await isAgentEnabledForUser(d.db, 'onboarding', userId))) {
    const sessionId = await attachOrCreateOnboardingSession(d.db, turn.conv.id, userId, turn.locale)
    if (sessionId) {
      await hooks.enqueueOnboarding({ kind: 'start', sessionId })
      return
    }
  }
  return sendMenu(turn, 'join')
}

/** users.last_seen_at (else created_at) vs wa_rebind_dormant_days, and a "number changed" seen after the last sign-in. */
async function rebindNeeded(db: SupabaseClient, conversationId: string, userId: string, now: Date): Promise<boolean> {
  const [days, { data: u }, { data: changed }] = await Promise.all([
    waRebindDormantDays(db),
    db.from('users').select('last_seen_at, created_at').eq('id', userId).maybeSingle(),
    db.from('wa_messages').select('kind, body, payload, created_at').eq('conversation_id', conversationId).eq('direction', 'in').eq('payload->>type', 'system').order('created_at', { ascending: false }).limit(5),
  ])
  const user = u as { last_seen_at?: string | null; created_at?: string | null } | null
  if (!user) return false
  const rows = (changed as Array<InboundRow & { created_at: string }> | null) ?? []
  const changedAt = rows.find((r) => NUMBER_CHANGED.has(systemMessageType(r) ?? ''))?.created_at ?? null
  return needsRebindConfirmation({ lastSeenAt: user.last_seen_at ?? null, createdAt: user.created_at ?? null }, now, days, changedAt)
}

// ── media (audit M34) ────────────────────────────────────────────────────────

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
  const p = deps.provider ?? runtimeWhatsApp()
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

// ── onboarding attach ────────────────────────────────────────────────────────

/**
 * S1.6 — the user's active session (a web-started one has no conversation yet:
 * JOIN attaches it) or a fresh one; wa_conversations.active_session_id is the
 * dispatcher's O(1) route for every later message.
 */
async function attachOrCreateOnboardingSession(db: SupabaseClient, conversationId: string, userId: string, locale: WaLocale): Promise<string | null> {
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
