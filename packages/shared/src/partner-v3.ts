import { z } from 'zod'
import { CATEGORY_SLUGS } from './categories'
import { INDIAN_STATES } from './states'
import { RFQ_BUDGET_BANDS, RFQ_BUDGET_BAND_KEYS, type RfqBudgetBand } from './rfq-v3'

/**
 * PRD Experience v3 E11 — the provider workspace (flag `partner`).
 * FR-11.2 (N28) inbox v2: filters / sort / search live in the URL and run on
 * the server over the provider's OWN matched list, so no filter can widen
 * what the match (and RLS) returns. FR-11.3 (N28b, D2): "Buyer verified ✓" is
 * a boolean only. FR-11.1 / 11.5 (N29): the funnel.
 */

export const INBOX_SORTS = ['newest', 'closing', 'budget_high'] as const
export type InboxSort = (typeof INBOX_SORTS)[number]
export const INBOX_TABS = ['open', 'quoted', 'closed'] as const
/** "Closing soon" = the RFQ's quote window ends within this many hours. */
export const CLOSING_SOON_HOURS = 12

const STATE_CODES = new Set(INDIAN_STATES.map((s) => s.value))

export interface InboxQuery {
  tab: (typeof INBOX_TABS)[number]
  page: number
  category?: string
  state?: string
  budget?: RfqBudgetBand
  closing?: true
  verified?: true
  files?: true
  q?: string
  sort: InboxSort
}

/** Parse the inbox URL parameters; anything unknown is dropped (never an error). */
export function parseInboxQuery(raw: Record<string, string | string[] | undefined>): InboxQuery {
  const get = (k: string): string | undefined => {
    const v = raw[k]
    const s = Array.isArray(v) ? v[0] : v
    return s === undefined || s === '' ? undefined : s
  }
  const out: InboxQuery = { tab: 'open', page: 1, sort: 'newest' }
  const tab = get('tab')
  if (tab && (INBOX_TABS as readonly string[]).includes(tab)) out.tab = tab as InboxQuery['tab']
  const page = Number(get('page'))
  if (Number.isInteger(page) && page >= 1 && page <= 1000) out.page = page
  const category = get('category')
  if (category && (CATEGORY_SLUGS as readonly string[]).includes(category)) out.category = category
  const state = get('state')?.toUpperCase()
  if (state && STATE_CODES.has(state)) out.state = state
  const budget = get('budget')
  if (budget && (RFQ_BUDGET_BAND_KEYS as readonly string[]).includes(budget)) out.budget = budget as RfqBudgetBand
  if (get('closing') === '1') out.closing = true
  if (get('verified') === '1') out.verified = true
  if (get('files') === '1') out.files = true
  const q = get('q')?.trim().slice(0, 80)
  if (q) out.q = q
  const sort = get('sort')
  if (sort && (INBOX_SORTS as readonly string[]).includes(sort)) out.sort = sort as InboxSort
  return out
}

/** The canonical query string (tab first; defaults omitted) — bookmarkable and shareable inside the team. */
export function inboxQueryToString(q: Partial<InboxQuery>): string {
  const p = new URLSearchParams()
  if (q.tab && q.tab !== 'open') p.set('tab', q.tab)
  if (q.category) p.set('category', q.category)
  if (q.state) p.set('state', q.state)
  if (q.budget) p.set('budget', q.budget)
  if (q.closing) p.set('closing', '1')
  if (q.verified) p.set('verified', '1')
  if (q.files) p.set('files', '1')
  if (q.q) p.set('q', q.q)
  if (q.sort && q.sort !== 'newest') p.set('sort', q.sort)
  if (q.page && q.page > 1) p.set('page', String(q.page))
  return p.toString()
}

/** The facts a filter may read — all already on the provider's own matched rows. */
export interface InboxFacts {
  title: string
  categorySlug: string | null
  buyerState: string | null
  budgetMinPaise: number | null
  budgetMaxPaise: number | null
  expiresAt: string
  /** FR-11.3 — a boolean only; false while the D2 badge is off. */
  buyerVerified: boolean
  hasFiles: boolean
  notifiedAt: string | null
}

