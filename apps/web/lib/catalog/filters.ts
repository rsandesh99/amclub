import type { SearchFilters, SortOption } from './types'

const SORTS: SortOption[] = ['rating', 'price_asc', 'price_desc', 'newest']

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Map raw URL searchParams → typed SearchFilters (server-side, validated). */
export function parseFilters(
  sp: Record<string, string | undefined>,
  overrides: Partial<SearchFilters> = {},
): SearchFilters {
  const minPrice = num(sp['minPrice'])
  const maxPrice = num(sp['maxPrice'])
  const minRating = num(sp['minRating'])
  const offset = num(sp['offset'])
  const sort = sp['sort'] && SORTS.includes(sp['sort'] as SortOption) ? (sp['sort'] as SortOption) : undefined

  const filters: SearchFilters = {
    ...(sp['query'] ? { query: sp['query'] } : {}),
    ...(sp['state'] ? { state: sp['state'] } : {}),
    ...(minPrice !== undefined ? { minPrice } : {}),
    ...(maxPrice !== undefined ? { maxPrice } : {}),
    ...(minRating !== undefined ? { minRating } : {}),
    ...(sp['language'] ? { language: sp['language'] } : {}),
    ...(sp['verifiedOnly'] === 'true' ? { verifiedOnly: true } : {}),
    ...(sort ? { sort } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...overrides,
  }
  return filters
}

/** True when any narrowing filter/search is active (drives /services view mode). */
export function hasActiveFilters(sp: Record<string, string | undefined>): boolean {
  return Boolean(
    sp['query'] || sp['state'] || sp['minPrice'] || sp['maxPrice'] ||
    sp['minRating'] || sp['language'] || sp['verifiedOnly'] || sp['sort'],
  )
}
