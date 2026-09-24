import { z } from 'zod'
import { searchV2ToEntries, type SearchV2 } from './search-v2'

/**
 * E15 data foundations, part two — nothing here is user-visible.
 *
 *  F5  search telemetry: a `search_id` per results page; a sample of searches
 *      (default 20 %, `agent_settings.search_telemetry_sample_pct`) lands in
 *      `search_queries` with the normalised parameters and the result count —
 *      no user id, 180 days. The id rides package view → checkout →
 *      `orders.attribution`, so a search can be tied to the order it produced.
 *  F4  declared vs actual: a provider whose paid orders sit mostly outside
 *      their declared categories is flagged to ops (never public).
 *  F6  consented corpora + service_synonyms.
 */
export const SEARCH_SAMPLE_PCT_DEFAULT = 20
export const SEARCH_RETENTION_DAYS = 180

/** Deterministic per search id (FNV-1a), so a replayed page never double-samples. */
export function sampledSearch(searchId: string, pct: number): boolean {
  if (pct <= 0) return false
  if (pct >= 100) return true
  let h = 0x811c9dc5
  for (let i = 0; i < searchId.length; i++) { h ^= searchId.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h % 100 < pct
}

/** The query folded (NFKC, lowercase, spaces collapsed, ≤ 120) + every other parameter except paging and view. */
export function normaliseSearch(s: SearchV2): { query: string | null; params: Record<string, string> } {
  const q = s.query ? s.query.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120) : ''
  const params = Object.fromEntries(searchV2ToEntries(s).filter(([k]) => k !== 'query' && k !== 'page' && k !== 'more' && k !== 'view'))
  return { query: q || null, params }
}

export const searchAttributionSchema = z.object({
  search_id: z.string().uuid(),
  /** 1-based rank of the clicked result across the search's pages. */
  position: z.number().int().min(1).max(500).optional(),
}).strict()
export type SearchAttribution = z.infer<typeof searchAttributionSchema>

// ── F4 declared vs actual ────────────────────────────────────────────────────
export const DVA_MIN_ORDERS = 5
export const DVA_MISMATCH_SHARE = 0.5
/** Over the provider's paid orders: the share outside their declared categories; a flag above 50 % at n ≥ 5. */
export function declaredVsActual(declared: readonly string[], orderCategories: readonly string[]): { n: number; outside: number; share: number | null; flag: boolean; topActual: string | null } {
  const n = orderCategories.length
  const outsideList = orderCategories.filter((c) => !declared.includes(c))
  const counts = new Map<string, number>()
  for (const c of outsideList) counts.set(c, (counts.get(c) ?? 0) + 1)
  const topActual = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
  const share = n ? Math.round((outsideList.length / n) * 1000) / 1000 : null
  return { n, outside: outsideList.length, share, flag: n >= DVA_MIN_ORDERS && share !== null && share > DVA_MISMATCH_SHARE, topActual }
}

// ── F6 consented corpora + synonyms ─────────────────────────────────────────
export const corpusConsentSchema = z.object({ on: z.boolean() }).strict()
export const SYNONYM_SOURCES = ['curated', 'search_log', 'corpus'] as const
export const serviceSynonymSchema = z.object({
  term: z.string().trim().min(1).max(80),
  lang: z.enum(['en', 'hi', 'te', 'ta', 'kn', 'mr', 'bn', 'gu', 'ml']),
  category_slug: z.string().min(1).max(60),
  service_slug: z.string().min(1).max(60).nullable(),
  source: z.enum(SYNONYM_SOURCES),
})
/** The one folding every synonym term and every lookup uses. */
export function synonymKey(term: string): string {
  return term.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** What the buyer changed on the way from an intake proposal to their final request (keys only). */
export function intakeCorrections(proposed: Record<string, unknown> | null, final: { title: string; categorySlug: string | null }): string[] {
  const out: string[] = []
  const p = proposed ?? {}
  const title = (p['suggested_title'] ?? p['title']) as string | undefined
  const cat = (p['suggested_category_slug'] ?? p['category_slug']) as string | undefined
  if (title && title.trim() !== final.title.trim()) out.push('title')
  if (cat && final.categorySlug && cat !== final.categorySlug) out.push('category')
  return out
}
