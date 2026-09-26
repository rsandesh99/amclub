import 'server-only'
import { createHash } from 'crypto'
import {
  createWhatsAppProvider,
  sendWhatsApp,
  whatsappConfigFromEnv,
  WA_TEMPLATES,
  type WaSendRequest,
  type WaSendResult,
} from '@amclub/agent-core'
import {
  aggregateWaSpend,
  compareWaTemplates,
  mapGraphTemplate,
  maskWaPhone,
  safeGraphNext,
  waAccountHealth,
  waCodeTemplates,
  waPreview,
  WA_CONSENT_PURPOSES,
  type WaSpendReport,
  type WaTemplateDbRow,
  type WaTemplateStatusRow,
  type WaTemplateUpsert,
} from '@amclub/shared'
import { fetchWithTimeout } from '@/lib/outbound'
import { fetchPages, notReady, phoneDigits, type Admin } from '@/lib/privacy/common'

/**
 * ADR-030 §6 — the WhatsApp ops console (/admin/whatsapp). Every read is on the service role behind requireAdmin (the
 * routes); nothing here returns a secret or a full phone number (phones are masked to the last four digits, a
 * suppression is addressed by an opaque key). Reads of 0086 tables / columns report `notReady` until it is applied.
 */

// ── driver state ─────────────────────────────────────────────────────────────

export const WA_GRAPH_DEFAULT_VERSION = 'v24.0'

export interface WaDriverState {
  /** The driver in use (the stub unless the requested driver has its credentials). */
  driver: 'meta_cloud' | 'interakt' | 'stub'
  /** A real (billing) driver is configured. */
  live: boolean
  /** The requested driver has every credential it needs (incl. the webhook secret). */
  configured: boolean
  graphVersion: string
  phoneNumberIdSet: boolean
  tokenSet: boolean
  appSecretSet: boolean
  wabaIdSet: boolean
}

/**
 * Local fallback for agent-core `whatsappDriverState()` (the transport work adds it; on merge, switch to it — same
 * shape). Booleans only: values never leave the server.
 */
export function waDriverState(env: Record<string, string | undefined> = process.env): WaDriverState {
  const cfg = whatsappConfigFromEnv(env)
  const set = (k: string) => typeof env[k] === 'string' && env[k]!.trim().length > 0
  const requested = env['WHATSAPP_DRIVER'] ?? 'stub'
  const configured =
    requested === 'meta_cloud' ? set('WHATSAPP_PHONE_NUMBER_ID') && set('WHATSAPP_ACCESS_TOKEN') && set('WHATSAPP_APP_SECRET')
    : requested === 'interakt' ? set('INTERAKT_API_KEY')
    : false
  return {
    driver: cfg.driver,
    live: cfg.driver !== 'stub',
    configured,
    graphVersion: graphVersion(env),
    phoneNumberIdSet: set('WHATSAPP_PHONE_NUMBER_ID'),
    tokenSet: set('WHATSAPP_ACCESS_TOKEN'),
    appSecretSet: set('WHATSAPP_APP_SECRET'),
    wabaIdSet: set('WHATSAPP_WABA_ID'),
  }
}

export function graphVersion(env: Record<string, string | undefined> = process.env): string {
  const v = (env['WHATSAPP_GRAPH_VERSION'] ?? '').trim()
  return /^v\d{1,3}\.\d{1,2}$/.test(v) ? v : WA_GRAPH_DEFAULT_VERSION
}

// ── overview ─────────────────────────────────────────────────────────────────

export interface WaOverview {
  driver: WaDriverState
  health: { quality: string | null; tier: string | null; event: string | null; at: string | null }
  lastInboundAt: string | null
  lastStatusAt: string | null
  conversations: number | null
  boundConversations: number | null
  notReady: boolean
}

