import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DEFAULT_WA_RATE_MILLIPAISE,
  PENDING_MEDIA_KEY,
  classifyWaError,
  createWhatsAppProvider,
  isMissingSchemaError,
  metaVerifyChallenge,
  recordWaSuppression,
  suppressionForError,
  waMessageCostMillipaise,
  whatsappConfigFromEnv,
  whatsappDriverState,
  whatsappIsLive,
  type AccountChange,
  type InboundMessage,
  type StatusUpdate,
  type WhatsAppConfig,
  type WhatsAppProvider,
} from '@amclub/agent-core'
import { redactChatSecrets, waLocaleFor } from '@amclub/shared'
import { admin } from '../deps'
import { readAgentSettings } from '../settings'
import { userByPhone } from './binding'

/**
 * WhatsApp webhook ingest (S0.5, ADR-030 §3, audit B6 / B7 / 2.9 and the smaller must-fix items). Verify → parse →
 * store → enqueue; never replies, never downloads media (audit M34: the vendor media id rides in the payload and the
 * job fetches it). A store failure answers 5xx so Meta retries (audit M33; replays are idempotent).
 *
 *  - messages: the conversation is keyed by the phone digits; a message that carries only a business-scoped user id
 *    (BSUID, audit 2.9) is keyed `u:<bsuid>` (never digits, so it can never collide with or bind to a phone) unless a
 *    conversation already holds that BSUID. The text is stored REDACTED (card numbers, codes next to OTP / PIN / CVV —
 *    shared `redactChatSecrets`), in the body and inside the stored payload, with `amc_redacted` recording what was
 *    removed. The 24-hour window only ever moves forward; an ad referral opens the 72-hour free entry window. An
 *    inbound message proves the number is on WhatsApp: a not_on_whatsapp / undeliverable suppression is lifted.
 *  - statuses: status, time, error code / title, and Meta's pricing (billable, category, cost in millipaise from the
 *    `wa_rate_millipaise` registry) onto the outbound row (never backwards: the 0086 trigger). A failed status with
 *    131026 / 131050 records the suppression. A status write that fails answers 500 so Meta retries.
 *  - account changes (template status / category / quality, phone quality, account updates and alerts) are stored in
 *    wa_account_events; template changes also update the wa_templates mirror the send path checks.
 * Before migration 0086 every new column / table is optional: the old shape is written and the gap logged once.
 */

export const WA_WINDOW_MS = 24 * 3600 * 1000
export const WA_ENTRY_WINDOW_MS = 72 * 3600 * 1000
/** An inbound message older than this when its job runs is never answered (a reply that late is worse than none). */
export const STALE_INBOUND_MS = 24 * 3600 * 1000

export interface IngestResult {
  ok: boolean
  status: 200 | 400 | 401 | 500 | 503
  error?: string
  stored: number
  statuses: number
  account?: number
  /** Entries addressed to another phone number id / WABA (dropped, never ingested). */
  dropped?: number
}

/** Enqueue hook (injected by the server) so this module never imports the worker — no import cycle. */
export type EnqueueFn = (messageId: string) => Promise<string | null>

export interface IngestDeps {
  db?: SupabaseClient
  provider?: WhatsAppProvider
  cfg?: WhatsAppConfig
  env?: Record<string, string | undefined>
  now?: () => Date
  /** The wa_rate_millipaise registry (default: agent_settings, else the launch rates). */
  rates?: () => Promise<Readonly<Record<string, number>>>
}

const logged = new Set<string>()
function logOnce(key: string, line: string): void {
  if (logged.has(key)) return
  logged.add(key)
  console.error(line)
}

export function waVerifyChallenge(query: Record<string, string | undefined>): string | null {
  return metaVerifyChallenge(query, whatsappConfigFromEnv().verifyToken)
}

/** Unsigned (stub-driver) webhooks: only outside production, and only when a developer opts in. */
export function acceptsUnsignedWebhooks(env: Record<string, string | undefined> = process.env): boolean {
  return env['NODE_ENV'] !== 'production' && env['WHATSAPP_WEBHOOK_ALLOW_UNSIGNED'] === 'true'
}

/** True when Meta's timestamp of an inbound message is more than 24 h before `now` (the job then never answers it). */
export function isStaleInbound(ts: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (ts === null || ts === undefined) return false
  const t = ts instanceof Date ? ts.getTime() : Date.parse(ts)
  return Number.isFinite(t) && now.getTime() - t > STALE_INBOUND_MS
}

