/**
 * AMC Mart — group-buy pool state machine (MART_DESIGN.md §4.4). Built in M0
 * as pure code so M1 (tables + agent + payments) lands on a tested machine.
 * Exhaustive transitions; illegal transitions THROW; every transition emits
 * a pool_events row (the API does the emitting, this file names the vocabulary).
 */

export const POOL_STATUSES = ['open', 'closed_met', 'closed_unmet', 'ordered', 'fulfilled', 'cancelled'] as const
export type PoolStatus = (typeof POOL_STATUSES)[number]

export const POOL_TRANSITIONS: Record<PoolStatus, readonly PoolStatus[]> = {
  open: ['closed_met', 'closed_unmet', 'cancelled'],
  closed_met: ['ordered', 'cancelled'],
  closed_unmet: [],
  ordered: ['fulfilled'],
  fulfilled: [],
  cancelled: [],
}

export class PoolTransitionError extends Error {
  constructor(
    public readonly from: PoolStatus,
    public readonly to: PoolStatus,
  ) {
    super(`Illegal pool transition ${from} → ${to}`)
    this.name = 'PoolTransitionError'
  }
}

export function isValidPoolTransition(from: PoolStatus, to: PoolStatus): boolean {
  return (POOL_TRANSITIONS[from] as readonly string[]).includes(to)
}

/** Throws PoolTransitionError on an illegal move; returns `to` otherwise. */
export function assertPoolTransition(from: PoolStatus, to: PoolStatus): PoolStatus {
  if (!isValidPoolTransition(from, to)) throw new PoolTransitionError(from, to)
  return to
}

/** pool_members.payment_state — UPI block-and-capture lifecycle (§4.4). */
export const POOL_MEMBER_PAYMENT_STATES = ['blocked', 'captured', 'released', 'failed'] as const
export type PoolMemberPaymentState = (typeof POOL_MEMBER_PAYMENT_STATES)[number]

export const POOL_MEMBER_PAYMENT_TRANSITIONS: Record<PoolMemberPaymentState, readonly PoolMemberPaymentState[]> = {
  blocked: ['captured', 'released', 'failed'],
  captured: [],
  released: [],
  // A failed capture may be retried (re-block) — never silently captured.
  failed: ['blocked'],
}

export function isValidPoolMemberPaymentTransition(from: PoolMemberPaymentState, to: PoolMemberPaymentState): boolean {
  return (POOL_MEMBER_PAYMENT_TRANSITIONS[from] as readonly string[]).includes(to)
}

/**
 * The one money rule of pools, as a pure predicate: blocked funds may be
 * captured ONLY when the pool closed met. Killtested in M1 ("blocked funds
 * NEVER captured on unmet pools").
 */
export function mayCapturePoolMember(pool: PoolStatus, member: PoolMemberPaymentState): boolean {
  return pool === 'closed_met' && member === 'blocked'
}

/** Decide the close outcome from committed quantity vs the minimum. */
export function poolCloseOutcome(committedQty: number, minQty: number): Extract<PoolStatus, 'closed_met' | 'closed_unmet'> {
  return committedQty >= minQty ? 'closed_met' : 'closed_unmet'
}

/** pool_events.event_type vocabulary. */
export const POOL_EVENT_TYPES = [
  'created',
  'opened',
  'joined',
  'left',
  'closed_met',
  'closed_unmet',
  'ordered',
  'fulfilled',
  'cancelled',
  'capture_attempted',
  'captured',
  'capture_failed',
  'released',
] as const
export type PoolEventType = (typeof POOL_EVENT_TYPES)[number]