export async function waOverview(admin: Admin): Promise<WaOverview> {
  const [lastIn, conv, bound, lastStatus, events] = await Promise.all([
    admin.from('wa_messages').select('created_at').eq('direction', 'in').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    admin.from('wa_conversations').select('id', { count: 'exact', head: true }),
    admin.from('wa_conversations').select('id', { count: 'exact', head: true }).not('user_id', 'is', null),
    admin.from('wa_messages').select('status_at').eq('direction', 'out').not('status_at', 'is', null).order('status_at', { ascending: false }).limit(1).maybeSingle(),
    admin.from('wa_account_events').select('field, payload, created_at').in('field', ['phone_number_quality_update', 'account_update']).order('created_at', { ascending: false }).limit(20),
  ])
  const missing = notReady('wa_messages.status_at (0086)', lastStatus.error) || notReady('wa_account_events (0086)', events.error)
  return {
    driver: waDriverState(),
    health: waAccountHealth(((events.data ?? []) as { field: string; payload: unknown; created_at: string }[])),
    lastInboundAt: (lastIn.data as { created_at?: string } | null)?.created_at ?? null,
    lastStatusAt: (lastStatus.data as { status_at?: string } | null)?.status_at ?? null,
    conversations: conv.count ?? null,
    boundConversations: bound.count ?? null,
    notReady: missing,
  }
}

// ── delivery log ─────────────────────────────────────────────────────────────

export const WA_OUTBOUND_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed', 'stub', 'skipped'] as const

export interface WaDeliveryFilters { kind?: string | null; status?: string | null; errorCode?: number | null }
export interface WaDeliveryRow {
  id: string
  kind: string
  messageKind: string
  template: string | null
  language: string | null
  category: string | null
  status: string
  errorCode: number | null
  errorTitle: string | null
  phoneMasked: string | null
  createdAt: string
  statusAt: string | null
}
export interface WaDeliveryLog {
  notReady: boolean
  rows: WaDeliveryRow[]
  counts: Record<string, number>
  topErrors: { code: number; title: string | null; n: number }[]
  kinds: string[]
  total: number
}

const DAY = 86_400_000

async function phonesOf(admin: Admin, convIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(convIds)]
  if (ids.length === 0) return new Map()
  const { data } = await admin.from('wa_conversations').select('id, phone_e164').in('id', ids)
  return new Map(((data ?? []) as { id: string; phone_e164: string }[]).map((c) => [c.id, c.phone_e164]))
}

export async function waDeliveryLog(admin: Admin, f: WaDeliveryFilters, now = new Date()): Promise<WaDeliveryLog> {
  const since = new Date(now.getTime() - 7 * DAY).toISOString()
  const empty: WaDeliveryLog = { notReady: true, rows: [], counts: {}, topErrors: [], kinds: [], total: 0 }
  let q = admin
    .from('wa_messages')
    .select('id, conversation_id, kind, notification_kind, template_name, template_language, category, status, error_code, error_title, created_at, status_at')
    .eq('direction', 'out')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(300)
  if (f.kind) q = q.eq('notification_kind', f.kind)
  if (f.status) q = q.eq('status', f.status)
  if (f.errorCode != null) q = q.eq('error_code', f.errorCode)
  const out = () => admin.from('wa_messages').select('id', { count: 'exact', head: true }).eq('direction', 'out').gte('created_at', since)
  // counts are exact (head counts per status); the error ranking reads the latest failures page by page (≤ 5,000) and
  // the kind filter's choices come from the latest page (PostgREST answers ≤ 1,000 rows per request)
  const [list, total, perStatus, failures, recent] = await Promise.all([
    q,
    out(),
    Promise.all(WA_OUTBOUND_STATUSES.map(async (s) => [s, await out().eq('status', s)] as const)),
    fetchPages<{ error_code: number; error_title: string | null }>((from, to) => admin.from('wa_messages').select('error_code, error_title').eq('direction', 'out').gte('created_at', since).not('error_code', 'is', null).order('created_at', { ascending: false }).order('id').range(from, to), 5000),
    admin.from('wa_messages').select('notification_kind').eq('direction', 'out').gte('created_at', since).not('notification_kind', 'is', null).order('created_at', { ascending: false }).limit(1000),
  ])
  const firstErr = list.error ?? total.error ?? failures.error ?? recent.error ?? perStatus.find(([, r]) => r.error)?.[1].error ?? null
  if (firstErr) {
    if (notReady('wa_messages ledger columns (0086)', firstErr)) return empty
    throw new Error(`wa_messages: ${firstErr.message}`)
  }
  const counts: Record<string, number> = {}
  for (const [s, r] of perStatus) if (r.count) counts[s] = r.count
  const errors = new Map<number, { title: string | null; n: number }>()
  for (const r of failures.rows) {
    const e = errors.get(r.error_code) ?? { title: r.error_title, n: 0 }
    e.n++
    errors.set(r.error_code, e)
  }
  const kinds = new Set(((recent.data ?? []) as { notification_kind: string }[]).map((r) => r.notification_kind))
  const raw = (list.data ?? []) as Array<{ id: string; conversation_id: string; kind: string; notification_kind: string | null; template_name: string | null; template_language: string | null; category: string | null; status: string; error_code: number | null; error_title: string | null; created_at: string; status_at: string | null }>
  const phones = await phonesOf(admin, raw.map((r) => r.conversation_id))
  return {
    notReady: false,
    rows: raw.map((r) => ({
      id: r.id,
      kind: r.notification_kind ?? r.kind,
      messageKind: r.kind,
      template: r.template_name,
      language: r.template_language,
      category: r.category,
      status: r.status,
      errorCode: r.error_code,
      errorTitle: r.error_title,
      phoneMasked: maskWaPhone(phones.get(r.conversation_id)),
      createdAt: r.created_at,
      statusAt: r.status_at,
    })),
    counts,
    topErrors: [...errors.entries()].map(([code, e]) => ({ code, title: e.title, n: e.n })).sort((a, b) => b.n - a.n).slice(0, 10),
    kinds: [...kinds].sort(),
    total: total.count ?? 0,
  }
}

