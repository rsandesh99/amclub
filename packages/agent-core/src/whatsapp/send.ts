import type { SupabaseClient } from '@supabase/supabase-js'
import { agentSettingDefault, waPhoneFromVendor, type WaConsentPurpose, type WaSuppressionReason } from '@amclub/shared'
import type { SendResult, WaButton, WaLocale, WhatsAppProvider } from './types'
import { classifyWaError, waErrorTripsBreaker } from './errors'
import { resolveTemplate, templateComponents, type ResolvedTemplate } from './templates'

/**
 * ADR-030 §3 — the ONE WhatsApp send path. The web notification dispatcher and every runtime agent send through
 * `sendWhatsApp`; nothing else calls a driver's send methods. In order, it:
 *   1. refuses a bad phone (a business-scoped id is never reduced to digits);
 *   2. checks consent and suppression (`mayMessage`): a STOPped phone gets nothing but the opt-out confirmation;
 *      business-initiated sends need the purpose's opt-in; a direct reply inside the 24-h window needs only "not STOPped";
 *   3. picks free-form vs template from the conversation's window (with a safety margin), falling back to
 *      `fallbackTemplate` outside it, and resolves the template's name AND language together (audit B2);
 *   4. writes the outbound wa_messages row (status queued) under the unique idempotency key BEFORE the vendor call, so a
 *      retried job returns `duplicate` instead of sending twice;
 *   5. calls the driver with a timeout, classifies a Graph error (131047 outside window → retry as template once;
 *      131026 not on WhatsApp / 131050 stopped marketing → suppression; 130429 / 131056 rate limit → retryable;
 *      368 / 131031 account restricted → not retryable), and records the outcome, error code and category on the row.
 * Statuses and pricing arrive later through the webhook, which updates the same row (monotonic, 0086 trigger).
 *
 * A retry of a failed-but-retryable send reuses its row (the same idempotency key): the attempt is claimed by a
 * compare-and-set on the row's updated_at, so two workers never send it twice. Anything else under an existing key
 * (queued, sent, delivered …) is `duplicate` — a crash between the insert and the vendor call is never re-sent
 * blind (the notification outbox falls back to SMS instead).
 *
 * Before migration 0086 is applied (production applies it after the deploy) the consent and suppression tables and
 * the ledger columns are missing: the send falls back to the pre-ADR-030 rule (see `mayMessage`) and writes the row
 * the old way, after the call. Logged once; re-checked every 10 minutes.
 */

/** What to send. `template` names a registry kind (templates.ts), never a raw Meta template name. */
export type WaSendBody =
  | { type: 'template'; kind: string; locale: WaLocale; values: Record<string, string | null | undefined> }
  | { type: 'text'; text: string }
  | { type: 'buttons'; text: string; buttons: WaButton[]; listLabel?: string }
  | { type: 'cta_url'; text: string; label: string; url: string }
  | { type: 'media'; mime: string; caption?: string; filename?: string; url?: string; storagePath?: string; bucket?: string }

export interface WaSendRequest {
  /** E.164 digits, with or without '+'. */
  phoneE164: string
  userId?: string | null
  conversationId?: string | null
  purpose: WaConsentPurpose
  /** 'reply' = answering the user's own message inside the 24-h window (service); 'business' = we write first. */
  initiation: 'business' | 'reply'
  /** Notification kind or runtime message kind, recorded on the row. */
  kind: string
  body: WaSendBody
  /** Sent instead when free-form is not allowed (outside the window). None → skipped: outside_window. */
  fallbackTemplate?: Extract<WaSendBody, { type: 'template' }>
  /** Unique per logical message: `${notificationId}:whatsapp`, `${runId}:${step}`, `${inboundMessageId}:reply:${n}`. */
  idempotencyKey: string
  runId?: string | null
  notificationId?: string | null
  /** Payload merged into the row (e.g. a card's run id for the M42 binding). Never secrets. */
  meta?: Record<string, unknown>
  /** Payload used INSTEAD of `meta` when the fallback template goes (e.g. a template that carries no card must not
   *  carry the card's run id, or a quoted reply to it could bind to the card). Absent → `meta`. */
  fallbackMeta?: Record<string, unknown>
}

