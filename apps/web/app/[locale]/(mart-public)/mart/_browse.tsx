import { isOnForEveryone } from '@/lib/experiments'
import { WhyAmclub } from '@/components/usp/WhyAmclub'
import { getTranslations, getLocale } from 'next-intl/server'
import { countAttributeFacets, parseAttributeFilters, pickLocale, type MartAttributeDef } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { listMartCategories } from '@/lib/mart/config'
import { attributeFacetRows, listPublicProducts, listBrands, type ProductListFilters, type ProductSort } from '@/lib/mart/queries'
import { publicCategoryAttributes } from '@/lib/mart/attributes'
import { AttributeFacets } from '@/components/mart/AttributeFacets'
import { ModeSwitch } from '@/components/mart/ModeSwitch'
import { ProductGrid } from '@/components/mart/ProductGrid'
import { SearchBox } from '@/components/mart/SearchBox'
import { FilterBar, PRICE_BANDS } from '@/components/mart/FilterBar'
import { JaaliHeader } from '@/components/mart/primitives'
import { PoolCard } from '@/components/mart/PoolCard'
import { createAdminClient } from '@/lib/supabase/server'
import { listPools, poolProgressFor } from '@/lib/mart/pools'

/**
 * Shared renderer for /mart, /mart/c/[slug] and /mart/search. The first two
 * are ISR pages (edge-cached HTML, purged on catalog mutations); search is
 * dynamic. Filters/sort are query params that every page accepts.
 */
export interface BrowseParams {
  category?: string | undefined
  query?: string | undefined
  sort?: string | undefined
  brand?: string | undefined
  band?: string | undefined
  seller?: string | undefined
  /** E16 N40 — raw `a.<key>` params; only facetable keys of the category survive. */
  attrs?: Record<string, string | undefined> | undefined
}

/** The `a.<key>` params of a page's search params (E16 N40). */
export function attrParams(sp: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(sp).filter(([k, v]) => k.startsWith('a.') && typeof v === 'string'))
}

export function toFilters(p: BrowseParams, defs: readonly MartAttributeDef[] = []): ProductListFilters {
  const attrs = p.category && p.attrs ? parseAttributeFilters(defs, p.attrs) : {}
  const band = PRICE_BANDS.find((b) => b.key === p.band)
  const sort = (['newest', 'price_asc', 'price_desc'] as const).includes(p.sort as ProductSort) ? (p.sort as ProductSort) : 'newest'
  return {
    ...(p.category ? { category: p.category } : {}),
    ...(p.query ? { query: p.query } : {}),
    ...(p.brand ? { brand: p.brand } : {}),
    ...(p.seller ? { sellerSlug: p.seller } : {}),
    ...(band?.min !== undefined ? { minPricePaise: band.min } : {}),
    ...(band?.max !== undefined ? { maxPricePaise: band.max } : {}),
    ...(Object.keys(attrs).length ? { attrs } : {}),
    sort,
    limit: 24,
  }
}

/** Query string for the client "show more" fetch (same filters, no offset). */
function apiQuery(f: ProductListFilters): string {
  const p = new URLSearchParams()
  if (f.category) p.set('category', f.category)
  if (f.query) p.set('query', f.query)
  if (f.brand) p.set('brand', f.brand)
  if (f.sellerSlug) p.set('seller', f.sellerSlug)
  if (f.minPricePaise !== undefined) p.set('minPrice', String(f.minPricePaise))
  if (f.maxPricePaise !== undefined) p.set('maxPrice', String(f.maxPricePaise))
  if (f.sort && f.sort !== 'newest') p.set('sort', f.sort)
  for (const [k, v] of Object.entries(f.attrs ?? {})) p.set(`a.${k}`, String(v))
  return p.toString()
}

/** The goods RFQ (ADR-007) prefilled from the query / category — "Make to order" (N39). */
function makeToOrderHref(query: string | undefined, category: string | undefined): string {
  const p = new URLSearchParams()
  if (query) p.set('item', query)
  if (category) p.set('category', category)
  const qs = p.toString()
  return `/app/mart/rfq/new${qs ? `?${qs}` : ''}`
}

