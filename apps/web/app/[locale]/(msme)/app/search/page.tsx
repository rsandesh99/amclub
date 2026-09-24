import { TrustStrip } from '@/components/usp/TrustStrip'
import { getTranslations } from 'next-intl/server'
import { SearchBar } from '@/components/catalog/SearchBar'
import { ListingControls } from '@/components/catalog/ListingControls'
import { CatalogResults } from '@/components/catalog/CatalogResults'
import { CategoryGrid } from '@/components/catalog/CategoryGrid'
import { getCategories } from '@/lib/catalog/queries'
import { parseFilters, hasActiveFilters } from '@/lib/catalog/filters'
import { hasNarrowingV2, parseSearchV2 } from '@amclub/shared'
import { getSessionUser } from '@/lib/auth/session'
import { isOnFor } from '@/lib/experiments'
import { SearchResultsV3 } from '@/components/search-v3/SearchResultsV3'
import { isVoiceSearchOn } from '@/lib/voice/search'
import { MART_ENABLED } from '@/lib/flags'
import { ModeSwitch } from '@/components/mart/ModeSwitch'

export default async function AppSearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const t = await getTranslations('catalog')
  const user = await getSessionUser()
  // Experience v3 E2 (flag `search`, per user).
  const v3 = isOnFor('search', user?.id)
  const search = parseSearchV2(sp)
  const searching = v3 ? Boolean(search.query || search.category || search.sort || hasNarrowingV2(search)) : hasActiveFilters(sp)
  const categories = searching ? [] : await getCategories()

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-surface px-4 py-3">
        <div className={v3 ? 'mx-auto max-w-[1280px]' : 'mx-auto max-w-3xl'}>
          <h1 className="font-display text-lg font-bold">{t('search_title')}</h1>
        </div>
      </header>
      <div className={v3 ? 'mx-auto max-w-[1280px] px-4 py-6' : 'mx-auto max-w-3xl px-4 py-6'}>
        <div className="mb-6">
          {/* E16 N39 — Services | Goods, only with the Mart flag on. */}
          {MART_ENABLED && <div className="mb-3"><ModeSwitch mode="services" query={sp['query']} servicesPath="/app/search" /></div>}
          <SearchBar defaultValue={sp['query'] ?? ''} action="/app/search" voice={v3 && (await isVoiceSearchOn())} />
          {/* E18 (flag `guide`): the four buyer promises, before the first click. */}
          {isOnFor('guide', user?.id) && <TrustStrip className="mt-3" />}
        </div>
        {searching && v3 ? (
          <SearchResultsV3 search={search} basePath="/app/search" youSaid={sp['voice'] === '1' ? search.query : undefined} />
        ) : searching ? (
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