export type WaSendOutcome = 'sent' | 'stub' | 'duplicate' | 'skipped' | 'failed'
export type WaSkipReason =
  | 'bad_phone' | 'opted_out' | 'no_consent' | 'suppressed' | 'no_template' | 'template_not_approved'
  | 'outside_window' | 'not_live' | 'marketing_cap' | 'budget'
export type WaErrorKind =
  | 'outside_window' | 'marketing_limit' | 'not_on_whatsapp' | 'user_stopped_marketing' | 'rate_limited' | 'template'
  | 'account_restricted' | 'auth' | 'invalid' | 'server' | 'network' | 'unknown'

export interface WaSendError {
  code: number | null
  kind: WaErrorKind
  title: string
  retryable: boolean
}

export interface WaSendResult {
  outcome: WaSendOutcome
  reason?: WaSkipReason
  error?: WaSendError
  vendorMessageId?: string | null
  /** wa_messages.id of the outbound row (absent when skipped before a row was written). */
  messageId?: string | null
  /** True when a template was sent (the window was closed or the body was a template). */
  usedTemplate?: boolean
  /** 1 for a first send; > 1 when a retryable failure under the same key was re-sent. */
  attempt?: number
}

/** Settings the send path reads (registered in shared agent-settings; injectable so tests can stub them). */
export type WaSendSettingKey = 'wa_window_margin_seconds'
export type WaSendSettings = (key: WaSendSettingKey) => Promise<unknown>

export interface WaSendDeps {
  db: SupabaseClient
  provider: WhatsAppProvider
  now?: () => Date
  /** agent_settings reader; default = a 60-second cached read of `agent_settings` with the registry default. */
  settings?: WaSendSettings
}

export type MayMessage = { ok: true } | { ok: false; reason: Extract<WaSkipReason, 'bad_phone' | 'opted_out' | 'no_consent' | 'suppressed'> }

/** The one message a STOPped phone still gets: the confirmation of that STOP (once per STOP). */
export const WA_OPT_OUT_CONFIRMED_KIND = 'wa_opt_out_confirmed'

/** Retries of one logical message (the same idempotency key) stop here. */
export const WA_MAX_SEND_ATTEMPTS = 5
const RECHECK_MS = 10 * 60 * 1000
const BREAKER_MS = 10 * 60 * 1000
const DAY_MS = 24 * 3600 * 1000

// ── module state (per process): the account circuit breaker and the 0086-missing fallbacks ──────────────────────
let breakerUntil = 0
let breakerKind: WaErrorKind | null = null
let consentMissingUntil = 0
let ledgerMissingUntil = 0
const logged = new Set<string>()
function logOnce(key: string, line: string): void {
  if (logged.has(key)) return
  logged.add(key)
  console.error(line)
}

/** Test hook: forget the breaker, the fallbacks and the settings cache. */
export function resetWaSendStateForTests(): void {
  breakerUntil = 0
  breakerKind = null
  consentMissingUntil = 0
  ledgerMissingUntil = 0
  logged.clear()
  settingsCache.clear()
}

/** For /health and the admin console: whether the account circuit breaker is open. */
export function waCircuitState(now: Date = new Date()): { open: boolean; until: string | null; kind: WaErrorKind | null } {
  const open = now.getTime() < breakerUntil
  return { open, until: open ? new Date(breakerUntil).toISOString() : null, kind: open ? breakerKind : null }
}

/** A missing table / column (a migration not yet applied): Postgres 42P01 / 42703, PostgREST PGRST205 / PGRST204. */
export function isMissingSchemaError(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false
  const code = err.code ?? ''
  if (code === '42P01' || code === '42703' || code === 'PGRST205' || code === 'PGRST204') return true
  return /does not exist|could not find/i.test(err.message ?? '')
}

