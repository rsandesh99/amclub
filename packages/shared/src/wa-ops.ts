import { z } from 'zod'
import { ORDER_IN_FLIGHT_STATUSES, ORDER_REFUND_OWED_STATUSES, type OrderStatus } from './state-machines'
import { redactChatSecrets, WA_TEMPLATE_CATEGORIES, type WaLocale, type WaTemplateCategory } from './whatsapp'

/**
 * ADR-030 §6 — the WhatsApp ops console (/admin/whatsapp) and privacy operations (/admin/privacy, the wa-retention
 * cron, DPDP requests). Pure helpers only (no I/O), shared by the web routes, the cron and the rigs.
 *
 * Money here is WhatsApp cost: integer millipaise (1/1000 paise, rule 6), formatted to ₹ with two decimals only on the
 * server for display. Meta bills in INR excluding GST; the console says "excl. 18 % GST".
 */

// ── schema readiness ─────────────────────────────────────────────────────────

/** True when a query failed because a table or column is not migrated yet (0086 / 0087 applied after the deploy):
 *  Postgres 42P01 / 42703, PostgREST PGRST205 (table) / PGRST204 (column), or the matching messages. */
export function isSchemaNotReady(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false
  const code = String(error.code ?? '')
  if (['42P01', '42703', 'PGRST205', 'PGRST204'].includes(code)) return true
  return /does not exist|could not find the/i.test(String(error.message ?? ''))
}

// ── cost ─────────────────────────────────────────────────────────────────────

export const MILLIPAISE_PER_PAISE = 1000

/** Integer paise from millipaise, rounded half away from zero (display only; the ledger keeps millipaise). */
export function millipaiseToPaise(m: number): number {
  const n = Math.trunc(Number(m) || 0)
  const sign = n < 0 ? -1 : 1
  const abs = Math.abs(n)
  return sign * (Math.floor(abs / MILLIPAISE_PER_PAISE) + (abs % MILLIPAISE_PER_PAISE >= MILLIPAISE_PER_PAISE / 2 ? 1 : 0))
}

const INR_GROUPING = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

/** "₹1,23,456.78" from millipaise (two decimals, Indian grouping). Server-side display only. */
export function formatMillipaiseINR(m: number | string | null | undefined): string {
  const paise = millipaiseToPaise(Number(m ?? 0))
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  const rupees = Math.floor(abs / 100)
  const rest = String(abs % 100).padStart(2, '0')
  return `${sign}₹${INR_GROUPING.format(rupees)}.${rest}`
}

const IST_OFFSET_MS = 330 * 60_000

/** The IST calendar day (YYYY-MM-DD) of a UTC instant. */
export function istDateKey(at: string | Date): string {
  const t = (typeof at === 'string' ? new Date(at) : at).getTime()
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10)
}

export interface WaSpendInputRow {
  created_at: string
  category?: string | null
  pricing_category?: string | null
  cost_millipaise?: number | string | null
  billable?: boolean | null
}
export interface WaSpendTotals {
  messages: number
  billable: number
  costMillipaise: number
  /** Formatted on the server: "₹12.35". */
  cost: string
}
export interface WaSpendCell extends WaSpendTotals {
  day: string
  category: string
}
export interface WaSpendReport {
  days: WaSpendCell[]
  byCategory: Array<WaSpendTotals & { category: string }>
  total: WaSpendTotals
}

/** Meta's pricing category when the webhook has reported one, else the category we sent under, else 'unknown'. */
export function waSpendCategory(r: WaSpendInputRow): string {
  return String(r.pricing_category || r.category || 'unknown').toLowerCase()
}

const totals = (messages: number, billable: number, costMillipaise: number): WaSpendTotals => ({ messages, billable, costMillipaise, cost: formatMillipaiseINR(costMillipaise) })

