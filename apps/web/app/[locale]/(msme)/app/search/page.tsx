import { getTranslations } from 'next-intl/server'
import { SearchBar } from '@/components/catalog/SearchBar'
import { ListingControls } from '@/components/catalog/ListingControls'
import { CatalogResults } from '@/components/catalog/CatalogResults'
import { CategoryGrid } from '@/components/catalog/CategoryGrid'
import { getCategories } from '@/lib/catalog/queries'
import { parseFilters, hasActiveFilters } from '@/lib/catalog/filters'

export default async function AppSearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const t = await getTranslations('catalog')
  const searching = hasActiveFilters(sp)
  const categories = searching ? [] : await getCategories()

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-surface px-4 py-3">
        <div className="mx-auto max-w-3xl">
          <h1 className="font-display text-lg font-bold">{t('search_title')}</h1>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-6">
          <SearchBar defaultValue={sp['query'] ?? ''} action="/app/search" />
        </div>
        {searching ? (
          <div className="space-y-5">
            <ListingControls />
            <CatalogResults filters={parseFilters(sp)} basePath="/app/search" searchParams={sp} />
          </div>
        ) : (
          <CategoryGrid categories={categories} />
        )}
      </div>
    </div>
  )
}