/** E.164 digits from a stored / typed phone ('+91 98765 43210' → '919876543210'); a non-phone (a BSUID) → null. */
export function normalizeWaPhone(phone: string | null | undefined): string | null {
  return waPhoneFromVendor(String(phone ?? '').trim().replace(/[\s\-().]/g, ''))
}

/** Order / payment kinds the pre-ADR-030 rule sent without an opt-in (used ONLY while 0086 is missing). */
const LEGACY_TRANSACTIONAL_KINDS: ReadonlySet<string> = new Set([
  'order_placed', 'order_accepted', 'requirements_submitted', 'order_in_progress', 'order_delivered',
  'order_completed', 'order_cancelled', 'order_auto_cancelled', 'order_disputed', 'revision_requested',
  'milestone_added', 'payout_paid', 'order_message',
])

/**
 * Consent + suppression for one phone and purpose (ADR-030 §2).
 *   - `business`: the purpose must be `opted_in`; `opted_out` → opted_out; no row → no_consent.
 *   - `reply` (a direct answer inside the window): refused only when the phone STOPped (transactional AND assistant
 *     opted out). Marketing is never a reply.
 *   - suppression (`wa_suppressions`, `until` null or future) blocks every purpose, except `marketing_stopped`, which
 *     blocks marketing only.
 *   - `wa_opt_out_confirmed` passes the consent check (it confirms the STOP; the send path allows it once per STOP).
 * Before 0086 (no wa_phone_consents): the old rule — replies pass; order / payment kinds pass; anything else needs an
 * active WhatsApp agent grant given from this phone (`channel_identity = '+' || phone`); marketing never.
 */
export async function mayMessage(
  db: SupabaseClient,
  phoneE164: string,
  purpose: WaConsentPurpose,
  initiation: 'business' | 'reply',
  opts: { kind?: string; userId?: string | null; now?: Date } = {},
): Promise<MayMessage> {
  const phone = normalizeWaPhone(phoneE164)
  if (!phone) return { ok: false, reason: 'bad_phone' }
  const now = opts.now ?? new Date()
  if (now.getTime() < consentMissingUntil) return legacyMayMessage(db, phone, purpose, initiation, opts)
  const { data, error } = await db.from('wa_phone_consents').select('purpose, status').eq('phone_e164', phone)
  if (error) {
    if (isMissingSchemaError(error)) {
      consentMissingUntil = now.getTime() + RECHECK_MS
      logOnce('consent_missing', '[wa] wa_phone_consents missing — using the pre-ADR-030 consent rule until migration 0086 is applied')
      return legacyMayMessage(db, phone, purpose, initiation, opts)
    }
    console.error('[wa] consent read failed — not sending', error.message)
    return { ok: false, reason: 'no_consent' }
  }
  const status = new Map(((data as { purpose: string; status: string }[] | null) ?? []).map((r) => [r.purpose, r.status]))
  if (opts.kind !== WA_OPT_OUT_CONFIRMED_KIND) {
    const stopped = status.get('transactional') === 'opted_out' && status.get('assistant') === 'opted_out'
    if (initiation === 'reply' && purpose !== 'marketing') {
      if (stopped) return { ok: false, reason: 'opted_out' }
    } else {
      const st = status.get(purpose)
      if (st === 'opted_out' || (stopped && purpose !== 'marketing')) return { ok: false, reason: 'opted_out' }
      if (st !== 'opted_in') return { ok: false, reason: 'no_consent' }
    }
  }
  const { data: sup, error: supErr } = await db.from('wa_suppressions').select('reason, until').eq('phone_e164', phone).maybeSingle()
  if (supErr && !isMissingSchemaError(supErr)) {
    console.error('[wa] suppression read failed — not sending', supErr.message)
    return { ok: false, reason: 'suppressed' }
  }
  const s = sup as { reason: string; until: string | null } | null
  if (s && (s.until === null || Date.parse(s.until) > now.getTime()) && (s.reason !== 'marketing_stopped' || purpose === 'marketing')) {
    return { ok: false, reason: 'suppressed' }
  }
  return { ok: true }
}