export interface WaMessageDetail {
  id: string
  direction: string
  kind: string
  body: string | null
  transcript: string | null
  hasMedia: boolean
  mime: string | null
  template: string | null
  status: string
  errorCode: number | null
  errorTitle: string | null
  phoneMasked: string | null
  createdAt: string
  redactedAt: string | null
  legalHold: boolean
}

/** One message with its text (the route audit-logs the read). Secrets are removed again on the way out. */
export async function waMessageDetail(admin: Admin, id: string): Promise<WaMessageDetail | null | 'not_ready'> {
  const { data, error } = await admin
    .from('wa_messages')
    .select('id, conversation_id, direction, kind, body, transcript, media_ref, mime, template_name, status, error_code, error_title, created_at, redacted_at, legal_hold')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    if (notReady('wa_messages ledger columns (0086)', error)) return 'not_ready'
    throw new Error(`wa_messages: ${error.message}`)
  }
  if (!data) return null
  const r = data as { id: string; conversation_id: string; direction: string; kind: string; body: string | null; transcript: string | null; media_ref: string | null; mime: string | null; template_name: string | null; status: string; error_code: number | null; error_title: string | null; created_at: string; redacted_at: string | null; legal_hold: boolean }
  const phones = await phonesOf(admin, [r.conversation_id])
  const clean = (t: string | null) => (t == null ? null : waPreview(t, 4000))
  return {
    id: r.id, direction: r.direction, kind: r.kind, body: clean(r.body), transcript: clean(r.transcript), hasMedia: !!r.media_ref, mime: r.mime,
    template: r.template_name, status: r.status, errorCode: r.error_code, errorTitle: r.error_title, phoneMasked: maskWaPhone(phones.get(r.conversation_id)),
    createdAt: r.created_at, redactedAt: r.redacted_at, legalHold: r.legal_hold,
  }
}

// ── templates ────────────────────────────────────────────────────────────────

/** The code registry as (name, language) pairs; tolerant of both registry shapes. */
export function codeTemplates() {
  return waCodeTemplates(WA_TEMPLATES as unknown as Record<string, unknown>)
}