/** The vendor time of a stored inbound row: the raw Meta message's `timestamp` (unix seconds) in its payload. */
export function inboundVendorTime(payload: Record<string, unknown> | null | undefined): Date | null {
  const ts = Number(payload?.['timestamp'])
  return Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null
}

/**
 * For the wa.inbound job: a stale inbound message (vendor time > 24 h before now) is marked processed with
 * `payload.amc_stale = true` and must not be answered. Returns true when it was stale.
 */
export async function markInboundStaleIfOld(db: SupabaseClient, msg: { id: string; payload: Record<string, unknown> | null }, now: Date = new Date()): Promise<boolean> {
  const at = inboundVendorTime(msg.payload)
  if (!at || !isStaleInbound(at, now)) return false
  await db.from('wa_messages').update({ payload: { ...(msg.payload ?? {}), amc_stale: true }, processed_at: now.toISOString() }).eq('id', msg.id)
  console.warn('[wa] stale inbound message not answered', JSON.stringify({ id: msg.id, vendor_at: at.toISOString() }))
  return true
}

const maxIso = (a: string | null | undefined, b: string): string => (a && Date.parse(a) > Date.parse(b) ? a : b)

// ── the webhook ──────────────────────────────────────────────────────────────

export async function ingestWaWebhook(rawBody: string, headers: Record<string, string | undefined>, enqueue: EnqueueFn, deps: IngestDeps = {}): Promise<IngestResult> {
  const env = deps.env ?? process.env
  // fail loud (ADR-030 §1): a driver named without its credentials never silently becomes a stub that accepts traffic
  const state = whatsappDriverState(env)
  if (state.requested === 'meta_cloud' && !state.configured) {
    logOnce('not_configured', `[wa] WHATSAPP_DRIVER=meta_cloud but ${state.missing.join(', ')} unset — refusing to ingest (503)`)
    return { ok: false, status: 503, error: 'whatsapp_not_configured', stored: 0, statuses: 0 }
  }
  const cfg = deps.cfg ?? whatsappConfigFromEnv(env)
  const provider = deps.provider ?? createWhatsAppProvider(cfg)
  // A live driver must prove the vendor signature. The stub cannot, so it accepts nothing unless a developer opts in
  // outside production (audit H4): otherwise anyone could post a message "from" any registered number.
  if (whatsappIsLive(cfg)) {
    if (!provider.verifySignature(rawBody, headers)) return { ok: false, status: 401, error: 'bad_signature', stored: 0, statuses: 0 }
  } else if (!acceptsUnsignedWebhooks(env)) {
    return { ok: false, status: 401, error: 'webhook_not_configured', stored: 0, statuses: 0 }
  }
  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return { ok: false, status: 400, error: 'bad_json', stored: 0, statuses: 0 }
  }
  const parsed = provider.parseInbound(body)
  if (parsed.dropped > 0) console.warn(`[wa] dropped ${parsed.dropped} webhook entr${parsed.dropped === 1 ? 'y' : 'ies'} addressed to another phone number id / WABA`)
  const db = deps.db ?? admin()
  const now = deps.now?.() ?? new Date()
  let stored = 0
  let failed = 0
  for (const m of parsed.messages) {
    try {
      if (await storeInbound(db, m, enqueue, now)) stored++
    } catch (e) {
      failed++
      console.error('[wa] inbound store failed — answering 5xx so the vendor retries', (e as Error).message)
    }
  }
  let statuses = 0
  if (parsed.statuses.length) {
    const rates = await (deps.rates ?? (() => rateRegistry(db)))().catch(() => DEFAULT_WA_RATE_MILLIPAISE)
    for (const s of parsed.statuses) {
      try {
        await applyStatus(db, s, rates, now)
        statuses++
      } catch (e) {
        failed++
        console.error('[wa] status write failed — answering 5xx so the vendor retries', (e as Error).message)
      }
    }
  }
  let account = 0
  for (const a of parsed.account) {
    try {
      await recordAccountChange(db, a, now)
      account++
    } catch (e) {
      failed++
      console.error('[wa] account event write failed — answering 5xx so the vendor retries', (e as Error).message)
    }
  }
  if (failed > 0) return { ok: false, status: 500, error: 'store_failed', stored, statuses, account, dropped: parsed.dropped }
  return { ok: true, status: 200, stored, statuses, account, dropped: parsed.dropped }
}