// ── M1: schemas, math, copy ──────────────────────────────────────────────────
//
// Payment mechanic (ADR-006, docs/mart/PSP_BLOCK_CAPTURE_REPORT.md): the
// launch mechanic is PAY-ON-CLOSE — a member's commitment records qty and
// delivery details, no money moves; when the pool closes met each member
// pays a normal goods order (existing checkout + webhook + payout.ts) within
// `pool_pay_window_hours`. `payment_state` keeps the §4.4 vocabulary so a
// block-and-capture adapter drops in without a schema change:
//   blocked   = commitment recorded (block_capture: funds blocked in the
//               buyer's own account)
//   captured  = member order paid (block_capture: mandate executed)
//   released  = commitment void — pool unmet/cancelled or member left
//   failed    = member did not pay inside the window (block_capture: capture
//               failed) → a DEFAULT for the discipline rating; re-block allowed.

import { z } from 'zod'

export const POOL_PAYMENT_MODES = ['pay_on_close', 'block_capture'] as const
export type PoolPaymentMode = (typeof POOL_PAYMENT_MODES)[number]

/** Launch defaults — edited in mart_settings, never here (config, not constants). */
export const POOL_DEFAULTS = {
  pay_window_hours: 48,
  min_open_hours: 24,
  max_open_days: 30,
  max_qty_per_member: 100_000,
} as const

/** Pool row as the API and clients see it. */
export const poolSummarySchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid().nullable(),
  category_slug: z.string(),
  spec: z.record(z.string(), z.unknown()).nullable(),
  title: z.string(),
  unit: z.string(),
  target_qty: z.number().int().positive(),
  min_qty: z.number().int().positive(),
  unit_price_paise: z.number().int().positive(),
  /** The listing's single-unit price the pool is discounted from (display only). */
  list_price_paise: z.number().int().positive().nullable(),
  closes_at: z.string(),
  status: z.enum(POOL_STATUSES),
  seller_id: z.string().uuid().nullable(),
  committed_qty: z.number().int().nonnegative(),
  member_count: z.number().int().nonnegative(),
})
export type PoolSummary = z.infer<typeof poolSummarySchema>

/** Group-Buy Agent draft → founder approves → open. Prices in paise. */
export const poolDraftSchema = z.object({
  product_id: z.string().uuid().nullable(),
  category_slug: z.string().min(1).max(60),
  title: z.string().trim().min(3).max(140),
  spec: z.record(z.string(), z.unknown()).nullable().default(null),
  unit: z.string().min(1).max(10),
  target_qty: z.number().int().positive().max(10_000_000),
  min_qty: z.number().int().positive().max(10_000_000),
  unit_price_paise: z.number().int().positive(),
  closes_at: z.string().datetime({ offset: true }),
  /** Why the agent proposed it — demand signal refs, schedule tag. Refs only. */
  rationale: z.record(z.string(), z.unknown()).default({}),
}).refine((p) => p.min_qty <= p.target_qty, { message: 'min_qty must not exceed target_qty', path: ['min_qty'] })
export type PoolDraft = z.infer<typeof poolDraftSchema>

/** Founder edits before opening — every field of the draft may be corrected. */
export const poolOpenSchema = z.object({
  title: z.string().trim().min(3).max(140).optional(),
  target_qty: z.number().int().positive().max(10_000_000).optional(),
  min_qty: z.number().int().positive().max(10_000_000).optional(),
  unit_price_paise: z.number().int().positive().optional(),
  closes_at: z.string().datetime({ offset: true }).optional(),
})
export type PoolOpenInput = z.infer<typeof poolOpenSchema>

