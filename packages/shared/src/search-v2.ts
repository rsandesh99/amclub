import { z } from 'zod'
import { INDIAN_STATES } from './states'
import { CATEGORY_SLUGS } from './categories'
import { ALL_SPECIALIZATIONS } from './specializations'

/**
 * Experience v3 E2 (PRD FR-2.1 / 2.6 / 2.7 / 2.10) — search v2. ONE codec for
 * the URL, the API and the rig: every filter round-trips through the query
 * string (shareable), invalid values are dropped rather than trusted.
 */

export const SEARCH_SORTS_V2 = ['best', 'rating', 'price_asc', 'price_desc', 'fastest', 'newest'] as const
export type SearchSortV2 = (typeof SEARCH_SORTS_V2)[number]

/** Verification kinds a buyer can filter on (never PAN or bank). */
export const SEARCH_CREDENTIALS = ['gstin', 'icai', 'icsi', 'icmai', 'bar_council', 'ca', 'gstp', 'dsa', 'msme_cert', 'udyam', 'credential'] as const
export type SearchCredential = (typeof SEARCH_CREDENTIALS)[number]

/** Price bands on the price before GST (paise; the buyer pays this + GST). */
export const PRICE_BANDS = {
  under2k: { max: 200_000 },
  '2kto5k': { min: 200_000, max: 500_000 },
  '5kto10k': { min: 500_000, max: 1_000_000 },
  over10k: { min: 1_000_000 },
} as const satisfies Record<string, { min?: number; max?: number }>
export type PriceBand = keyof typeof PRICE_BANDS
export const PRICE_BAND_KEYS = Object.keys(PRICE_BANDS) as PriceBand[]

export const DELIVERY_CHOICES = [3, 7, 14] as const
export const RESPONSE_CHOICES = [1, 4, 24] as const
export const RATING_CHOICES = [3.5, 4, 4.5] as const
export const SEARCH_PAGE_SIZE = 24
/** "Load more" on phones shows pages 1..N together, up to this many pages. */
export const SEARCH_MORE_MAX_PAGES = 4

export type SearchView = 'grid' | 'list'

export interface SearchV2 {
  query?: string
  category?: string
  service?: string
  state?: string
  city?: string
  credential?: SearchCredential
  responseMaxHours?: number
  deliveryMaxDays?: number
  price?: PriceBand
  minRating?: number
  language?: string
  verifiedOnly?: true
  sort?: SearchSortV2
  view?: SearchView
  page?: number
  more?: true
}

/** The order keys are written in — stable, so a shared link is canonical. */
export const SEARCH_V2_KEYS = [
  'query', 'category', 'service', 'state', 'city', 'credential', 'responseMaxHours', 'deliveryMaxDays',
  'price', 'minRating', 'language', 'verifiedOnly', 'sort', 'view', 'page', 'more',
] as const satisfies readonly (keyof SearchV2)[]

/** Keys that narrow the result set (drive "filters active" and the widen fallback). */
export const SEARCH_V2_NARROWING = ['service', 'state', 'city', 'credential', 'responseMaxHours', 'deliveryMaxDays', 'price', 'minRating', 'language', 'verifiedOnly'] as const

const intIn = (v: string | undefined, lo: number, hi: number): number | undefined => {
  if (v === undefined || !/^\d{1,4}$/.test(v)) return undefined
  const n = Number(v)
  return n >= lo && n <= hi ? n : undefined
}
const STATE_CODES = new Set(INDIAN_STATES.map((s) => s.value))
const CATS = new Set<string>(CATEGORY_SLUGS)
const SERVICES = new Set<string>(ALL_SPECIALIZATIONS)

/**
 * Raw query-string values → SearchV2. Lenient: anything invalid is dropped.
 * Accepts the v1 names too (`offset` → page), so old links keep working.
 */