async function legacyMayMessage(db: SupabaseClient, phone: string, purpose: WaConsentPurpose, initiation: 'business' | 'reply', opts: { kind?: string; userId?: string | null }): Promise<MayMessage> {
  if (purpose === 'marketing') return { ok: false, reason: 'no_consent' }
  if (initiation === 'reply' || opts.kind === WA_OPT_OUT_CONFIRMED_KIND) return { ok: true }
  if (opts.kind && LEGACY_TRANSACTIONAL_KINDS.has(opts.kind)) return { ok: true }
  if (!opts.userId) return { ok: false, reason: 'no_consent' }
  const { data } = await db.from('agent_grants').select('id').eq('user_id', opts.userId).eq('channel', 'whatsapp').eq('channel_identity', `+${phone}`).is('revoked_at', null).limit(1)
  return Array.isArray(data) && data.length > 0 ? { ok: true } : { ok: false, reason: 'no_consent' }
}

// ── suppression (also written by the runtime's status webhook) ────────────────────────────────────────────────────

const SUPPRESSION_RANK: Record<WaSuppressionReason, number> = { marketing_stopped: 1, undeliverable: 2, not_on_whatsapp: 2, blocked: 3, admin: 4 }

/**
 * Record a delivery-driven suppression for a phone (131026 → not_on_whatsapp, 131050 → marketing_stopped). A live
 * suppression of a stronger reason (admin, blocked) is never replaced by a weaker one. Missing table → no-op.
 */
export async function recordWaSuppression(db: SupabaseClient, phoneE164: string, reason: WaSuppressionReason, errorCode: number | null, until: Date | null, now: Date = new Date()): Promise<boolean> {
  const phone = normalizeWaPhone(phoneE164)
  if (!phone) return false
  const { data: existing, error: readErr } = await db.from('wa_suppressions').select('reason, until').eq('phone_e164', phone).maybeSingle()
  if (readErr) {
    if (!isMissingSchemaError(readErr)) console.error('[wa] suppression read failed', readErr.message)
    return false
  }
  const ex = existing as { reason: WaSuppressionReason; until: string | null } | null
  const live = ex && (ex.until === null || Date.parse(ex.until) > now.getTime())
  if (live && (SUPPRESSION_RANK[ex.reason] ?? 0) > SUPPRESSION_RANK[reason]) return false
  const { error } = await db.from('wa_suppressions').upsert({ phone_e164: phone, reason, error_code: errorCode, until: until ? until.toISOString() : null }, { onConflict: 'phone_e164' })
  if (error) {
    if (!isMissingSchemaError(error)) console.error('[wa] suppression write failed', error.message)
    return false
  }
  return true
}

/** The suppression a Graph error implies, if any (not on WhatsApp: 30 days; stopped marketing: 90 days). */
export function suppressionForError(kind: WaErrorKind, now: Date): { reason: WaSuppressionReason; until: Date } | null {
  if (kind === 'not_on_whatsapp') return { reason: 'not_on_whatsapp', until: new Date(now.getTime() + 30 * DAY_MS) }
  if (kind === 'user_stopped_marketing') return { reason: 'marketing_stopped', until: new Date(now.getTime() + 90 * DAY_MS) }
  return null
}

// ── settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

const settingsCache = new Map<string, { at: number; value: unknown }>()
function defaultSettings(db: SupabaseClient): WaSendSettings {
  return async (key) => {
    const hit = settingsCache.get(key)
    if (hit && Date.now() - hit.at < 60_000) return hit.value
    let value: unknown = agentSettingDefault(key)
    try {
      const { data, error } = await db.from('agent_settings').select('value').eq('key', key).maybeSingle()
      if (!error && data && (data as { value?: unknown }).value !== undefined && (data as { value?: unknown }).value !== null) value = (data as { value: unknown }).value
    } catch {
      /* the default */
    }
    settingsCache.set(key, { at: Date.now(), value })
    return value
  }
}