/** Per IST day × category, per category and in total. Days newest first; categories by name. */
export function aggregateWaSpend(rows: readonly WaSpendInputRow[]): WaSpendReport {
  const cells = new Map<string, { day: string; category: string; messages: number; billable: number; cost: number }>()
  const cats = new Map<string, { messages: number; billable: number; cost: number }>()
  let m = 0, b = 0, c = 0
  for (const r of rows) {
    const day = istDateKey(r.created_at)
    const category = waSpendCategory(r)
    const cost = Math.trunc(Number(r.cost_millipaise ?? 0) || 0)
    const bill = r.billable === true ? 1 : 0
    const key = `${day}|${category}`
    const cell = cells.get(key) ?? { day, category, messages: 0, billable: 0, cost: 0 }
    cell.messages++; cell.billable += bill; cell.cost += cost
    cells.set(key, cell)
    const cat = cats.get(category) ?? { messages: 0, billable: 0, cost: 0 }
    cat.messages++; cat.billable += bill; cat.cost += cost
    cats.set(category, cat)
    m++; b += bill; c += cost
  }
  const days = [...cells.values()]
    .sort((x, y) => y.day.localeCompare(x.day) || x.category.localeCompare(y.category))
    .map((x) => ({ day: x.day, category: x.category, ...totals(x.messages, x.billable, x.cost) }))
  const byCategory = [...cats.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([category, x]) => ({ category, ...totals(x.messages, x.billable, x.cost) }))
  return { days, byCategory, total: totals(m, b, c) }
}

// ── retention (D-WA5) ────────────────────────────────────────────────────────

export interface WaRetentionSettings {
  /** Text, transcripts and payloads of wa_messages. */
  textDays: number
  /** Media objects in the wa-media bucket. */
  mediaDays: number
  /** Conversations of numbers that never bound to an account (deleted whole). */
  unknownDays: number
}
export const WA_RETENTION_DEFAULTS: WaRetentionSettings = { textDays: 180, mediaDays: 90, unknownDays: 30 }

export interface WaRetentionCutoffs { text: string; media: string; unknown: string }
export function waRetentionCutoffs(now: Date, s: WaRetentionSettings): WaRetentionCutoffs {
  const at = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()
  return { text: at(s.textDays), media: at(s.mediaDays), unknown: at(s.unknownDays) }
}

/**
 * Orders that put a user's WhatsApp messages on hold (their chat may be evidence): work in flight, a refund still
 * owed, and an open dispute. An open support ticket and an explicit `legal_hold` hold them too.
 */
export const WA_HOLD_ORDER_STATUSES: readonly OrderStatus[] = [...ORDER_IN_FLIGHT_STATUSES, ...ORDER_REFUND_OWED_STATUSES, 'disputed' satisfies OrderStatus]

export interface WaRetentionCandidate {
  createdAt: string
  legalHold: boolean
  redactedAt: string | null
  mediaRef: string | null
  /** The conversation's (or message's) user has an open ticket, open dispute or an order not yet done. */
  userHeld: boolean
}
export type WaRetentionAction = 'keep' | 'remove_media' | 'redact'

/** What the retention job does to one message: redact text (and media) after the text period, remove media alone after
 *  the media period; nothing on legal hold, already redacted, or of a held user. */
export function waRetentionAction(c: WaRetentionCandidate, cutoffs: WaRetentionCutoffs): WaRetentionAction {
  if (c.redactedAt || c.legalHold || c.userHeld) return 'keep'
  const t = new Date(c.createdAt).getTime()
  if (t < new Date(cutoffs.text).getTime()) return 'redact'
  if (c.mediaRef && t < new Date(cutoffs.media).getTime()) return 'remove_media'
  return 'keep'
}

/** A media_ref is a wa-media storage path once the job downloaded it (`<conversation>/<vendor id>.<ext>`); a vendor
 *  media id or a URL is not a stored object. */
export function waStoredMediaPath(ref: string | null | undefined): string | null {
  const s = String(ref ?? '')
  if (!s || /^https?:/i.test(s) || !s.includes('/') || s.includes('..') || s.startsWith('/')) return null
  return s.length <= 512 ? s : null
}

const KEEP_PAYLOAD_KEYS = new Set(['id', 'type', 'kind', 'status', 'timestamp'])

/** A redacted row keeps ids, kind, status and timestamps only: every text, media reference, phone and name goes. */
export function reduceWaPayload(payload: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { redacted: true }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    const primitive = (typeof v === 'string' && v.length <= 200) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean'
    if (!primitive) continue
    if (KEEP_PAYLOAD_KEYS.has(k) || /(^|_)id$/.test(k) || /_at$/.test(k)) out[k] = v
  }
  const ctx = (payload as { context?: { id?: unknown } }).context
  if (ctx && typeof ctx === 'object' && typeof ctx.id === 'string' && ctx.id.length <= 200) out['context_id'] = ctx.id
  return out
}

