import { getTranslations } from 'next-intl/server'
import type { Metadata } from 'next'
import { SearchBar } from '@/components/catalog/SearchBar'
import { CategoryGrid } from '@/components/catalog/CategoryGrid'
import { ListingControls } from '@/components/catalog/ListingControls'
import { CatalogResults } from '@/components/catalog/CatalogResults'
import { getCategories } from '@/lib/catalog/queries'
import { parseFilters, hasActiveFilters } from '@/lib/catalog/filters'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('catalog')
  return { title: t('all_services'), description: t('all_services_desc') }
}

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const t = await getTranslations('catalog')
  const categories = await getCategories()
  const searching = hasActiveFilters(sp)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="font-display text-2xl font-bold">{t('all_services')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('all_services_desc')}</p>
      </div>

      <div className="mb-8 max-w-2xl">
        <SearchBar defaultValue={sp['query'] ?? ''} />
      </div>

      {searching ? (
        <div className="space-y-5">
          <ListingControls />
          <CatalogResults
            filters={parseFilters(sp)}
            basePath="/services"
            searchParams={sp}
          />
        </div>
      ) : (
        <CategoryGrid categories={categories} />
      )}
    </div>
  )
}