async function windowMarginMs(settings: WaSendSettings): Promise<number> {
  const v = Number(await settings('wa_window_margin_seconds').catch(() => null))
  return Number.isInteger(v) && v >= 0 && v <= 3600 ? v * 1000 : 120_000
}

// ── the send ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface ConvRow { id: string; phone_e164: string; user_id: string | null; window_open_until: string | null }

/** The conversation of this phone (the request's, when it IS this phone's), created when the phone has none yet. */
async function conversationFor(db: SupabaseClient, phone: string, req: WaSendRequest): Promise<ConvRow | null> {
  const cols = 'id, phone_e164, user_id, window_open_until'
  if (req.conversationId) {
    const { data } = await db.from('wa_conversations').select(cols).eq('id', req.conversationId).maybeSingle()
    const c = data as ConvRow | null
    if (c && normalizeWaPhone(c.phone_e164) === phone) return c
  }
  const byPhone = async () => ((await db.from('wa_conversations').select(cols).eq('phone_e164', phone).maybeSingle()).data as ConvRow | null) ?? null
  const found = await byPhone()
  if (found) return found
  const locale = req.body.type === 'template' ? req.body.locale : req.fallbackTemplate?.locale ?? 'en'
  const { data: created, error } = await db.from('wa_conversations').insert({ phone_e164: phone, user_id: req.userId ?? null, locale }).select(cols).single()
  if (!error && created) return created as ConvRow
  return byPhone() // a concurrent first message / send created it
}

function mediaKind(mime: string): 'image' | 'audio' | 'video' | 'document' {
  const m = mime.toLowerCase()
  return m.startsWith('image/') ? 'image' : m.startsWith('audio/') ? 'audio' : m.startsWith('video/') ? 'video' : 'document'
}

/** wa_messages.kind for an outbound body (0086 list); `legacy` maps to the pre-0086 check constraint. */
function rowKind(body: WaSendBody, legacy: boolean): string {
  if (body.type === 'template') return 'template'
  if (body.type === 'text') return 'text'
  if (body.type === 'buttons') return 'button'
  if (body.type === 'cta_url') return legacy ? 'button' : 'interactive'
  const k = mediaKind(body.mime)
  return legacy && k === 'video' ? 'document' : k
}

function rowBody(body: WaSendBody): string | null {
  if (body.type === 'template') return null
  if (body.type === 'media') return body.caption ?? null
  return body.text
}

function bodyPayload(body: WaSendBody, tpl: ResolvedTemplate | null): Record<string, unknown> {
  if (body.type === 'template' && tpl) {
    const c = templateComponents(tpl.spec, body.values)
    return { template_name: tpl.name, params: c.body ?? [], ...(c.urlButton ? { url_suffix: c.urlButton.suffix } : {}) }
  }
  if (body.type === 'buttons') return { buttons: body.buttons.map((b) => b.id) }
  if (body.type === 'cta_url') return { cta_url: body.url }
  if (body.type === 'media') return { media: body.storagePath ?? body.url ?? null, mime: body.mime }
  return {}
}

/** A template whose mirrored Meta state says it cannot go (paused, disabled, rejected, re-categorised …). */
async function templateUsable(db: SupabaseClient, tpl: ResolvedTemplate): Promise<boolean> {
  const { data, error } = await db.from('wa_templates').select('status, category').eq('name', tpl.name).eq('language', tpl.language).maybeSingle()
  if (error || !data) return true // not mirrored yet (or 0086 missing): Meta itself refuses an unapproved template
  const row = data as { status: string; category: string | null }
  if (['pending', 'rejected', 'paused', 'disabled', 'in_appeal', 'deleted'].includes(row.status)) return false
  return !row.category || row.category === tpl.category
}