export async function waTemplatesReport(admin: Admin): Promise<{ notReady: boolean; rows: WaTemplateStatusRow[]; lastSyncedAt: string | null; flags: Record<string, number> }> {
  const code = codeTemplates()
  const { data, error } = await admin.from('wa_templates').select('name, language, category, status, rejection_reason, synced_at').order('name').limit(1000)
  if (error) {
    if (notReady('wa_templates (0086)', error)) return { notReady: true, rows: compareWaTemplates(code, []), lastSyncedAt: null, flags: {} }
    throw new Error(`wa_templates: ${error.message}`)
  }
  const db = (data ?? []) as WaTemplateDbRow[]
  const rows = compareWaTemplates(code, db)
  const flags: Record<string, number> = {}
  for (const r of rows) flags[r.flag] = (flags[r.flag] ?? 0) + 1
  const lastSyncedAt = db.map((r) => r.synced_at).filter((s): s is string => !!s).sort().pop() ?? null
  return { notReady: false, rows, lastSyncedAt, flags }
}

export type WaTemplateSyncResult =
  | { configured: false }
  | { configured: true; notReady: true }
  | { configured: true; notReady: false; fetched: number; upserted: number; markedDeleted: number; pages: number; complete: boolean; errors: number; error?: string }

const GRAPH_TIMEOUT_MS = 10_000
const MAX_PAGES = 20

/**
 * Pull Meta's template list (Graph GET /{WHATSAPP_WABA_ID}/message_templates, paginated, each call with a timeout) and
 * upsert wa_templates. After a complete pass, rows Meta no longer lists are marked deleted. Not configured (no WABA id
 * or token) → `{ configured: false }` and nothing is called.
 */
export async function syncWaTemplates(admin: Admin, fetchImpl: typeof fetch = fetchWithTimeout(GRAPH_TIMEOUT_MS), env: Record<string, string | undefined> = process.env): Promise<WaTemplateSyncResult> {
  const waba = (env['WHATSAPP_WABA_ID'] ?? '').trim()
  const token = (env['WHATSAPP_ACCESS_TOKEN'] ?? '').trim()
  if (!/^\d{5,25}$/.test(waba) || !token) return { configured: false }
  const probe = await admin.from('wa_templates').select('name').limit(1)
  if (probe.error) {
    if (notReady('wa_templates (0086)', probe.error)) return { configured: true, notReady: true }
    throw new Error(`wa_templates: ${probe.error.message}`)
  }
  const fields = 'id,name,language,status,category,rejected_reason,quality_score,components'
  let url: string | null = `https://graph.facebook.com/${graphVersion(env)}/${waba}/message_templates?fields=${fields}&limit=100`
  const seen: WaTemplateUpsert[] = []
  let pages = 0
  let error: string | undefined
  while (url && pages < MAX_PAGES) {
    let res: Response
    try {
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } })
    } catch (e) {
      error = `network: ${(e as Error).name}`
      break
    }
    const json = (await res.json().catch(() => ({}))) as { data?: unknown[]; paging?: { next?: unknown }; error?: { code?: number; message?: string } }
    if (!res.ok) {
      error = `graph ${res.status}${json.error?.code ? ` code ${json.error.code}` : ''}: ${String(json.error?.message ?? '').slice(0, 200)}`
      break
    }
    pages++
    for (const t of json.data ?? []) {
      const row = mapGraphTemplate(t)
      if (row) seen.push(row)
    }
    url = safeGraphNext(json.paging?.next)
  }
  const complete = !error && !url
  const now = new Date().toISOString()
  let upserted = 0
  let errors = error ? 1 : 0
  for (let i = 0; i < seen.length; i += 200) {
    const chunk = seen.slice(i, i + 200).map((r) => ({ ...r, synced_at: now }))
    const { error: upErr } = await admin.from('wa_templates').upsert(chunk, { onConflict: 'name,language' })
    if (upErr) { errors++; console.error('[wa-template-sync] upsert', upErr.message) } else upserted += chunk.length
  }
  let markedDeleted = 0
  if (complete) {
    const { data: existing } = await admin.from('wa_templates').select('name, language, status').neq('status', 'deleted').order('name').limit(1000)
    const keys = new Set(seen.map((r) => `${r.name}|${r.language}`))
    for (const r of (existing ?? []) as { name: string; language: string }[]) {
      if (keys.has(`${r.name}|${r.language}`)) continue
      const { error: delErr } = await admin.from('wa_templates').update({ status: 'deleted', synced_at: now }).eq('name', r.name).eq('language', r.language)
      if (delErr) errors++
      else markedDeleted++
    }
  }
  return { configured: true, notReady: false, fetched: seen.length, upserted, markedDeleted, pages, complete, errors, ...(error ? { error } : {}) }
}