// ── messages ─────────────────────────────────────────────────────────────────

/** The stored text: secrets typed into chat are removed from the body AND the raw payload (`amc_redacted` says what). */
export function redactInbound(m: Pick<InboundMessage, 'body' | 'raw'>): { body: string | null; payload: Record<string, unknown> } {
  const kinds = new Set<string>()
  const scrub = (t: unknown): unknown => {
    if (typeof t !== 'string' || !t) return t
    const r = redactChatSecrets(t)
    for (const k of r.redacted) kinds.add(k)
    return r.text
  }
  const raw = (m.raw && typeof m.raw === 'object' ? JSON.parse(JSON.stringify(m.raw)) : { raw: m.raw }) as Record<string, unknown>
  const text = raw['text'] as Record<string, unknown> | undefined
  if (text && typeof text === 'object') text['body'] = scrub(text['body'])
  for (const k of ['image', 'video', 'document']) {
    const media = raw[k] as Record<string, unknown> | undefined
    if (media && typeof media === 'object' && 'caption' in media) media['caption'] = scrub(media['caption'])
  }
  const body = scrub(m.body) as string | null
  if (kinds.size) raw['amc_redacted'] = [...kinds]
  return { body, payload: raw }
}

/** Kinds the pre-0086 check constraint accepts; anything newer is stored as `unknown` there. */
const LEGACY_KINDS = new Set(['text', 'audio', 'image', 'document', 'button', 'template', 'unknown'])
let processedColumnMissingOnInsert = false

/** Store one inbound message and enqueue its job. Returns true when a NEW row was stored. Throws on a store failure. */
export async function storeInbound(db: SupabaseClient, m: InboundMessage, enqueue: EnqueueFn, now: Date = new Date()): Promise<boolean> {
  const conv = await upsertInboundConversation(db, m, now)
  if (m.fromE164) await liftDeliverySuppression(db, m.fromE164, now)
  const { body, payload: redactedPayload } = redactInbound(m)
  const payload = m.mediaRef ? { ...redactedPayload, [PENDING_MEDIA_KEY]: m.mediaRef } : redactedPayload
  const row = { conversation_id: conv.id, direction: 'in', vendor_message_id: m.vendorMessageId, kind: m.kind, body, media_ref: null, mime: m.mime, status: 'received', payload }
  let { data: inserted, error } = await insertInbound(db, row)
  if (error && error.code === '23514' && !LEGACY_KINDS.has(m.kind)) {
    // 0086 not applied: the old kind check refuses video / sticker / location … — store it as unknown
    logOnce('legacy_kinds', '[wa] wa_messages kind check predates 0086 — storing new message kinds as unknown until it is applied')
    ;({ data: inserted, error } = await insertInbound(db, { ...row, kind: 'unknown', payload: { ...payload, amc_kind: m.kind } }))
  }
  if (error) {
    // 23505 = replayed webhook (vendor_message_id unique) → idempotent. If the first delivery never got processed
    // (the enqueue failed), re-enqueue: the job id is the message id, so this can never create a second job.
    if (error.code === '23505') {
      await reenqueueIfUnprocessed(db, m.vendorMessageId, enqueue)
      return false
    }
    throw new Error(`wa_messages insert: ${error.message}`)
  }
  if (!inserted?.id) return false
  // the message is stored: an enqueue failure is logged and the sweep picks the row up
  await enqueue(inserted.id).catch((e: Error) => console.error('[wa] enqueue failed (the sweep will retry)', e.message))
  return true
}

/**
 * Insert an inbound row as UNPROCESSED (processed_at null — 0079's column default is now(), so rows written by
 * anything else never enter the sweep). Before 0079 is applied the column is unknown: the row is stored without it
 * (logged once) — a store must never fail on the sweep's bookkeeping.
 */
