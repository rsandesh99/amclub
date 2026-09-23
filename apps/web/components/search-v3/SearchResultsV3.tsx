import { cookies } from 'next/headers'
import { getTranslations } from 'next-intl/server'
import {
  hasNarrowingV2,
  searchV2ToEntries,
  searchV2ToQueryString,
  SEARCH_MORE_MAX_PAGES,
  SEARCH_PAGE_SIZE,
  SEARCH_V2_NARROWING,
  type SearchV2,
  type SearchView,
} from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { ResultCard } from '@/components/catalog/ResultCard'
import { isOnForEveryone } from '@/lib/experiments'
import { searchCatalogV2 } from '@/lib/catalog/search-v2'
import { cardTrustFor, type CardTrust } from '@/lib/trust/card-trust'
import { FacetRail, FilterChipBar, SortControl, ViewToggle } from './FilterControls'
import { ResultRow } from './ResultRow'
import { SearchFeedback } from './SearchFeedback'
import { SearchTracker } from './SearchTracker'
import { WeakResultsCard } from './WeakResultsCard'
import { ServiceChips } from './ServiceChips'
import { YouSaidChip } from './YouSaidChip'
import { CompareTray } from '@/components/compare-v3/CompareTray'
import { RecentlyViewed } from '@/components/recent-v3/RecentlyViewed'

/**
 * Experience v3 E2 (flag `search`) — the results surface for /services,
 * /services/[category] and /app/search: chip bar + filter sheet (phones), the
 * facet rail (≥ 1280), sort, grid / list, numbered pages (desktop) or load
 * more (phones), relevance feedback and the weak-results card. Filters show
 * before a query on category pages (`fixedCategory`).
 */