/** Fewer than this many goods results is "weak": the prefilled goods RFQ card shows (N39). */
const WEAK_RESULTS = 3

export async function MartBrowse({ params, base }: { params: BrowseParams; base: string }) {
  const t = await getTranslations('mart')
  const tr = await getTranslations('rfq')
  const locale = await getLocale()
  // E16 N40 — the category's typed attributes decide which `a.*` filters apply.
  const defs = params.category ? await publicCategoryAttributes(params.category) : []
  const filters = toFilters(params, defs)
  // Independent reads in parallel — one round trip to the database.
  const [categories, result, brands, facetRows, openPools] = await Promise.all([
    listMartCategories(),
    listPublicProducts(filters),
    listBrands(params.category),
    defs.some((d) => d.facetable) ? attributeFacetRows(filters) : Promise.resolve([]),
    // "Buy together" strip — only on the unfiltered front page, up to three open pools.
    !params.category && !params.query && !params.brand && !params.band && !params.seller && !filters.attrs
      ? createAdminClient().then((admin) => listPools(admin, { statuses: ['open'], limit: 3 }))
      : Promise.resolve([]),
  ])
  const chipParams = { sort: params.sort, brand: params.brand, band: params.band, seller: params.seller, query: params.query }
  const keep = new URLSearchParams()
  for (const [k, v] of Object.entries(chipParams)) if (v) keep.set(k, v)
  const keepQs = keep.toString() ? `?${keep.toString()}` : ''
  // Attribute filters are per category: they ride the sort / price / brand chips, never a category switch.
  const attrChips = Object.fromEntries(Object.entries(filters.attrs ?? {}).map(([k, v]) => [`a.${k}`, String(v)]))
  const barParams = { ...chipParams, ...attrChips }
  const facets = countAttributeFacets(defs, facetRows)
  const rfqHref = makeToOrderHref(params.query, params.category)
  // E18 (flag `guide`): "Why AMClub" beside the listings on the unfiltered front page.
  const front = !params.category && !params.query && !params.brand && !params.band && !params.seller && !filters.attrs
  const guide = front && isOnForEveryone('guide')

  return (
    <div className="mart-enter">
      <JaaliHeader>
        <h1 className="font-display text-3xl font-bold tracking-tight text-emerald-ink">{t('title')}</h1>
        <p className="mt-1 max-w-2xl text-body text-emerald-ink/80">{t('subtitle')}</p>
        {/* E16 N39 — the same Services | Goods switch as the services search. */}
        <div className="mt-4"><ModeSwitch mode="goods" query={params.query} /></div>
        <div className="mt-3">
          <SearchBox defaultValue={params.query ?? ''} {...(params.category ? { category: params.category } : {})} />
        </div>
      </JaaliHeader>

      <div className="mx-auto max-w-6xl px-4 py-6">
        <nav aria-label={t('categories')} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          <Link
            href={`/mart${keepQs}` as '/services'}
            className={`chip-toggle h-10 shrink-0 text-meta ${!params.category ? 'border-emerald bg-emerald text-ivory' : 'border-brass/50 bg-ivory text-emerald-ink'}`}
            aria-pressed={!params.category}
          >
            {t('all_categories')}
          </Link>
          {categories.map((c) => (
            <Link
              key={c.slug}
              href={`/mart/c/${c.slug}${keepQs}` as '/services'}
              aria-pressed={params.category === c.slug}
              aria-disabled={c.bis_blocked}
              className={`chip-toggle h-10 shrink-0 text-meta ${
                c.bis_blocked
                  ? 'pointer-events-none border-border text-foreground-secondary opacity-60'
                  : params.category === c.slug
                    ? 'border-emerald bg-emerald text-ivory'
                    : 'border-brass/50 bg-ivory text-emerald-ink'
              }`}
              title={c.bis_blocked ? t('blocked_category') : undefined}
            >
              {pickLocale(c.name_i18n, locale)}
            </Link>
          ))}
        </nav>

        <div className={guide ? 'lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start lg:gap-6' : undefined}>
        <div className="min-w-0">
        {openPools.length > 0 && (
          <section className="mt-5" aria-labelledby="pools-strip">
            <div className="flex items-baseline justify-between">
              <h2 id="pools-strip" className="font-display text-xl font-bold text-emerald-ink">{t('pools_strip_title')}</h2>
              <Link href={'/mart/pools' as '/services'} className="inline-flex min-h-11 items-center text-meta font-medium text-emerald underline underline-offset-2">{t('pools_strip_all')} →</Link>
            </div>
            <ul className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {openPools.map((p) => (
                <li key={p.id}><PoolCard pool={p} progress={poolProgressFor(p)} /></li>
              ))}
            </ul>
          </section>
        )}

        <FilterBar base={base} current={barParams} brands={brands} />
        <AttributeFacets base={base} current={barParams} facets={facets} />

        <p className="mt-4 text-meta text-foreground-secondary">
          {params.query ? `${t('search_results_for', { query: params.query })} · ` : ''}
          {t('results_count', { count: result.total })}
          {params.query && (
            <>
              {' · '}
              <Link href={(params.category ? `/mart/c/${params.category}` : '/mart') as '/services'} className="text-emerald underline underline-offset-2">{t('clear_search')}</Link>
            </>
          )}
        </p>

        {/* E16 N39 — "Buy now" (the listings below) and "Make to order" (a goods RFQ) on the same query. */}
        {params.query && result.total >= WEAK_RESULTS && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-brass/40 bg-ivory px-4 py-3" data-testid="make-to-order">
            <p className="text-meta text-emerald-ink">{t('make_to_order_body')}</p>
            <Link href={rfqHref as '/app'} className="inline-flex min-h-11 items-center rounded-button border border-emerald px-4 text-meta font-semibold text-emerald">
              {t('make_to_order_cta')}
            </Link>
          </div>
        )}

        {result.products.length === 0 ? (
          <div className="jaali-ivory mt-4 rounded-[10px] border border-brass/40 px-6 py-16 text-center">
            <h2 className="text-lg font-semibold text-emerald-ink">{t('no_products_title')}</h2>
            <p className="mx-auto mt-1 max-w-md text-body text-foreground-secondary">{t('no_products_body')}</p>
            {/* AMC Mart M2 — nothing listed → ask verified sellers to quote. */}
            <Link
              href={rfqHref as '/app'}
              className="mt-4 inline-flex min-h-11 items-center rounded-button bg-emerald px-4 text-meta font-semibold text-ivory"
            >
              {tr('goods_empty_ask_cta')}
            </Link>
          </div>
        ) : (
          <>
            <ProductGrid initial={result.products} total={result.total} nextOffset={result.nextOffset} query={apiQuery(filters)} />
            {/* E16 N39 — a weak goods result offers the prefilled goods RFQ too (the goods twin of N7). */}
            {(params.query || params.category) && result.total < WEAK_RESULTS && (
              <div className="jaali-ivory mt-4 rounded-[10px] border border-brass/40 px-6 py-6 text-center" data-testid="weak-goods-rfq">
                <h2 className="text-body font-semibold text-emerald-ink">{t('weak_results_title')}</h2>
                <p className="mx-auto mt-1 max-w-md text-meta text-foreground-secondary">{t('weak_results_body')}</p>
                <Link href={rfqHref as '/app'} className="mt-3 inline-flex min-h-11 items-center rounded-button bg-emerald px-4 text-meta font-semibold text-ivory">
                  {tr('goods_empty_ask_cta')}
                </Link>
              </div>
            )}
          </>
        )}
        </div>
        {guide && (
          <aside className="mt-8 lg:sticky lg:top-20 lg:mt-5" aria-label={t('why_label')}>
            <WhyAmclub surface="mart" martEnabled tone="mart" collapsedCount={5} />
          </aside>
        )}
        </div>
      </div>
    </div>
  )
}
