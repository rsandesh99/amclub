/**
 * E16 N44 — the buyer's reorder library (/app/mart/reorder) and the opt-in
 * reminder at their usual interval. Pure rules: the server groups past goods
 * lines and prices them at today's listing; clients render.
 */
export const REORDER_MIN_DAYS = 7
export const REORDER_MAX_DAYS = 365
export const REORDER_DEFAULT_DAYS = 30

const DAY = 86_400_000

/**
 * The buyer's usual interval for one product: the median gap (days) between
 * their consecutive orders of it, clamped to 7..365. One order (or orders on
 * the same day) → the 30-day default.
 */
export function usualReorderIntervalDays(orderedAt: readonly string[]): number {
  const days = [...new Set(orderedAt.map((d) => Math.floor(Date.parse(d) / DAY)))].sort((a, b) => a - b)
  if (days.length < 2) return REORDER_DEFAULT_DAYS
  const gaps = days.slice(1).map((d, i) => d - days[i]!).sort((a, b) => a - b)
  const mid = Math.floor(gaps.length / 2)
  const median = gaps.length % 2 ? gaps[mid]! : Math.round((gaps[mid - 1]! + gaps[mid]!) / 2)
  return Math.min(REORDER_MAX_DAYS, Math.max(REORDER_MIN_DAYS, median))
}

/** When the reminder fires: the usual interval after the last order, or tomorrow when that has already passed. */
export function nextReorderReminderAt(lastOrderedAt: string, intervalDays: number, now: Date): string {
  const due = Date.parse(lastOrderedAt) + intervalDays * DAY
  return new Date(due > now.getTime() ? due : now.getTime() + DAY).toISOString()
}

export interface PastGoodsLine {
  productId: string
  name: string
  unit: string
  lastQty: number
  /** The unit price paid last time (the frozen snapshot), paise, and its GST rate. */
  lastUnitPricePaise: number
  gstRateBps: number
  lastOrderedAt: string
  orderedAt: string[]
}

/**
 * Past goods lines grouped by listing, newest first. Samples and listing-less
 * (quoted) lines are left out — they are not "the usual".
 */
export function groupPastGoodsLines(orders: readonly { created_at: string; line_items: unknown }[]): PastGoodsLine[] {
  const by = new Map<string, PastGoodsLine>()
  const sorted = [...orders].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  for (const o of sorted) {
    for (const l of (Array.isArray(o.line_items) ? o.line_items : []) as { product_id?: string | null; name?: string; unit?: string; qty?: number; tier_unit_price_paise?: number; gst_rate_bps?: number; sample?: boolean }[]) {
      if (!l.product_id || l.sample) continue
      const cur = by.get(l.product_id)
      if (cur) {
        cur.orderedAt.push(o.created_at)
        continue
      }
      by.set(l.product_id, {
        productId: l.product_id,
        name: String(l.name ?? ''),
        unit: String(l.unit ?? ''),
        lastQty: Number(l.qty ?? 1),
        lastUnitPricePaise: Number(l.tier_unit_price_paise ?? 0),
        gstRateBps: Number(l.gst_rate_bps ?? 0),
        lastOrderedAt: o.created_at,
        orderedAt: [o.created_at],
      })
    }
  }
  return [...by.values()]
}
