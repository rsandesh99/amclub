import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getTranslations, getLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { CategoryIcon } from '@/components/catalog/CategoryIcon'
import { ListingControls } from '@/components/catalog/ListingControls'
import { CatalogResults } from '@/components/catalog/CatalogResults'
import { getCategoryBySlug, getCategories } from '@/lib/catalog/queries'
import { parseFilters } from '@/lib/catalog/filters'
import { pickI18n } from '@/lib/format'
import { CATEGORY_SLUGS } from '@amclub/shared'

// ISR: category pages revalidate hourly (§ Phase 3 SEO).
export const revalidate = 3600

export function generateStaticParams() {
  return CATEGORY_SLUGS.map((category) => ({ category }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ category: string; locale: string }>
}): Promise<Metadata> {
  const { category, locale } = await params
  const cat = await getCategoryBySlug(category)
  if (!cat) return {}
  const name = pickI18n(cat.nameI18n, locale)
  const desc = cat.descriptionI18n ? pickI18n(cat.descriptionI18n, locale) : ''
  return {
    title: name,
    description: desc,
    alternates: { canonical: `/services/${category}` },
    openGraph: { title: `${name} — AMClub`, description: desc, type: 'website' },
  }
}

export default async function CategoryListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ category: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { category } = await params
  const sp = await searchParams
  const cat = await getCategoryBySlug(category)
  if (!cat) notFound()

  const t = await getTranslations('catalog')
  const locale = await getLocale()
  const allCategories = await getCategories()
  const stateLabel = sp['state']

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {/* Breadcrumb */}
      <nav className="mb-4 text-xs text-foreground-secondary">
        <Link href="/services" className="hover:text-primary">
          {t('all_services')}
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-foreground">{pickI18n(cat.nameI18n, locale)}</span>
      </nav>

      {/* Header */}
      <div className="mb-6 flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-button bg-primary/10 text-primary">
          <CategoryIcon icon={cat.icon} className="h-6 w-6" />
        </div>
        <div>
          <h1 className="font-display text-2xl font-bold">{pickI18n(cat.nameI18n, locale)}</h1>
          {cat.descriptionI18n && (
            <p className="mt-1 text-sm text-foreground-secondary">
              {pickI18n(cat.descriptionI18n, locale)}
            </p>
          )}
        </div>
      </div>

      {/* Other categories quick nav */}
      <div className="mb-6 flex flex-wrap gap-2">
        {allCategories
          .filter((c) => c.slug !== category)
          .slice(0, 7)
          .map((c) => (
            <Link
              key={c.slug}
              href={`/services/${c.slug}`}
              className="rounded-chip border border-border bg-surface px-3 py-1 text-xs text-foreground-secondary hover:border-primary/40 hover:text-primary"
            >
              {pickI18n(c.nameI18n, locale)}
            </Link>
          ))}
      </div>

      {/* Filters */}
      <div className="mb-6">
        <ListingControls />
      </div>

      {/* Results */}
      <CatalogResults
        filters={parseFilters(sp, { categorySlug: category })}
        basePath={`/services/${category}`}
        searchParams={sp}
        {...(stateLabel ? { stateLabel } : {})}
      />
    </div>
  )
}
