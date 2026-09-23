import { getTranslations } from 'next-intl/server'
import type { Metadata } from 'next'
import { BannerSlot } from '@/components/cms/BannerSlot'
import { SearchBar } from '@/components/catalog/SearchBar'
import { CategoryGrid } from '@/components/catalog/CategoryGrid'
import { ListingControls } from '@/components/catalog/ListingControls'
import { CatalogResults } from '@/components/catalog/CatalogResults'
import { getCategories } from '@/lib/catalog/queries'
import { parseFilters, hasActiveFilters } from '@/lib/catalog/filters'
import { hasNarrowingV2, parseSearchV2 } from '@amclub/shared'
import { isOnForEveryone } from '@/lib/experiments'
import { SearchResultsV3 } from '@/components/search-v3/SearchResultsV3'
import { isVoiceSearchOn } from '@/lib/voice/search'
import { MART_ENABLED } from '@/lib/flags'
import { ModeSwitch } from '@/components/mart/ModeSwitch'

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
  // Experience v3 E2 (flag `search`): search v2 with facets, list view, feedback.
  const v3 = isOnForEveryone('search')
  const search = parseSearchV2(sp)
  const searching = v3 ? Boolean(search.query || search.category || search.sort || hasNarrowingV2(search)) : hasActiveFilters(sp)

  return (
    <div className={v3 ? 'mx-auto max-w-[1280px] px-4 py-8' : 'mx-auto max-w-6xl px-4 py-8'}>
      {/* CMS hero slot — the gateway replaced the old landing page, so /services
          is now the public home for campaign banners. */}
      <BannerSlot slot="hero" className="mb-6 space-y-3" />
      <div className="mb-6">
        <h1 className="font-display text-2xl font-bold">{t('all_services')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('all_services_desc')}</p>
      </div>

      <div className="mb-8 max-w-2xl">
        {/* E16 N39 — Services | Goods, only with the Mart flag on. */}
        {MART_ENABLED && <div className="mb-3"><ModeSwitch mode="services" query={sp['query']} /></div>}
        <SearchBar defaultValue={sp['query'] ?? ''} voice={v3 && (await isVoiceSearchOn())} />
      </div>

      {searching && v3 ? (
        <SearchResultsV3 search={search} basePath="/services" youSaid={sp['voice'] === '1' ? search.query : undefined} />
      ) : searching ? (
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