/** A budget band matches when the RFQ's stated range overlaps it (an RFQ with no budget never matches a band). */
export function budgetOverlapsBand(min: number | null, max: number | null, band: RfqBudgetBand): boolean {
  if (min == null && max == null) return false
  const b = RFQ_BUDGET_BANDS[band] as { min?: number; max?: number }
  const lo = min ?? 0
  const hi = max ?? Number.MAX_SAFE_INTEGER
  return hi >= (b.min ?? 0) && lo <= (b.max ?? Number.MAX_SAFE_INTEGER)
}

/** Filter + search + sort, in memory, over the provider's own matched rows (never widens). */
export function applyInboxQuery<T extends InboxFacts>(items: readonly T[], q: InboxQuery, now: Date = new Date()): T[] {
  const soon = now.getTime() + CLOSING_SOON_HOURS * 3600 * 1000
  const needle = q.q?.toLowerCase()
  const out = items.filter(
    (r) =>
      (!q.category || r.categorySlug === q.category) &&
      (!q.state || r.buyerState === q.state) &&
      (!q.budget || budgetOverlapsBand(r.budgetMinPaise, r.budgetMaxPaise, q.budget)) &&
      (!q.closing || (Date.parse(r.expiresAt) > now.getTime() && Date.parse(r.expiresAt) <= soon)) &&
      (!q.verified || r.buyerVerified) &&
      (!q.files || r.hasFiles) &&
      (!needle || r.title.toLowerCase().includes(needle)),
  )
  const t = (s: string | null) => (s ? Date.parse(s) : 0)
  if (q.sort === 'closing') out.sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))
  else if (q.sort === 'budget_high') out.sort((a, b) => (b.budgetMaxPaise ?? b.budgetMinPaise ?? -1) - (a.budgetMaxPaise ?? a.budgetMinPaise ?? -1))
  else out.sort((a, b) => t(b.notifiedAt) - t(a.notifiedAt))
  return out
}

// ── FR-11.3 (N28b, D2) buyer verified ─────────────────────────────────────────────
/** Verified identity (Udyam or GSTIN) AND at least one paid order on AMClub with any provider. */
export function isBuyerVerified(b: { udyamVerified: boolean; gstinVerified: boolean; paidOrders: number }): boolean {
  return (b.udyamVerified || b.gstinVerified) && b.paidOrders >= 1
}

// ── N29 funnel ────────────────────────────────────────────────────────────────────
export const FUNNEL_RANGES = ['7d', '30d'] as const
export type FunnelRange = (typeof FUNNEL_RANGES)[number]
export const rangeDays = (r: FunnelRange): number => (r === '30d' ? 30 : 7)
/** A decline reason shows only with at least this many (no single buyer identifiable). */
export const DECLINE_REASON_MIN_N = 3

export const funnelSchema = z.object({
  range: z.enum(FUNNEL_RANGES),
  views: z.number().int(),
  matched: z.number().int(),
  quoted: z.number().int(),
  won: z.number().int(),
  /** Whole-percent conversions; null when the base is 0. */
  quoteRate: z.number().int().nullable(),
  winRate: z.number().int().nullable(),
  declineReasons: z.array(z.object({ reason: z.string(), n: z.number().int() })),
})
export type Funnel = z.infer<typeof funnelSchema>

export function buildFunnel(range: FunnelRange, c: { views: number; matched: number; quoted: number; won: number }, reasons: readonly string[]): Funnel {
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a * 100) / b) : null)
  const counts = new Map<string, number>()
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1)
  const declineReasons = [...counts.entries()]
    .filter(([, n]) => n >= DECLINE_REASON_MIN_N)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([reason, n]) => ({ reason, n }))
  return { range, ...c, quoteRate: pct(c.quoted, c.matched), winRate: pct(c.won, c.quoted), declineReasons }
}

// ── view beacon (view_counts_daily) ─────────────────────────────────────────────────
export const VIEW_SUBJECTS = ['provider', 'package'] as const
export const viewBeaconSchema = z.object({ kind: z.enum(VIEW_SUBJECTS), id: z.string().uuid() }).strict()
/** Obvious crawlers never count. */
export const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|lighthouse|headless|curl|wget|python-requests/i