async function callDriver(deps: WaSendDeps, to: string, body: WaSendBody, tpl: ResolvedTemplate | null): Promise<SendResult> {
  const p = deps.provider
  try {
    if (body.type === 'template') {
      if (!tpl) return { ok: false, vendorMessageId: null, detail: 'error:no_template' }
      return await p.sendTemplate(to, { name: tpl.name, language: tpl.language }, templateComponents(tpl.spec, body.values))
    }
    if (body.type === 'text') return await p.sendText(to, body.text)
    if (body.type === 'buttons') return await p.sendButtons(to, body.text, body.buttons, body.listLabel)
    if (body.type === 'cta_url') return await p.sendCtaUrl(to, body.text, body.label, body.url)
    if (body.storagePath) {
      const { data, error } = await deps.db.storage.from(body.bucket ?? 'wa-media').download(body.storagePath)
      if (error || !data) return { ok: false, vendorMessageId: null, detail: `error:media_read ${error?.message ?? ''}`.trim() }
      const bytes = new Uint8Array(await (data as Blob).arrayBuffer())
      return await p.sendMedia(to, { bytes, mime: body.mime, ...(body.caption ? { caption: body.caption } : {}), ...(body.filename ? { filename: body.filename } : {}) })
    }
    return await p.sendMedia(to, { ...(body.url ? { url: body.url } : {}), mime: body.mime, ...(body.caption ? { caption: body.caption } : {}), ...(body.filename ? { filename: body.filename } : {}) })
  } catch (e) {
    const message = (e as Error).message ?? 'network'
    return { ok: false, vendorMessageId: null, detail: `error:${message}`, error: { code: null, subcode: null, title: message.slice(0, 200), message: message.slice(0, 500), httpStatus: null } }
  }
}

function sendErrorOf(r: SendResult): WaSendError {
  if (!r.error) return { code: null, kind: 'invalid', title: r.detail.replace(/^error:/, '').slice(0, 200) || 'send_failed', retryable: false }
  const { kind, retryable } = classifyWaError(r.error.code, r.error.httpStatus)
  return { code: r.error.code, kind, title: r.error.title || r.error.message, retryable }
}

type Claim =
  | { mode: 'new'; id: string; attempt: 1 }
  | { mode: 'retry'; id: string; attempt: number }
  | { mode: 'duplicate'; id: string | null }
  | { mode: 'legacy' }
  | { mode: 'error'; message: string }

/** Write the queued row under the idempotency key, or claim a retryable failed attempt of the same key. */
async function claimRow(db: SupabaseClient, row: Record<string, unknown>, key: string, now: Date): Promise<Claim> {
  if (now.getTime() < ledgerMissingUntil) return { mode: 'legacy' }
  const { data, error } = await db.from('wa_messages').insert(row).select('id').single()
  if (!error && data) return { mode: 'new', id: (data as { id: string }).id, attempt: 1 }
  const code = (error as { code?: string } | null)?.code
  if (code === '23505') {
    const { data: ex } = await db.from('wa_messages').select('id, status, updated_at, payload').eq('idempotency_key', key).maybeSingle()
    const e = ex as { id: string; status: string; updated_at: string; payload: Record<string, unknown> | null } | null
    if (!e) return { mode: 'duplicate', id: null }
    const prev = e.payload ?? {}
    const attempt = (Number(prev['amc_attempt']) || 1) + 1
    if (e.status === 'failed' && prev['amc_retryable'] === true && attempt <= WA_MAX_SEND_ATTEMPTS) {
      const { data: claimed } = await db.from('wa_messages').update({ payload: { ...prev, amc_attempt: attempt, amc_retryable: false } }).eq('id', e.id).eq('updated_at', e.updated_at).select('id')
      if (Array.isArray(claimed) && claimed.length === 1) return { mode: 'retry', id: e.id, attempt }
    }
    return { mode: 'duplicate', id: e.id }
  }
  // 0086 missing: an unknown column, or the old status check refusing 'queued'
  if (isMissingSchemaError(error) || code === '23514') {
    ledgerMissingUntil = now.getTime() + RECHECK_MS
    logOnce('ledger_missing', '[wa] wa_messages ledger columns missing — writing outbound rows the pre-ADR-030 way (no idempotency) until migration 0086 is applied')
    return { mode: 'legacy' }
  }
  return { mode: 'error', message: error?.message ?? 'insert_failed' }
}