async function insertInbound(db: SupabaseClient, row: Record<string, unknown>): Promise<{ data: { id: string } | null; error: { message: string; code?: string } | null }> {
  if (!processedColumnMissingOnInsert) {
    const r = await db.from('wa_messages').insert({ ...row, processed_at: null }).select('id').maybeSingle()
    const code = (r.error as { code?: string } | null)?.code
    if (!r.error || code === '23505' || code === '23514' || !/processed_at/.test(r.error.message)) return r as { data: { id: string } | null; error: { message: string; code?: string } | null }
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

interface ConvRow {
  id: string
  user_id: string | null
  locale: string
  window_open_until?: string | null
  last_inbound_at?: string | null
  bsuid?: string | null
  entry_window_until?: string | null
  first_referral?: unknown
}
const CONV_COLS = 'id, user_id, locale, window_open_until, last_inbound_at, bsuid, entry_window_until, first_referral'
const CONV_COLS_LEGACY = 'id, user_id, locale, window_open_until, last_inbound_at'

async function readConversation(db: SupabaseClient, col: 'phone_e164' | 'bsuid', value: string): Promise<ConvRow | null> {
  const r = await db.from('wa_conversations').select(CONV_COLS).eq(col, value).maybeSingle()
  if (!r.error) return (r.data as ConvRow | null) ?? null
  if (!isMissingSchemaError(r.error)) throw new Error(`wa_conversations read: ${r.error.message}`)
  if (col === 'bsuid') return null // 0086 not applied: no BSUID column to look up
  logOnce('conv_cols', '[wa] wa_conversations 0086 columns missing (bsuid, entry window, referral) — storing without them until 0086 is applied')
  const l = await db.from('wa_conversations').select(CONV_COLS_LEGACY).eq(col, value).maybeSingle()
  if (l.error) throw new Error(`wa_conversations read: ${l.error.message}`)
  return (l.data as ConvRow | null) ?? null
}

/** Update / insert trying the 0086 columns first; on a missing column, again without them. */
async function writeConversation(db: SupabaseClient, op: 'insert' | 'update', base: Record<string, unknown>, extra: Record<string, unknown>, id?: string): Promise<{ data: ConvRow | null; error: { message: string; code?: string } | null }> {
  const attempt = async (row: Record<string, unknown>) => {
    const q = op === 'insert' ? db.from('wa_conversations').insert(row).select(CONV_COLS_LEGACY).single() : db.from('wa_conversations').update(row).eq('id', id!).select('id').maybeSingle()
    const r = await q
    return { data: (r.data as ConvRow | null) ?? null, error: r.error as { message: string; code?: string } | null }
  }
  if (!Object.keys(extra).length) return attempt(base)
  let r = await attempt({ ...base, ...extra })
  if (r.error && isMissingSchemaError(r.error)) {
    logOnce('conv_cols', '[wa] wa_conversations 0086 columns missing (bsuid, entry window, referral) — storing without them until 0086 is applied')
    r = await attempt(base)
  } else if (r.error && r.error.code === '23505' && 'bsuid' in extra) {
    // another conversation (a `u:<bsuid>` one) may already hold this BSUID: keep the phone conversation without it
    // (an insert that fails again on the phone itself is a concurrent first message — the caller reads it back)
    const rest = Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'bsuid'))
    r = await attempt({ ...base, ...rest })
  }
  return r
}

/**
 * The conversation an inbound message belongs to: its phone's (keyed by the digits), or — with no phone — the one
 * holding its BSUID, else a `u:<bsuid>` conversation (never bound to a user: binding needs a phone). The window only
 * moves forward; a referral opens the 72-hour entry window and is kept as the first referral.
 */
