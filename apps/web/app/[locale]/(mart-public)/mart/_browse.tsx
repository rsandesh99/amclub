import { getTranslations, getLocale } from 'next-intl/server'
import { pickLocale } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { listMartCategories } from '@/lib/mart/config'
import { listPublicProducts, listBrands, type ProductListFilters, type ProductSort } from '@/lib/mart/queries'
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
}

export function toFilters(p: BrowseParams): ProductListFilters {
  const band = PRICE_BANDS.find((b) => b.key === p.band)
  const sort = (['newest', 'price_asc', 'price_desc'] as const).includes(p.sort as ProductSort) ? (p.sort as ProductSort) : 'newest'
  return {
    ...(p.category ? { category: p.category } : {}),
    ...(p.query ? { query: p.query } : {}),
    ...(p.brand ? { brand: p.brand } : {}),
    ...(p.seller ? { sellerSlug: p.seller } : {}),
    ...(band?.min !== undefined ? { minPricePaise: band.min } : {}),
    ...(band?.max !== undefined ? { maxPricePaise: band.max } : {}),
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
  return p.toString()
}

export async function MartBrowse({ params, base }: { params: BrowseParams; base: string }) {
  const t = await getTranslations('mart')
  const tr = await getTranslations('rfq')
  const locale = await getLocale()
  const filters = toFilters(params)
  // Three independent reads in parallel — one round trip to the database.
  const [categories, result, brands, openPools] = await Promise.all([
    listMartCategories(),
    listPublicProducts(filters),
    listBrands(params.category),
    // "Buy together" strip — only on the unfiltered front page, up to three open pools.
    !params.category && !params.query && !params.brand && !params.band && !params.seller
      ? createAdminClient().then((admin) => listPools(admin, { statuses: ['open'], limit: 3 }))
      : Promise.resolve([]),
  ])
  const chipParams = { sort: params.sort, brand: params.brand, band: params.band, seller: params.seller, query: params.query }
  const keep = new URLSearchParams()
  for (const [k, v] of Object.entries(chipParams)) if (v) keep.set(k, v)
  const keepQs = keep.toString() ? `?${keep.toString()}` : ''

  return (
    <div className="mart-enter">
      <JaaliHeader>
        <h1 className="font-display text-3xl font-bold tracking-tight text-emerald-ink">{t('title')}</h1>
        <p className="mt-1 max-w-2xl text-body text-emerald-ink/80">{t('subtitle')}</p>
        <div className="mt-5">
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

        <FilterBar base={base} current={chipParams} brands={brands} />

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

        {result.products.length === 0 ? (
          <div className="jaali-ivory mt-4 rounded-[10px] border border-brass/40 px-6 py-16 text-center">
            <h2 className="text-lg font-semibold text-emerald-ink">{t('no_products_title')}</h2>
            <p className="mx-auto mt-1 max-w-md text-body text-foreground-secondary">{t('no_products_body')}</p>
            {/* AMC Mart M2 — nothing listed → ask verified sellers to quote. */}
            <Link
              href={`/app/mart/rfq/new${params.query ? `?item=${encodeURIComponent(params.query)}` : ''}${params.category ? `${params.query ? '&' : '?'}category=${encodeURIComponent(params.category)}` : ''}` as '/app'}
              className="mt-4 inline-flex min-h-11 items-center rounded-button bg-emerald px-4 text-meta font-semibold text-ivory"
            >
              {tr('goods_empty_ask_cta')}
            </Link>
          </div>
        ) : (
          <ProductGrid initial={result.products} total={result.total} nextOffset={result.nextOffset} query={apiQuery(filters)} />
        )}
      </div>
    </div>
  )
}