/** The opt-out confirmation goes once per STOP: none sent (and not failed) since the phone's latest opt-out. */
async function optOutAlreadyConfirmed(db: SupabaseClient, phone: string, conversationId: string): Promise<boolean> {
  const { data: last, error } = await db.from('wa_phone_consents').select('updated_at').eq('phone_e164', phone).eq('status', 'opted_out').order('updated_at', { ascending: false }).limit(1).maybeSingle()
  if (error || !last) return false
  const since = (last as { updated_at: string }).updated_at
  const { data: sent } = await db.from('wa_messages').select('id').eq('conversation_id', conversationId).eq('direction', 'out').eq('notification_kind', WA_OPT_OUT_CONFIRMED_KIND).neq('status', 'failed').gte('created_at', since).limit(1)
  return Array.isArray(sent) && sent.length > 0
}

export async function sendWhatsApp(deps: WaSendDeps, req: WaSendRequest): Promise<WaSendResult> {
  const now = deps.now?.() ?? new Date()
  const nowIso = now.toISOString()
  const phone = normalizeWaPhone(req.phoneE164)
  if (!phone) return { outcome: 'skipped', reason: 'bad_phone' }
  const db = deps.db
  const settings = deps.settings ?? defaultSettings(db)

  // 1. the conversation carries the 24-hour window (and every outbound row belongs to one)
  const conv = await conversationFor(db, phone, req)
  if (!conv) return { outcome: 'failed', error: { code: null, kind: 'unknown', title: 'conversation_unavailable', retryable: true } }
  const margin = await windowMarginMs(settings)
  const inWindow = !!conv.window_open_until && Date.parse(conv.window_open_until) - margin > now.getTime()

  // 2. consent: a "reply" is service only while the window is open; after it, it is business-initiated
  const initiation = req.initiation === 'reply' && inWindow ? 'reply' : 'business'
  const may = await mayMessage(db, phone, req.purpose, initiation, { kind: req.kind, userId: req.userId ?? conv.user_id, now })
  if (!may.ok) return { outcome: 'skipped', reason: may.reason }
  if (req.kind === WA_OPT_OUT_CONFIRMED_KIND && now.getTime() >= consentMissingUntil && (await optOutAlreadyConfirmed(db, phone, conv.id))) {
    return { outcome: 'skipped', reason: 'opted_out' }
  }

  // 3. free-form only inside the window; a template anywhere
  let body: WaSendBody = req.body
  let meta = req.meta ?? {}
  if (body.type !== 'template' && !inWindow) {
    if (!req.fallbackTemplate) return { outcome: 'skipped', reason: 'outside_window' }
    body = req.fallbackTemplate
    meta = req.fallbackMeta ?? meta
  }
  let tpl: ResolvedTemplate | null = null
  if (body.type === 'template') {
    tpl = resolveTemplate(body.kind, body.locale)
    if (!tpl) return { outcome: 'skipped', reason: 'no_template' }
    if (!(await templateUsable(db, tpl))) return { outcome: 'skipped', reason: 'template_not_approved' }
  }

  // 4. the account circuit breaker: after a restriction / auth error nothing calls Meta for a while
  if (now.getTime() < breakerUntil) {
    return { outcome: 'failed', error: { code: null, kind: 'account_restricted', title: 'circuit_open', retryable: false } }
  }

  // 5. the ledger row BEFORE the vendor call
  const base = { purpose: req.purpose, initiation, amc_kind: req.kind }
  const rowFor = (b: WaSendBody, t: ResolvedTemplate | null, legacy: boolean, m: Record<string, unknown>) => ({
    conversation_id: conv.id,
    direction: 'out',
    kind: rowKind(b, legacy),
    body: rowBody(b),
    template_name: t?.name ?? null,
    ...(legacy
      ? {}
      : {
          idempotency_key: req.idempotencyKey,
          user_id: req.userId ?? conv.user_id ?? null,
          notification_kind: req.kind,
          notification_id: req.notificationId ?? null,
          run_id: req.runId ?? null,
          template_language: t?.language ?? null,
          category: t?.category ?? null,
        }),
    payload: { ...m, ...bodyPayload(b, t), ...(legacy ? {} : { amc_purpose: base.purpose, amc_initiation: base.initiation }) },
  })
  const claim = await claimRow(db, { ...rowFor(body, tpl, false, meta), status: 'queued' }, req.idempotencyKey, now)
  if (claim.mode === 'duplicate') return { outcome: 'duplicate', messageId: claim.id }
  if (claim.mode === 'error') {
    console.error('[wa] outbound ledger write failed — not sending', claim.message)
    return { outcome: 'failed', error: { code: null, kind: 'unknown', title: 'ledger_write_failed', retryable: true } }
  }
  const legacy = claim.mode === 'legacy'
  const attempt = claim.mode === 'legacy' ? 1 : claim.attempt

  // 6. the vendor call; outside the window after all (131047) → once more as the fallback template
  let r = await callDriver(deps, phone, body, tpl)
  if (!r.ok && r.error?.code === 131047 && body.type !== 'template' && req.fallbackTemplate) {
    const fb = resolveTemplate(req.fallbackTemplate.kind, req.fallbackTemplate.locale)
    if (fb && (await templateUsable(db, fb))) {
      body = req.fallbackTemplate
      tpl = fb
      meta = req.fallbackMeta ?? meta
      r = await callDriver(deps, phone, body, tpl)
    }
  }
  const usedTemplate = body.type === 'template'

  // 7. classify: suppression, circuit breaker
  const error = r.ok ? undefined : sendErrorOf(r)
  if (error) {
    const sup = suppressionForError(error.kind, now)
    if (sup) await recordWaSuppression(db, phone, sup.reason, error.code, sup.until, now)
    if (waErrorTripsBreaker(error.kind)) {
      breakerUntil = now.getTime() + BREAKER_MS
      breakerKind = error.kind
      console.error(`[wa] account-level send error ${error.code ?? ''} (${error.kind}: ${error.title}) — WhatsApp sends paused for 10 minutes`)
    }
  }
  const status = r.ok ? (r.detail === 'stub' ? 'stub' : 'sent') : 'failed'

  // 8. the outcome on the row
  let messageId: string | null = null
  const final = rowFor(body, tpl, legacy, meta)
  const outcomePayload = { ...final.payload, detail: r.detail, ...(legacy ? {} : { amc_attempt: attempt, amc_retryable: error?.retryable ?? false }), ...(error ? { amc_error_kind: error.kind } : {}) }
  if (legacy) {
    const { data, error: insErr } = await db.from('wa_messages').insert({ ...final, vendor_message_id: r.vendorMessageId, status, payload: outcomePayload }).select('id').single()
    if (insErr) console.error('[wa] outbound row insert failed (legacy)', insErr.message)
    messageId = (data as { id: string } | null)?.id ?? null
  } else {
    messageId = claim.mode === 'new' || claim.mode === 'retry' ? claim.id : null
    const { error: updErr } = await db
      .from('wa_messages')
      .update({ ...final, vendor_message_id: r.vendorMessageId, status, status_at: nowIso, error_code: error?.code ?? null, error_title: error?.title ?? null, payload: outcomePayload })
      .eq('id', messageId!)
    if (updErr) console.error('[wa] outbound row update failed', updErr.message)
  }
  if (r.ok) await db.from('wa_conversations').update({ last_outbound_at: nowIso }).eq('id', conv.id)

  return {
    outcome: r.ok ? (status === 'stub' ? 'stub' : 'sent') : 'failed',
    ...(error ? { error } : {}),
    vendorMessageId: r.vendorMessageId,
    messageId,
    usedTemplate,
    attempt,
  }
}