export async function SearchResultsV3({ search, basePath, fixedCategory, fixedService, youSaid }: { search: SearchV2; basePath: string; fixedCategory?: string; fixedService?: string; youSaid?: string | undefined }) {
  const t = await getTranslations('filters_v3')
  const tc = await getTranslations('catalog')
  const s: SearchV2 = { ...search, ...(fixedCategory ? { category: fixedCategory } : {}), ...(fixedService ? { service: fixedService } : {}) }
  const jar = await cookies()
  const remembered = jar.get('amc_search_view')?.value
  const view: SearchView = s.view ?? (remembered === 'list' || remembered === 'grid' ? remembered : 'grid')

  let res = await searchCatalogV2(s)
  // Widen instead of empty (first page only): drop the narrowing filters, keep
  // the query + category, and say so.
  let widened = false
  if (res.total === 0 && hasNarrowingV2(s) && !s.page) {
    const relaxed: SearchV2 = {}
    if (s.query) relaxed.query = s.query
    if (s.category) relaxed.category = s.category
    if (fixedService) relaxed.service = fixedService
    if (s.sort) relaxed.sort = s.sort
    const r2 = await searchCatalogV2(relaxed, { withFacets: false })
    if (r2.total > 0) {
      res = { ...r2, facets: res.facets, weak: true }
      widened = true
    }
  }
  const { results, total, facets } = res
  const trust: Map<string, CardTrust> | null = isOnForEveryone('trust') ? await cardTrustFor(results.map((r) => r.providerId)) : null
  const equation = isOnForEveryone('packages')
  const cardTrust = (id: string) => (trust ? (trust.get(id) ?? { stat: null, activeThisWeek: false }) : undefined)

  const page = s.page ?? 1
  const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE))
  const shown = s.more ? Math.min(page, SEARCH_MORE_MAX_PAGES) * SEARCH_PAGE_SIZE : page * SEARCH_PAGE_SIZE
  // On a category page the path carries the category, not the query string.
  const urlFor = (next: SearchV2) => {
    const own: SearchV2 = { ...next }
    if (fixedCategory) delete own.category
    if (fixedService) delete own.service
    const qs = searchV2ToQueryString(own)
    return qs ? `${basePath}?${qs}` : basePath
  }
  const withPage = (p: number, more = false): SearchV2 => {
    const n: SearchV2 = { ...s }
    delete n.page
    delete n.more
    if (p > 1) n.page = p
    if (more && p > 1) n.more = true
    return n
  }
  const windowPages = Array.from({ length: pages }, (_, i) => i + 1).filter((p) => p === 1 || p === pages || Math.abs(p - page) <= 2)
  const filtersForEvents = SEARCH_V2_NARROWING.filter((k) => s[k] !== undefined)
  const feedbackFilters = Object.fromEntries(searchV2ToEntries(s).filter(([k]) => k !== 'page' && k !== 'more' && k !== 'view' && k !== 'query'))

  return (
    <div className="xl:grid xl:grid-cols-[15rem_minmax(0,1fr)] xl:gap-8" data-search-v3="" data-view={view}>
      <aside className="hidden xl:block">
        <FacetRail facets={facets} {...(fixedCategory ? { fixedCategory } : {})} {...(fixedService ? { fixedService } : {})} />
      </aside>
      <div className="min-w-0 space-y-4">
        {youSaid && <YouSaidChip text={youSaid} />}
        {s.category && <ServiceChips category={s.category} current={s.service} />}
        <FilterChipBar className="xl:hidden" facets={facets} {...(fixedCategory ? { fixedCategory } : {})} {...(fixedService ? { fixedService } : {})} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-foreground-secondary" data-testid="results-count">{tc('results_count', { count: total })}</p>
          <div className="flex items-center gap-2">
            <SortControl />
            <ViewToggle view={view} />
          </div>
        </div>

        {widened && <div className="rounded-button border border-border bg-muted px-4 py-3 text-sm text-foreground-secondary">{tc('widened_notice')}</div>}
        {(total === 0 || widened) && <WeakResultsCard query={s.query} category={s.category} state={s.state} zero />}
        {total === 0 && <RecentlyViewed />}

        {results.length > 0 &&
          (view === 'list' ? (
            <div className="overflow-hidden rounded-card border border-border bg-surface">
              <div className="hidden grid-cols-[2.25rem_minmax(0,2.4fr)_6rem_6rem_5rem_4.5rem_8rem] gap-x-3 border-b border-separator px-3 py-2 text-xs font-medium text-foreground-secondary md:grid">
                <span />
                <span>{t('col_provider')}</span>
                <span>{t('col_rating')}</span>
                <span>{t('col_on_time')}</span>
                <span>{t('col_replies')}</span>
                <span>{t('col_delivery')}</span>
                <span className="text-right">{t('col_price')}</span>
              </div>
              <ul className="divide-y divide-separator" data-density="compact">
                {results.map((r) => <ResultRow key={r.packageId} result={r} trust={cardTrust(r.providerId)} compare />)}
              </ul>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {results.map((r) => <ResultCard key={r.packageId} result={r} equation={equation} trust={cardTrust(r.providerId)} compare />)}
            </div>
          ))}

        {res.weak && total > 0 && !widened && <WeakResultsCard query={s.query} category={s.category} state={s.state} zero={false} />}

        {!widened && pages > 1 && (
          <>
            {/* Desktop: numbered pages (crawlable). */}
            <nav aria-label={t('pages')} className="hidden items-center justify-center gap-1 pt-2 md:flex">
              {windowPages.map((p, i) => (
                <span key={p} className="flex items-center gap-1">
                  {i > 0 && windowPages[i - 1]! < p - 1 && <span className="px-1 text-foreground-tertiary">…</span>}
                  <Link
                    href={urlFor(withPage(p)) as '/services'}
                    aria-current={p === page && !s.more ? 'page' : undefined}
                    className={p === page && !s.more ? 'flex h-9 min-w-9 items-center justify-center rounded-button bg-primary px-2 text-sm font-semibold text-white' : 'flex h-9 min-w-9 items-center justify-center rounded-button px-2 text-sm hover:bg-sunken'}
                  >
                    {p}
                  </Link>
                </span>
              ))}
            </nav>
            {/* Phones: load more (the next page appended). */}
            {shown < total && page < SEARCH_MORE_MAX_PAGES && (
              <div className="flex justify-center md:hidden">
                <Link href={urlFor(withPage(page + 1, true)) as '/services'} scroll={false} className="min-h-[44px] rounded-button border border-border bg-surface px-5 py-2.5 text-sm font-medium">
                  {t('load_more')}
                </Link>
              </div>
            )}
          </>
        )}

        {results.length > 0 && page === 1 && !widened && (
          <SearchFeedback query={s.query ?? null} filters={feedbackFilters} resultIds={results.slice(0, 24).map((r) => r.packageId)} />
        )}
        <CompareTray />
        <SearchTracker signature={searchV2ToQueryString(s)} qLen={s.query?.length ?? 0} filters={filtersForEvents} sort={s.sort ?? 'best'} results={total} view={view} />
      </div>
    </div>
  )
}