// ── spend ────────────────────────────────────────────────────────────────────

export async function waSpendReport(admin: Admin, now = new Date()): Promise<{ notReady: boolean; report: WaSpendReport | null; truncated: boolean; since: string }> {
  const since = new Date(now.getTime() - 30 * DAY).toISOString()
  const { rows, error, truncated } = await fetchPages<Parameters<typeof aggregateWaSpend>[0][number]>(
    (from, to) => admin
      .from('wa_messages')
      .select('created_at, category, pricing_category, cost_millipaise, billable')
      .eq('direction', 'out')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
    50_000,
  )
  if (error) {
    if (notReady('wa_messages cost columns (0086)', error)) return { notReady: true, report: null, truncated: false, since }
    throw new Error(`wa_messages: ${error.message}`)
  }
  return { notReady: false, report: aggregateWaSpend(rows), truncated, since }
}

// ── consents and suppressions ────────────────────────────────────────────────

/** An opaque key for a suppressed phone: the console never holds the number, and the key names exactly one row. */
export function suppressionKey(phone: string): string {
  return createHash('sha256').update(`wa_suppression:${phoneDigits(phone)}`).digest('hex').slice(0, 32)
}

export interface WaConsentsReport {
  notReady: boolean
  counts: Array<{ purpose: string; optedIn: number; optedOut: number }>
  recentOptOuts: Array<{ phoneMasked: string | null; purpose: string; source: string; keyword: string | null; at: string }>
  suppressions: Array<{ key: string; phoneMasked: string | null; reason: string; errorCode: number | null; until: string | null; at: string }>
}

export async function waConsentsReport(admin: Admin): Promise<WaConsentsReport> {
  const countQ = (purpose: string, status: string) => admin.from('wa_phone_consents').select('phone_e164', { count: 'exact', head: true }).eq('purpose', purpose).eq('status', status)
  const counts = await Promise.all(WA_CONSENT_PURPOSES.map(async (purpose) => {
    const [inn, out] = await Promise.all([countQ(purpose, 'opted_in'), countQ(purpose, 'opted_out')])
    return { purpose, optedIn: inn.count ?? 0, optedOut: out.count ?? 0, error: inn.error ?? out.error }
  }))
  const [optOuts, sup] = await Promise.all([
    admin.from('wa_consent_events').select('phone_e164, purpose, source, keyword, created_at').eq('action', 'opt_out').order('created_at', { ascending: false }).limit(50),
    admin.from('wa_suppressions').select('phone_e164, reason, error_code, until, created_at').order('created_at', { ascending: false }).limit(200),
  ])
  const firstErr = counts.find((c) => c.error)?.error ?? optOuts.error ?? sup.error
  if (firstErr) {
    if (notReady('wa consent tables (0086)', firstErr)) return { notReady: true, counts: [], recentOptOuts: [], suppressions: [] }
    throw new Error(`wa consents: ${firstErr.message}`)
  }
  return {
    notReady: false,
    counts: counts.map(({ purpose, optedIn, optedOut }) => ({ purpose, optedIn, optedOut })),
    recentOptOuts: ((optOuts.data ?? []) as { phone_e164: string; purpose: string; source: string; keyword: string | null; created_at: string }[]).map((e) => ({ phoneMasked: maskWaPhone(e.phone_e164), purpose: e.purpose, source: e.source, keyword: e.keyword, at: e.created_at })),
    suppressions: ((sup.data ?? []) as { phone_e164: string; reason: string; error_code: number | null; until: string | null; created_at: string }[]).map((s) => ({ key: suppressionKey(s.phone_e164), phoneMasked: maskWaPhone(s.phone_e164), reason: s.reason, errorCode: s.error_code, until: s.until, at: s.created_at })),
  }
}