/** A one-line preview for ops lists: secrets removed, whitespace collapsed, at most `max` characters. */
export function waPreview(text: string | null | undefined, max = 80): string {
  const clean = redactChatSecrets(text).text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, Math.max(1, max - 1))}…` : clean
}

// ── the corpus rule (Meta Business Solution Terms) ───────────────────────────

/** Surfaces a turn / request can come from. */
export type SourceChannel = 'web' | 'mobile' | 'whatsapp'

/** WhatsApp content never enters our corpus or eval sets — neither the text nor anything derived from it. A write is
 *  allowed only when neither the voice metadata nor the delegated run says WhatsApp. */
export function corpusSourceAllowed(src: { voiceChannel?: string | null | undefined; runSurface?: string | null | undefined }): boolean {
  return src.voiceChannel !== 'whatsapp' && src.runSurface !== 'whatsapp'
}

// ── templates: the code registry vs Meta ─────────────────────────────────────

/** Meta language code per template locale (as the driver sends it). */
export const WA_META_LANGUAGE: Record<WaLocale, string> = { en: 'en', hi: 'hi', te: 'te', ta: 'ta' }

export const WA_TEMPLATE_STATUSES = ['unknown', 'pending', 'approved', 'rejected', 'paused', 'disabled', 'in_appeal', 'deleted'] as const
export type WaTemplateStatus = (typeof WA_TEMPLATE_STATUSES)[number]

export interface WaCodeTemplate {
  kind: string
  name: string
  language: string
  category: WaTemplateCategory | null
}

const LOCALES: readonly WaLocale[] = ['en', 'hi', 'te', 'ta']

/**
 * Every (name, language) the code registry can send. Tolerates both registry shapes: the per-locale `names` map and the
 * `WaTemplateSpec` (stem + locales → `${stem}_${locale}`), so the console works on either side of the registry change.
 */
export function waCodeTemplates(registry: Record<string, unknown>): WaCodeTemplate[] {
  const out: WaCodeTemplate[] = []
  const seen = new Set<string>()
  const push = (kind: string, name: unknown, locale: WaLocale, category: unknown) => {
    if (typeof name !== 'string' || !name) return
    const language = WA_META_LANGUAGE[locale]
    const key = `${name}|${language}`
    if (seen.has(key)) return
    seen.add(key)
    const cat = (WA_TEMPLATE_CATEGORIES as readonly string[]).includes(String(category)) ? (category as WaTemplateCategory) : null
    out.push({ kind, name, language, category: cat })
  }
  for (const [kind, raw] of Object.entries(registry)) {
    if (!raw || typeof raw !== 'object') continue
    const spec = raw as { names?: Record<string, unknown>; stem?: unknown; locales?: unknown; category?: unknown }
    if (typeof spec.stem === 'string' && Array.isArray(spec.locales)) {
      for (const l of spec.locales) if ((LOCALES as readonly unknown[]).includes(l)) push(kind, `${spec.stem}_${String(l)}`, l as WaLocale, spec.category)
    } else if (spec.names && typeof spec.names === 'object') {
      for (const l of LOCALES) push(kind, spec.names[l], l, spec.category)
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language))
}

export interface WaTemplateDbRow {
  name: string
  language: string
  category: string | null
  status: string
  rejection_reason: string | null
  synced_at: string | null
}
export type WaTemplateFlag = 'ok' | 'in_code_not_approved' | 'approved_not_in_code' | 'not_in_code'
export interface WaTemplateStatusRow {
  name: string
  language: string
  category: string | null
  status: string
  rejectionReason: string | null
  syncedAt: string | null
  /** Registry kinds that send this template (empty when not in code). */
  kinds: string[]
  flag: WaTemplateFlag
}

/** The Templates tab: each code template next to Meta's row, plus Meta rows the code never sends. */
export function compareWaTemplates(code: readonly WaCodeTemplate[], db: readonly WaTemplateDbRow[]): WaTemplateStatusRow[] {
  const byKey = new Map(db.map((r) => [`${r.name}|${r.language}`, r]))
  const kinds = new Map<string, string[]>()
  for (const c of code) kinds.set(`${c.name}|${c.language}`, [...(kinds.get(`${c.name}|${c.language}`) ?? []), c.kind])
  const rows: WaTemplateStatusRow[] = []
  for (const [key, ks] of kinds) {
    const c = code.find((x) => `${x.name}|${x.language}` === key)!
    const r = byKey.get(key)
    rows.push({
      name: c.name,
      language: c.language,
      category: r?.category ?? c.category,
      status: r?.status ?? 'unknown',
      rejectionReason: r?.rejection_reason ?? null,
      syncedAt: r?.synced_at ?? null,
      kinds: ks,
      flag: r?.status === 'approved' ? 'ok' : 'in_code_not_approved',
    })
  }
  for (const r of db) {
    if (kinds.has(`${r.name}|${r.language}`)) continue
    rows.push({ name: r.name, language: r.language, category: r.category, status: r.status, rejectionReason: r.rejection_reason, syncedAt: r.synced_at, kinds: [], flag: r.status === 'approved' ? 'approved_not_in_code' : 'not_in_code' })
  }
  const order: Record<WaTemplateFlag, number> = { in_code_not_approved: 0, approved_not_in_code: 1, ok: 2, not_in_code: 3 }
  return rows.sort((a, b) => order[a.flag] - order[b.flag] || a.name.localeCompare(b.name) || a.language.localeCompare(b.language))
}

const META_STATUS: Record<string, WaTemplateStatus> = {
  APPROVED: 'approved', PENDING: 'pending', IN_REVIEW: 'pending', REJECTED: 'rejected', PAUSED: 'paused',
  DISABLED: 'disabled', IN_APPEAL: 'in_appeal', PENDING_DELETION: 'deleted', DELETED: 'deleted', ARCHIVED: 'deleted',
}

export interface WaTemplateUpsert {
  name: string
  language: string
  category: WaTemplateCategory | null
  status: WaTemplateStatus
  rejection_reason: string | null
  meta_template_id: string | null
  components: unknown
  quality: string | null
}

/** One element of Graph `GET /{waba}/message_templates` → a wa_templates row (null when it has no name / language). */
export function mapGraphTemplate(t: unknown): WaTemplateUpsert | null {
  if (!t || typeof t !== 'object') return null
  const o = t as Record<string, unknown>
  const name = typeof o['name'] === 'string' ? o['name'].slice(0, 512) : ''
  const language = typeof o['language'] === 'string' ? o['language'].slice(0, 20) : ''
  if (!name || !language) return null
  const cat = String(o['category'] ?? '').toLowerCase()
  const reason = typeof o['rejected_reason'] === 'string' && o['rejected_reason'] !== 'NONE' ? o['rejected_reason'].slice(0, 500) : null
  const q = o['quality_score']
  const quality = q && typeof q === 'object' && typeof (q as { score?: unknown }).score === 'string' ? String((q as { score: string }).score).toLowerCase().slice(0, 20) : null
  return {
    name,
    language,
    category: (WA_TEMPLATE_CATEGORIES as readonly string[]).includes(cat) ? (cat as WaTemplateCategory) : null,
    status: META_STATUS[String(o['status'] ?? '').toUpperCase()] ?? 'unknown',
    rejection_reason: reason,
    meta_template_id: typeof o['id'] === 'string' ? o['id'].slice(0, 64) : null,
    components: Array.isArray(o['components']) ? o['components'] : null,
    quality,
  }
}

/** A Graph `paging.next` link is followed only when it stays on graph.facebook.com (no open redirect / SSRF). */
export function safeGraphNext(next: unknown): string | null {
  if (typeof next !== 'string') return null
  try {
    const u = new URL(next)
    return u.protocol === 'https:' && u.hostname === 'graph.facebook.com' ? u.toString() : null
  } catch {
    return null
  }
}

/** Phone quality and messaging tier from the latest stored account webhooks (payload as received: the change value,
 *  or the whole change with a `value`). */
export function waAccountHealth(events: ReadonlyArray<{ field: string; payload: unknown; created_at: string }>): {
  quality: string | null
  tier: string | null
  event: string | null
  at: string | null
} {
  const val = (p: unknown): Record<string, unknown> => {
    const o = p && typeof p === 'object' ? (p as Record<string, unknown>) : {}
    const v = o['value']
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : o
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 60) : null)
  const sorted = [...events].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const q = sorted.find((e) => e.field === 'phone_number_quality_update')
  const a = sorted.find((e) => e.field === 'account_update')
  const qv = q ? val(q.payload) : {}
  const av = a ? val(a.payload) : {}
  return {
    quality: str(qv['quality_rating']) ?? str(qv['current_quality']) ?? str(qv['event']),
    tier: str(qv['current_limit']) ?? str(qv['messaging_limit_tier']) ?? str(av['messaging_limit_tier']),
    event: str(av['event']) ?? str(qv['event']),
    at: (q ?? a)?.created_at ?? null,
  }
}

// ── ops input ────────────────────────────────────────────────────────────────

/** An ops reply (the unrouted inbox, the support ticket view). `clickId` makes one click one message. */
export const waOpsReplySchema = z.object({
  text: z.string().trim().min(1).max(1000),
  clickId: z.string().uuid(),
}).strict()
export type WaOpsReply = z.infer<typeof waOpsReplySchema>

// ── DPDP requests (0087 dpdp_requests) ───────────────────────────────────────

export const DPDP_REQUEST_KINDS = ['access', 'correction', 'erasure', 'withdrawal', 'grievance', 'nomination'] as const
export type DpdpRequestKind = (typeof DPDP_REQUEST_KINDS)[number]
export const DPDP_REQUEST_SOURCES = ['web', 'mobile', 'whatsapp', 'email', 'admin'] as const
export type DpdpRequestSource = (typeof DPDP_REQUEST_SOURCES)[number]
export const DPDP_REQUEST_STATUSES = ['open', 'in_progress', 'done', 'rejected'] as const
export type DpdpRequestStatus = (typeof DPDP_REQUEST_STATUSES)[number]

/** The one transition map for a DPDP request; done and rejected are final. */
export const DPDP_REQUEST_TRANSITIONS: Record<DpdpRequestStatus, readonly DpdpRequestStatus[]> = {
  open: ['in_progress', 'done', 'rejected'],
  in_progress: ['done', 'rejected'],
  done: [],
  rejected: [],
}
export function canTransitionDpdpRequest(from: DpdpRequestStatus, to: DpdpRequestStatus): boolean {
  return DPDP_REQUEST_TRANSITIONS[from]?.includes(to) ?? false
}
export const DPDP_OPEN_STATUSES: readonly DpdpRequestStatus[] = ['open', 'in_progress']

/** DPDP Rules: a request is answered within the period ops set (`dpdp_due_days`, default 30). */
export const DPDP_DUE_DAYS_DEFAULT = 30
export function dpdpDueAt(createdAt: Date, dueDays: number): string {
  return new Date(createdAt.getTime() + dueDays * 86_400_000).toISOString()
}
export function dpdpOverdue(row: { status: string; due_at: string }, now: Date): boolean {
  return (DPDP_OPEN_STATUSES as readonly string[]).includes(row.status) && new Date(row.due_at).getTime() < now.getTime()
}

/** The queue: open work first (earliest due first), then closed requests (latest first). */
export function sortDpdpQueue<T extends { status: string; due_at: string; created_at: string; resolved_at?: string | null }>(rows: readonly T[]): T[] {
  const open = (r: T) => (DPDP_OPEN_STATUSES as readonly string[]).includes(r.status)
  return [...rows].sort((a, b) => {
    if (open(a) !== open(b)) return open(a) ? -1 : 1
    if (open(a)) return a.due_at.localeCompare(b.due_at)
    return (b.resolved_at ?? b.created_at).localeCompare(a.resolved_at ?? a.created_at)
  })
}

/** PATCH /api/v1/admin/privacy/requests/[id]. A final answer carries the resolution the user reads. */
export const dpdpActionSchema = z
  .object({
    action: z.enum(['in_progress', 'done', 'rejected']),
    resolution: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((d) => d.action === 'in_progress' || (d.resolution ?? '').length >= 10, { message: 'resolution_required', path: ['resolution'] })
export type DpdpAction = z.infer<typeof dpdpActionSchema>

/** POST /api/v1/admin/privacy/requests — a request received outside the product (email, letter, phone). */
export const dpdpCreateSchema = z
  .object({
    /** The account's id, email or phone. */
    identifier: z.string().trim().min(3).max(200),
    kind: z.enum(DPDP_REQUEST_KINDS),
    source: z.enum(['email', 'admin']),
    details: z.string().trim().max(2000).optional(),
  })
  .strict()
export type DpdpCreate = z.infer<typeof dpdpCreateSchema>
