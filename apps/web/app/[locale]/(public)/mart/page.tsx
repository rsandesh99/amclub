import type { Metadata } from 'next'
import { getTranslations, getLocale } from 'next-intl/server'
import { pickLocale } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { martPageGate } from '@/lib/mart/gate'
import { listMartCategories } from '@/lib/mart/config'
import { listPublicProducts } from '@/lib/mart/queries'
import { ProductCard } from '@/components/mart/ProductCard'
import { JaaliHeader } from '@/components/mart/primitives'
import { MART_ENABLED } from '@/lib/flags'

export async function generateMetadata(): Promise<Metadata> {
  if (!MART_ENABLED) return {}
  const t = await getTranslations('mart')
  return { title: t('title'), description: t('subtitle') }
}

/**
 * AMC Mart — buyer home + search (FRONTEND.md P8 pattern: jaali header,
 * category tiles, hybrid-search-ready list). Public read; RLS scopes rows.
 */
export default async function MartPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  martPageGate()
  const sp = await searchParams
  const t = await getTranslations('mart')
  const locale = await getLocale()
  const category = sp['category']
  const query = sp['query']?.trim()
  const [categories, result] = await Promise.all([
    listMartCategories(),
    listPublicProducts({ ...(category ? { category } : {}), ...(query ? { query } : {}), limit: 24 }),
  ])

  return (
    <div className="mart-enter">
      <JaaliHeader>
        <h1 className="font-display text-3xl font-bold tracking-tight text-emerald-ink">{t('title')}</h1>
        <p className="mt-1 max-w-2xl text-md text-emerald-ink/80">{t('subtitle')}</p>
        <form action="/mart" method="get" className="mt-5 flex max-w-xl gap-2">
          {category && <input type="hidden" name="category" value={category} />}
          <input
            type="search"
            name="query"
            defaultValue={query ?? ''}
            placeholder={t('search_placeholder')}
            aria-label={t('search_btn')}
            className="field-control flex-1 border-brass/60 bg-ivory"
          />
          <button type="submit" className="rounded-button bg-emerald px-5 text-sm font-semibold text-ivory hover:bg-emerald-ink">
            {t('search_btn')}
          </button>
        </form>
      </JaaliHeader>

      <div className="mx-auto max-w-6xl px-4 py-6">
        <nav aria-label={t('categories')} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2">
          <Link
            href={'/mart' as '/services'}
            className={`chip-toggle shrink-0 ${!category ? 'border-emerald bg-emerald text-ivory' : 'border-brass/50 bg-ivory text-emerald-ink'}`}
            aria-pressed={!category}
          >
            {t('all_categories')}
          </Link>
          {categories.map((c) => (
            <Link
              key={c.slug}
              href={`/mart?category=${c.slug}` as '/services'}
              aria-pressed={category === c.slug}
              aria-disabled={c.bis_blocked}
              className={`chip-toggle shrink-0 ${
                c.bis_blocked
                  ? 'pointer-events-none border-border text-foreground-secondary opacity-60'
                  : category === c.slug
                    ? 'border-emerald bg-emerald text-ivory'
                    : 'border-brass/50 bg-ivory text-emerald-ink'
              }`}
              title={c.bis_blocked ? t('blocked_category') : undefined}
            >
              {pickLocale(c.name_i18n, locale)}
            </Link>
          ))}
        </nav>

        <p className="mt-4 text-sm text-foreground-secondary">{t('results_count', { count: result.total })}</p>

        {result.products.length === 0 ? (
          <div className="jaali-ivory mt-4 rounded-[10px] border border-brass/40 px-6 py-16 text-center">
            <h2 className="text-lg font-semibold text-emerald-ink">{t('no_products_title')}</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-foreground-secondary">{t('no_products_body')}</p>
          </div>
        ) : (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {result.products.map((p) => (
              <li key={p.id}>
                <ProductCard product={p} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