/** The suppression row an opaque key names (bounded scan; the table holds delivery failures only). */
export async function findSuppression(admin: Admin, key: string): Promise<{ phone_e164: string; reason: string; error_code: number | null; until: string | null } | null | 'not_ready'> {
  const { rows, error } = await fetchPages<{ phone_e164: string; reason: string; error_code: number | null; until: string | null }>(
    (from, to) => admin.from('wa_suppressions').select('phone_e164, reason, error_code, until').order('phone_e164').range(from, to),
    20_000,
  )
  if (error) {
    if (notReady('wa_suppressions (0086)', error)) return 'not_ready'
    throw new Error(`wa_suppressions: ${error.message}`)
  }
  return rows.find((s) => suppressionKey(s.phone_e164) === key) ?? null
}

// ── unrouted inbound ─────────────────────────────────────────────────────────

/** Free-form replies need the user's 24-hour window with this margin left. */
export const OPS_REPLY_WINDOW_MARGIN_MS = 5 * 60_000

export function windowOpen(windowOpenUntil: string | null | undefined, now = new Date()): boolean {
  return !!windowOpenUntil && new Date(windowOpenUntil).getTime() - OPS_REPLY_WINDOW_MARGIN_MS > now.getTime()
}

export interface WaUnroutedRow {
  id: string
  conversationId: string
  phoneMasked: string | null
  at: string
  kind: string
  preview: string
  windowOpen: boolean
  windowUntil: string | null
  hasAccount: boolean
}

export async function waUnrouted(admin: Admin, now = new Date()): Promise<WaUnroutedRow[]> {
  const since = new Date(now.getTime() - 7 * DAY).toISOString()
  const { data: convs, error } = await admin
    .from('wa_conversations')
    .select('id, phone_e164, window_open_until, last_inbound_at')
    .is('user_id', null)
    .gte('last_inbound_at', since)
    .order('last_inbound_at', { ascending: false })
    .limit(100)
  if (error) throw new Error(`wa_conversations: ${error.message}`)
  const list = (convs ?? []) as { id: string; phone_e164: string; window_open_until: string | null }[]
  if (list.length === 0) return []
  const byId = new Map(list.map((c) => [c.id, c]))
  const forms = list.flatMap((c) => [`+${phoneDigits(c.phone_e164)}`, phoneDigits(c.phone_e164)])
  const [msgs, users] = await Promise.all([
    admin.from('wa_messages').select('id, conversation_id, kind, body, created_at').in('conversation_id', [...byId.keys()]).eq('direction', 'in').gte('created_at', since).order('created_at', { ascending: false }).limit(300),
    admin.from('users').select('phone').in('phone', forms),
  ])
  if (msgs.error) throw new Error(`wa_messages: ${msgs.error.message}`)
  const withAccount = new Set(((users.data ?? []) as { phone: string | null }[]).map((u) => phoneDigits(u.phone)))
  return ((msgs.data ?? []) as { id: string; conversation_id: string; kind: string; body: string | null; created_at: string }[]).map((m) => {
    const c = byId.get(m.conversation_id)!
    return {
      id: m.id,
      conversationId: m.conversation_id,
      phoneMasked: maskWaPhone(c.phone_e164),
      at: m.created_at,
      kind: m.kind,
      preview: waPreview(m.body, 80),
      windowOpen: windowOpen(c.window_open_until, now),
      windowUntil: c.window_open_until,
      hasAccount: withAccount.has(phoneDigits(c.phone_e164)),
    }
  })
}

// ── sending (the ONE send path) ──────────────────────────────────────────────

/** Ops messages go through agent-core `sendWhatsApp` like every other send (consent, suppression, window, ledger row
 *  before the vendor call, idempotency); the driver's fetch carries a timeout. */
export async function sendOpsWhatsApp(admin: Admin, req: WaSendRequest): Promise<WaSendResult> {
  const provider = createWhatsAppProvider(whatsappConfigFromEnv(process.env), fetchWithTimeout(GRAPH_TIMEOUT_MS))
  try {
    return await sendWhatsApp({ db: admin, provider }, req)
  } catch (e) {
    console.error('[wa ops send]', req.kind, (e as Error).message)
    return { outcome: 'failed', error: { code: null, kind: 'unknown', title: (e as Error).message.slice(0, 200), retryable: true } }
  }
}
