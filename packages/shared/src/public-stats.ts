import { z } from 'zod'

/**
 * N9 (PRD Experience v3 E3, decision D1 + the ADR-010 amendment) — the
 * provider's INDIVIDUAL measured stats that buyers may see, each with its
 * sample, above a sample gate. Never the composite AMC Score, its weights or
 * ranks (SCORE_FIELD_NAMES stays out of every buyer payload; these names are
 * the allow-list). Off until `public_stats_enabled` (D1).
 */

/** Stored nightly in provider_public_stats (service role only). */
export interface PublicStatsRow {
  completed_orders: number
  on_time_pct: number | null
  on_time_n: number
  repeat_buyer_pct: number | null
  repeat_n: number
  response_rate_pct: number | null
  response_n: number
  computed_at: string
}

export interface StatValue {
  pct: number
  n: number
}

/** What a buyer payload may carry — exactly these keys (the allow-list). */
export interface PublicStatsView {
  completedOrders: number
  onTime: StatValue | null
  repeatBuyers: StatValue | null
  responseRate: StatValue | null
}

export const PUBLIC_STAT_FIELD_NAMES = ['completedOrders', 'onTime', 'repeatBuyers', 'responseRate', 'pct', 'n'] as const

export const PUBLIC_STATS_MIN_N_FLOOR = 5

/** Gate a stored row for buyers: null when switched off; each stat null below `minN`. */
export function publicStatsView(row: PublicStatsRow | null | undefined, opts: { enabled: boolean; minN: number }): PublicStatsView | null {
  if (!opts.enabled || !row) return null
  const minN = Math.max(PUBLIC_STATS_MIN_N_FLOOR, Math.floor(opts.minN))
  const gate = (pct: number | null, n: number): StatValue | null => (pct == null || !Number.isFinite(pct) || n < minN ? null : { pct: Math.round(Math.min(100, Math.max(0, pct))), n })
  return {
    completedOrders: Math.max(0, Math.floor(row.completed_orders)),
    onTime: gate(row.on_time_pct, row.on_time_n),
    repeatBuyers: gate(row.repeat_buyer_pct, row.repeat_n),
    responseRate: gate(row.response_rate_pct, row.response_n),
  }
}

/** The ONE stat a result card shows (FR-3.1): on-time, else repeat buyers, else none. */
export function headlineStat(view: PublicStatsView | null): { kind: 'on_time' | 'repeat_buyers'; value: StatValue } | null {
  if (!view) return null
  if (view.onTime) return { kind: 'on_time', value: view.onTime }
  if (view.repeatBuyers) return { kind: 'repeat_buyers', value: view.repeatBuyers }
  return null
}

/** Percent with the content rule (§3.7): no decimals unless under 10. */
export function formatStatPct(pct: number): string {
  return pct < 10 && !Number.isInteger(pct) ? pct.toFixed(1) : String(Math.round(pct))
}

/** On-time %: first delivery at or before due_at, over delivered orders (fixture truth: 11 of 12 → 92). */
export function onTimePct(onTime: number, delivered: number): number | null {
  if (delivered <= 0) return null
  return Math.round((onTime / delivered) * 100)
}

// ── Nightly computation (cron/provider-stats) — pure, so the rig and unit tests share it ──

const DAY = 24 * 3600 * 1000

export interface StatsOrderInput {
  id: string
  providerId: string
  msmeId: string
  status: string
  dueAt: string | null
  createdAt: string
  /** First `deliver` event time, if the order was ever delivered. */
  firstDeliveredAt: string | null
}
export interface StatsMatchInput {
  providerId: string
  rfqId: string
  notifiedAt: string | null
  declinedAt: string | null
  declineReason: string | null
  /** The provider's quote on that RFQ, if any. */
  quotedAt: string | null
}

const DONE = new Set(['completed', 'reviewed'])

/**
 * One provider's stored row. Windows (PRD FR-3.3): on-time over deliveries in
 * the last 180 days; repeat buyers over the last 365 days of orders; response
 * rate over matches notified 2–90 days ago (a match younger than the 48 h
 * answer window isn't judged yet).
 */