export async function upsertInboundConversation(db: SupabaseClient, m: Pick<InboundMessage, 'fromE164' | 'bsuid' | 'timestamp' | 'referral'>, now: Date = new Date()): Promise<{ id: string; user_id: string | null; locale: string }> {
  if (!m.fromE164 && !m.bsuid) throw new Error('inbound message without a phone or a business-scoped id')
  const ts = Date.parse(m.timestamp)
  const at = new Date(Number.isFinite(ts) ? ts : now.getTime())
  const inboundIso = at.toISOString()
  const windowIso = new Date(at.getTime() + WA_WINDOW_MS).toISOString()
  const entryIso = m.referral ? new Date(now.getTime() + WA_ENTRY_WINDOW_MS).toISOString() : null
  const key = m.fromE164 ?? `u:${m.bsuid}`

  let existing = m.fromE164 ? await readConversation(db, 'phone_e164', m.fromE164) : await readConversation(db, 'bsuid', m.bsuid!)
  if (!existing && !m.fromE164) existing = await readConversation(db, 'phone_e164', key)

  const extraFor = (c: ConvRow | null): Record<string, unknown> => {
    const extra: Record<string, unknown> = {}
    if (m.bsuid && !c?.bsuid) extra['bsuid'] = m.bsuid
    if (entryIso) extra['entry_window_until'] = maxIso(c?.entry_window_until, entryIso)
    if (m.referral && !c?.first_referral) extra['first_referral'] = { ...m.referral, at: inboundIso }
    return extra
  }

  if (existing) {
    const base = { last_inbound_at: maxIso(existing.last_inbound_at, inboundIso), window_open_until: maxIso(existing.window_open_until, windowIso) }
    const r = await writeConversation(db, 'update', base, extraFor(existing), existing.id)
    if (r.error) throw new Error(`wa_conversations update: ${r.error.message}`)
    // the binding is (re-)derived by the job before anything acts on it (audit M41)
    return { id: existing.id, user_id: existing.user_id, locale: existing.locale }
  }
  // a BSUID-only conversation is never bound: binding follows users.phone
  const user = m.fromE164 ? await userByPhone(db, m.fromE164) : null
  const base = { phone_e164: key, user_id: user?.id ?? null, locale: waLocaleFor(user?.preferred_locale), last_inbound_at: inboundIso, window_open_until: windowIso }
  const created = await writeConversation(db, 'insert', base, extraFor(null))
  if (!created.error && created.data) return { id: created.data.id, user_id: created.data.user_id, locale: created.data.locale }
  // a concurrent first message from the same sender created it: read it back and move its window forward
  const again = await readConversation(db, 'phone_e164', key)
  if (!again) throw new Error(`wa_conversations insert: ${created.error?.message ?? 'no row'}`)
  const r = await writeConversation(db, 'update', { last_inbound_at: maxIso(again.last_inbound_at, inboundIso), window_open_until: maxIso(again.window_open_until, windowIso) }, extraFor(again), again.id)
  if (r.error) throw new Error(`wa_conversations update: ${r.error.message}`)
  return { id: again.id, user_id: again.user_id, locale: again.locale }
}

/** An inbound message proves the number is on WhatsApp: lift a delivery suppression that says otherwise. */
export async function liftDeliverySuppression(db: SupabaseClient, phoneE164: string, now: Date = new Date()): Promise<void> {
  const nowIso = now.toISOString()
  const { error } = await db.from('wa_suppressions').update({ until: nowIso }).eq('phone_e164', phoneE164).in('reason', ['not_on_whatsapp', 'undeliverable']).gt('until', nowIso)
  if (error && !isMissingSchemaError(error)) console.warn('[wa] suppression lift failed', error.message)
}

// ── statuses ─────────────────────────────────────────────────────────────────

export async function rateRegistry(db: SupabaseClient): Promise<Readonly<Record<string, number>>> {
  const s = await readAgentSettings(db, ['wa_rate_millipaise'])
  const v = s.wa_rate_millipaise
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : DEFAULT_WA_RATE_MILLIPAISE
}

let statusColumnsMissing = false

/** One delivery status onto its outbound row (monotonic by the 0086 trigger). Throws when the write fails. */
export async function applyStatus(db: SupabaseClient, s: StatusUpdate, rates: Readonly<Record<string, number>>, now: Date = new Date()): Promise<void> {
  const patch: Record<string, unknown> = { status: s.status, status_at: s.timestamp }
  if (s.status === 'failed') {
    patch['error_code'] = s.errorCode
    patch['error_title'] = s.errorTitle
  }
  if (s.pricing) {
    patch['billable'] = s.pricing.billable
    patch['pricing_category'] = s.pricing.category
    patch['cost_millipaise'] = waMessageCostMillipaise(s.pricing, rates)
  }
  let error: { message: string; code?: string } | null = null
  if (!statusColumnsMissing) {
    ;({ error } = await db.from('wa_messages').update(patch).eq('vendor_message_id', s.vendorMessageId))
    if (error && isMissingSchemaError(error)) {
      statusColumnsMissing = true
      logOnce('status_cols', '[wa] wa_messages ledger columns missing — status callbacks record the status only until 0086 is applied (no error code, no pricing)')
    }
  }
  if (statusColumnsMissing) ({ error } = await db.from('wa_messages').update({ status: s.status }).eq('vendor_message_id', s.vendorMessageId))
  if (error) throw new Error(`wa_messages status: ${error.message}`)
  if (s.status === 'failed' && s.errorCode !== null) {
    const sup = suppressionForError(classifyWaError(s.errorCode, null).kind, now)
    if (sup) {
      const phone = s.recipientId ?? (await recipientOf(db, s.vendorMessageId))
      if (phone) await recordWaSuppression(db, phone, sup.reason, s.errorCode, sup.until, now)
    }
  }
}