/** Buyer joins: quantity + the delivery snapshot the eventual goods order needs. */
export const poolJoinSchema = z.object({
  qty: z.number().int().positive().max(POOL_DEFAULTS.max_qty_per_member),
  delivery: z.object({
    contact_name: z.string().trim().min(2).max(100),
    contact_phone: z.string().regex(/^(?:\+91)?[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
    address: z.string().trim().min(5).max(300),
    city: z.string().trim().min(2).max(80),
    state: z.string().min(2).max(4),
    pincode: z.string().regex(/^\d{6}$/),
    pickup: z.boolean().default(false),
  }),
  gstInvoice: z
    .object({ gstin: z.string().optional(), businessName: z.string().optional(), address: z.string().optional() })
    .optional(),
})
export type PoolJoinInput = z.infer<typeof poolJoinSchema>

export const POOL_ADMIN_ACTIONS = ['approve', 'cancel', 'close', 'award', 'fulfil'] as const
export type PoolAdminAction = (typeof POOL_ADMIN_ACTIONS)[number]

/** Progress for the molten-fill bar: 0–100 against target, plus the "met" line. */
export function poolProgress(committedQty: number, minQty: number, targetQty: number): {
  pct: number
  metPct: number
  met: boolean
  remainingToMin: number
} {
  const pct = targetQty > 0 ? Math.min(100, Math.round((committedQty / targetQty) * 100)) : 0
  const metPct = targetQty > 0 ? Math.min(100, Math.round((minQty / targetQty) * 100)) : 100
  return { pct, metPct, met: committedQty >= minQty, remainingToMin: Math.max(0, minQty - committedQty) }
}

/** Saving per unit vs the listing's single-unit price, in paise and percent. */
export function poolSaving(unitPricePaise: number, listPricePaise: number | null): { paise: number; pct: number } {
  if (!listPricePaise || listPricePaise <= unitPricePaise) return { paise: 0, pct: 0 }
  const paise = listPricePaise - unitPricePaise
  return { paise, pct: Math.round((paise / listPricePaise) * 100) }
}

/** An open pool whose closes_at has passed is due to close; the outcome is by committed qty. */
export function poolIsDueToClose(status: PoolStatus, closesAt: string | Date, now: Date = new Date()): boolean {
  return status === 'open' && new Date(closesAt).getTime() <= now.getTime()
}

/** Pay-on-close deadline for a member once the pool closed met. */
export function poolPayDeadline(closedAt: string | Date, payWindowHours: number): Date {
  return new Date(new Date(closedAt).getTime() + payWindowHours * 3_600_000)
}

/**
 * Whether a member may still leave: only while the pool is open. After close
 * a commitment is binding (that is the whole point of a pool); a member who
 * does not pay is recorded as a default, never silently released.
 */
export function poolMemberMayLeave(pool: PoolStatus, member: PoolMemberPaymentState): boolean {
  return pool === 'open' && member === 'blocked'
}

/**
 * Validation for opening a pool (agent draft or founder edit): min ≤ target,
 * closes_at inside [min_open_hours, max_open_days] from now, price below the
 * listing price when one is known. Returns the first problem or null.
 */
export function poolOpenProblem(
  p: { min_qty: number; target_qty: number; unit_price_paise: number; closes_at: string; list_price_paise: number | null; product_id: string | null },
  now: Date = new Date(),
  limits: { minOpenHours: number; maxOpenDays: number } = { minOpenHours: POOL_DEFAULTS.min_open_hours, maxOpenDays: POOL_DEFAULTS.max_open_days },
): string | null {
  if (!p.product_id) return 'product_required'
  if (p.min_qty > p.target_qty) return 'min_exceeds_target'
  const closes = new Date(p.closes_at).getTime()
  if (Number.isNaN(closes)) return 'closes_at_invalid'
  if (closes < now.getTime() + limits.minOpenHours * 3_600_000) return 'closes_too_soon'
  if (closes > now.getTime() + limits.maxOpenDays * 86_400_000) return 'closes_too_late'
  if (p.list_price_paise !== null && p.unit_price_paise >= p.list_price_paise) return 'price_not_below_list'
  return null
}

// ── Buyer pool-commitment discipline (§4.5) ─────────────────────────────────

export interface PoolDisciplineInputs {
  /** Pools the buyer committed to that closed met (their payment was due). */
  due: number
  /** …of which paid inside the window. */
  honoured: number
  /** …of which lapsed (payment_state 'failed'). */
  defaulted: number
}

/**
 * Discipline factor for the buyer rating: 1.0 with no history (no penalty for
 * being new), otherwise honoured / due. Sample gate: below `minSample` the
 * factor is neutral and `public` is false (same ≥3/≥5 gates as the provider
 * score inputs). Factors are public, the blended formula is not (§4.5).
 */
export function poolDisciplineFactor(inp: PoolDisciplineInputs, minSample = 3): { factor: number; sample: number; public: boolean } {
  const sample = inp.due
  if (sample < minSample) return { factor: 1, sample, public: false }
  const factor = Math.max(0, Math.min(1, inp.honoured / sample))
  return { factor: Math.round(factor * 100) / 100, sample, public: sample >= 5 }
}

// ── WhatsApp pool card copy (the flagship forwardable artifact) ────────────

export type PoolCardLocale = 'en' | 'hi' | 'te'

export interface PoolCardInput {
  title: string
  unit: string
  unitPricePaise: number
  listPricePaise: number | null
  committedQty: number
  minQty: number
  targetQty: number
  memberCount: number
  closesAt: string | Date
  url: string
  sellerName?: string | null
}

function inr(paise: number): string {
  const rupees = paise / 100
  const s = Number.isInteger(rupees) ? rupees.toLocaleString('en-IN') : rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `₹${s}`
}

function istDate(d: string | Date): string {
  return new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

/**
 * Plain-text card for wa.me share links and the WhatsApp channel. Template-
 * built (deterministic, works without any model key); the Group-Buy Agent
 * may propose a friendlier vernacular line, which the founder confirms into
 * ai_decisions — the numbers below always come from the pool row, never from
 * a model.
 */
export function buildPoolCardText(inp: PoolCardInput, locale: PoolCardLocale = 'en'): string {
  const saving = poolSaving(inp.unitPricePaise, inp.listPricePaise)
  const { remainingToMin, met } = poolProgress(inp.committedQty, inp.minQty, inp.targetQty)
  const price = `${inr(inp.unitPricePaise)}/${inp.unit}`
  const list = inp.listPricePaise ? inr(inp.listPricePaise) : null
  const when = istDate(inp.closesAt)
  const seller = inp.sellerName ? ` · ${inp.sellerName}` : ''
  if (locale === 'hi') {
    return [
      `🟢 AMC Mart ग्रुप बाय: ${inp.title}${seller}`,
      `${price}${list ? ` (सूची ${list}, ${saving.pct}% बचत)` : ''}`,
      `${inp.memberCount} सदस्य · ${inp.committedQty}/${inp.targetQty} ${inp.unit} जुड़ चुके`,
      met ? '✅ न्यूनतम पूरा — पूल तय है' : `⏳ न्यूनतम के लिए ${remainingToMin} ${inp.unit} और चाहिए`,
      `बंद होगा: ${when} IST`,
      `जुड़ें: ${inp.url}`,
    ].join('\n')
  }
  if (locale === 'te') {
    return [
      `🟢 AMC Mart గ్రూప్ కొనుగోలు: ${inp.title}${seller}`,
      `${price}${list ? ` (లిస్ట్ ${list}, ${saving.pct}% ఆదా)` : ''}`,
      `${inp.memberCount} సభ్యులు · ${inp.committedQty}/${inp.targetQty} ${inp.unit} చేరారు`,
      met ? '✅ కనీస పరిమాణం చేరింది — పూల్ ఖాయం' : `⏳ కనీసానికి ఇంకా ${remainingToMin} ${inp.unit} కావాలి`,
      `ముగింపు: ${when} IST`,
      `చేరండి: ${inp.url}`,
    ].join('\n')
  }
  return [
    `🟢 AMC Mart group buy: ${inp.title}${seller}`,
    `${price}${list ? ` (list ${list}, save ${saving.pct}%)` : ''}`,
    `${inp.memberCount} members · ${inp.committedQty}/${inp.targetQty} ${inp.unit} committed`,
    met ? '✅ Minimum reached — this pool is on' : `⏳ ${remainingToMin} ${inp.unit} more to reach the minimum`,
    `Closes ${when} IST`,
    `Join: ${inp.url}`,
  ].join('\n')
}