export function parseSearchV2(raw: Record<string, string | string[] | undefined>): SearchV2 {
  const get = (k: string): string | undefined => {
    const v = raw[k]
    const s = Array.isArray(v) ? v[0] : v
    return s === undefined || s === '' ? undefined : s
  }
  const out: SearchV2 = {}
  const query = get('query')?.trim().slice(0, 120)
  if (query) out.query = query
  const category = get('category')
  if (category && CATS.has(category)) out.category = category
  const service = get('service')
  if (service && SERVICES.has(service)) out.service = service
  const state = get('state')?.toUpperCase()
  if (state && STATE_CODES.has(state)) out.state = state
  const city = get('city')?.trim()
  if (city && /^[\p{L} .'-]{2,40}$/u.test(city)) out.city = city
  const credential = get('credential')
  if (credential && (SEARCH_CREDENTIALS as readonly string[]).includes(credential)) out.credential = credential as SearchCredential
  const resp = intIn(get('responseMaxHours'), 1, 168)
  if (resp !== undefined) out.responseMaxHours = resp
  const del = intIn(get('deliveryMaxDays'), 1, 90)
  if (del !== undefined) out.deliveryMaxDays = del
  const price = get('price')
  if (price && Object.prototype.hasOwnProperty.call(PRICE_BANDS, price)) out.price = price as PriceBand
  const rating = get('minRating')
  if (rating && (RATING_CHOICES as readonly number[]).includes(Number(rating))) out.minRating = Number(rating)
  const language = get('language')
  if (language && /^[a-z]{2}$/.test(language)) out.language = language
  if (get('verifiedOnly') === 'true' || get('verifiedOnly') === '1') out.verifiedOnly = true
  const sort = get('sort')
  if (sort && (SEARCH_SORTS_V2 as readonly string[]).includes(sort)) out.sort = sort as SearchSortV2
  const view = get('view')
  if (view === 'grid' || view === 'list') out.view = view
  const page = intIn(get('page'), 1, 50)
  const legacyOffset = intIn(get('offset'), 0, 5000)
  if (page !== undefined && page > 1) out.page = page
  else if (page === undefined && legacyOffset !== undefined && legacyOffset >= SEARCH_PAGE_SIZE) out.page = Math.floor(legacyOffset / SEARCH_PAGE_SIZE) + 1
  if (get('more') === '1' && out.page) out.more = true
  return out
}

/** SearchV2 → canonical query string entries (defaults omitted). */
export function searchV2ToEntries(s: SearchV2): [string, string][] {
  const out: [string, string][] = []
  for (const k of SEARCH_V2_KEYS) {
    const v = s[k]
    if (v === undefined) continue
    if (k === 'verifiedOnly' || k === 'more') out.push([k, k === 'more' ? '1' : 'true'])
    else out.push([k, String(v)])
  }
  return out
}

export function searchV2ToQueryString(s: SearchV2): string {
  return new URLSearchParams(searchV2ToEntries(s)).toString()
}

/** A copy with one key changed; a filter change always goes back to page 1. */
export function withSearchV2<K extends keyof SearchV2>(s: SearchV2, key: K, value: SearchV2[K] | undefined): SearchV2 {
  const next: SearchV2 = { ...s }
  if (value === undefined) delete next[key]
  else next[key] = value
  if (key !== 'page' && key !== 'more' && key !== 'view') {
    delete next.page
    delete next.more
  }
  return next
}

export const hasNarrowingV2 = (s: SearchV2): boolean => SEARCH_V2_NARROWING.some((k) => s[k] !== undefined)
export const activeFilterCountV2 = (s: SearchV2): number => SEARCH_V2_NARROWING.filter((k) => s[k] !== undefined).length

/** Paging window: numbered pages show one page; "load more" shows 1..page. */
export function searchV2Window(s: SearchV2): { limit: number; offset: number } {
  const page = s.page ?? 1
  if (s.more) {
    const pages = Math.min(page, SEARCH_MORE_MAX_PAGES)
    return { limit: SEARCH_PAGE_SIZE * pages, offset: 0 }
  }
  return { limit: SEARCH_PAGE_SIZE, offset: (page - 1) * SEARCH_PAGE_SIZE }
}

/** FR-2.7: weak = fewer than 3 results, or every result below the rank threshold. */
export const WEAK_RANK_THRESHOLD = 0.05
export function isWeakSearch(input: { total: number; topRank: number | null; hasQuery: boolean }): boolean {
  if (input.total < 3) return true
  return input.hasQuery && (input.topRank ?? 0) < WEAK_RANK_THRESHOLD
}

/** FR-2.6 relevance feedback (POST /api/v1/search/feedback). */
export const SEARCH_FEEDBACK_REASONS = ['not_relevant', 'too_expensive', 'too_slow', 'not_in_my_state'] as const
export const searchFeedbackSchema = z
  .object({
    query: z.string().trim().max(200).nullable(),
    filters: z.record(z.string().max(40), z.string().max(120)).refine((r) => Object.keys(r).length <= 20),
    resultIds: z.array(z.string().uuid()).max(24),
    helpful: z.boolean(),
    reason: z.enum(SEARCH_FEEDBACK_REASONS).nullable(),
    surface: z.enum(['web', 'mobile']).default('web'),
  })
  .strict()
export type SearchFeedback = z.infer<typeof searchFeedbackSchema>

/** Facet counts from search_facets_v2: facet → value → count. */
export type SearchFacets = Partial<Record<'category' | 'service' | 'state' | 'credential' | 'language' | 'verified' | 'delivery' | 'rating' | 'total', Record<string, number>>>

export function toSearchFacets(rows: { facet: string; value: string | null; n: number | string }[]): SearchFacets {
  const out: SearchFacets = {}
  for (const r of rows) {
    if (r.value === null) continue
    const f = r.facet as keyof SearchFacets
    const bucket = (out[f] ??= {})
    // Postgres prints numeric facet values as '4.0' / '4.5'; normalise to the URL form.
    const key = f === 'rating' ? String(Number(r.value)) : r.value
    bucket[key] = Number(r.n)
  }
  return out
}

/** The only inputs the `best` sort may use (PRD FR-2.1: never a paid signal). */
export const BEST_SORT_SIGNALS = ['text_rank', 'rating_bayes', 'verified'] as const