export function computeProviderPublicStats(providerId: string, orders: StatsOrderInput[], matches: StatsMatchInput[], now: number = Date.now()): PublicStatsRow {
  const mine = orders.filter((o) => o.providerId === providerId)
  const completed = mine.filter((o) => DONE.has(o.status)).length

  const delivered = mine.filter((o) => o.firstDeliveredAt && now - Date.parse(o.firstDeliveredAt) <= 180 * DAY && o.dueAt)
  const onTime = delivered.filter((o) => Date.parse(o.firstDeliveredAt!) <= Date.parse(o.dueAt!)).length

  const yearOrders = mine.filter((o) => now - Date.parse(o.createdAt) <= 365 * DAY)
  const perBuyer = new Map<string, number>()
  for (const o of yearOrders) perBuyer.set(o.msmeId, (perBuyer.get(o.msmeId) ?? 0) + 1)
  const buyers = perBuyer.size
  const repeaters = [...perBuyer.values()].filter((n) => n >= 2).length

  const judged = matches.filter((m) => m.providerId === providerId && m.notifiedAt && now - Date.parse(m.notifiedAt) >= 2 * DAY && now - Date.parse(m.notifiedAt) <= 90 * DAY)
  const within = (at: string | null, from: string) => !!at && Date.parse(at) - Date.parse(from) <= 2 * DAY
  const answered = judged.filter((m) => within(m.quotedAt, m.notifiedAt!) || (within(m.declinedAt, m.notifiedAt!) && !!m.declineReason)).length

  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 100 : null)
  return {
    completed_orders: completed,
    on_time_pct: pct(onTime, delivered.length),
    on_time_n: delivered.length,
    repeat_buyer_pct: pct(repeaters, buyers),
    repeat_n: buyers,
    response_rate_pct: pct(answered, judged.length),
    response_n: judged.length,
    computed_at: new Date(now).toISOString(),
  }
}

// ── N11 activity ──
/** `users.last_seen_at` is written at most once per this window per user. */
export const LAST_SEEN_THROTTLE_MS = 15 * 60 * 1000
/** "Active this week" when the provider was last seen within this many days. */
export const ACTIVE_WITHIN_DAYS = 7

export function shouldTouchLastSeen(lastTouchedAt: number | null | undefined, now: number): boolean {
  return lastTouchedAt == null || now - lastTouchedAt >= LAST_SEEN_THROTTLE_MS
}

export function isActiveThisWeek(lastSeenAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!lastSeenAt) return false
  const t = Date.parse(lastSeenAt)
  return Number.isFinite(t) && now - t <= ACTIVE_WITHIN_DAYS * 86400e3
}

// ── N11 availability ──
export type Availability = { kind: 'paused' } | { kind: 'from'; date: string } | null

/**
 * "Next available start" (FR-3.6): the provider's own date when set and not in
 * the past; else today while active orders are under their capacity; else the
 * earliest due date among active orders. Paused providers aren't taking work.
 * Dates are IST calendar days (YYYY-MM-DD).
 */
export function deriveAvailability(p: {
  capacityPaused: boolean
  nextAvailableOn: string | null
  capacitySlots: number
  activeOrders: number
  earliestDueAt: string | null
  today: string
}): Availability {
  if (p.capacityPaused) return { kind: 'paused' }
  if (p.nextAvailableOn && p.nextAvailableOn >= p.today) return { kind: 'from', date: p.nextAvailableOn }
  if (p.activeOrders < Math.max(1, p.capacitySlots)) return { kind: 'from', date: p.today }
  if (p.earliestDueAt) {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(p.earliestDueAt))
    return { kind: 'from', date: d < p.today ? p.today : d }
  }
  return null
}

// ── Provider-editable trust facts (E3) ──
export const providerAvailabilitySchema = z.object({
  /** YYYY-MM-DD (IST calendar day) or null to clear. */
  nextAvailableOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  capacitySlots: z.number().int().min(1).max(50),
})
export type ProviderAvailabilityInput = z.infer<typeof providerAvailabilitySchema>
export const logoDecisionSchema = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(500).optional() })