async function recipientOf(db: SupabaseClient, vendorMessageId: string): Promise<string | null> {
  const { data } = await db.from('wa_messages').select('conversation_id').eq('vendor_message_id', vendorMessageId).maybeSingle()
  const convId = (data as { conversation_id?: string } | null)?.conversation_id
  if (!convId) return null
  const { data: c } = await db.from('wa_conversations').select('phone_e164').eq('id', convId).maybeSingle()
  return (c as { phone_e164?: string } | null)?.phone_e164 ?? null
}

// ── account changes ──────────────────────────────────────────────────────────

const TEMPLATE_STATUS: Record<string, string> = {
  APPROVED: 'approved',
  REINSTATED: 'approved',
  REJECTED: 'rejected',
  PAUSED: 'paused',
  DISABLED: 'disabled',
  PENDING: 'pending',
  IN_APPEAL: 'in_appeal',
  PENDING_DELETION: 'deleted',
  DELETED: 'deleted',
}

/** The wa_templates mirror update an account change implies (null when it concerns no template). */
export function templateMirrorPatch(a: AccountChange, now: Date = new Date()): Record<string, unknown> | null {
  const v = a.value
  const name = typeof v['message_template_name'] === 'string' ? v['message_template_name'] : null
  const language = typeof v['message_template_language'] === 'string' ? v['message_template_language'] : null
  if (!name || !language) return null
  const base: Record<string, unknown> = { name, language, synced_at: now.toISOString() }
  if (v['message_template_id'] !== undefined && v['message_template_id'] !== null) base['meta_template_id'] = String(v['message_template_id'])
  if (a.field === 'message_template_status_update') {
    const status = TEMPLATE_STATUS[String(v['event'] ?? '').toUpperCase()]
    if (!status) return null // FLAGGED / LIMIT_EXCEEDED …: the event is stored, the status stands
    const reason = typeof v['reason'] === 'string' && v['reason'] !== 'NONE' ? v['reason'] : null
    return { ...base, status, rejection_reason: status === 'rejected' || status === 'paused' || status === 'disabled' ? reason : null }
  }
  if (a.field === 'template_category_update') {
    const cat = String(v['new_category'] ?? v['correct_category'] ?? '').toLowerCase()
    return ['utility', 'marketing', 'authentication'].includes(cat) ? { ...base, category: cat } : null
  }
  if (a.field === 'message_template_quality_update') {
    const q = typeof v['new_quality_score'] === 'string' ? v['new_quality_score'].toLowerCase() : null
    return q ? { ...base, quality: q } : null
  }
  return null
}

/** Store an account change as received; template changes also update the mirror. Missing tables → logged, skipped. */
export async function recordAccountChange(db: SupabaseClient, a: AccountChange, now: Date = new Date()): Promise<void> {
  const { error } = await db.from('wa_account_events').insert({ field: a.field, entry_id: a.entryId, payload: a.value })
  if (error) {
    if (isMissingSchemaError(error)) {
      logOnce('account_events', `[wa] wa_account_events missing — account webhooks (${a.field}) are not stored until 0086 is applied`)
      return
    }
    throw new Error(`wa_account_events insert: ${error.message}`)
  }
  const patch = templateMirrorPatch(a, now)
  if (!patch) return
  const { error: tErr } = await db.from('wa_templates').upsert(patch, { onConflict: 'name,language' })
  if (tErr && !isMissingSchemaError(tErr)) throw new Error(`wa_templates upsert: ${tErr.message}`)
  if (patch['status'] === 'paused' || patch['status'] === 'disabled' || patch['category'] === 'marketing') {
    console.error(`[wa] template ${String(patch['name'])} (${String(patch['language'])}) is now ${String(patch['status'] ?? patch['category'])} — the send path refuses it`)
  }
}
