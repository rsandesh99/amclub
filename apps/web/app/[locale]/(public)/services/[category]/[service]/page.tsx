import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'
import { CATEGORY_SLUGS, formatStatPct, isSpecializationOf, parseSearchV2, SPECIALIZATIONS, type CategorySlug } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { getCategoryBySlug } from '@/lib/catalog/queries'
import { searchCatalogV2 } from '@/lib/catalog/search-v2'
import { cardTrustFor } from '@/lib/trust/card-trust'
import { isOnForEveryone } from '@/lib/experiments'
import { formatINR, formatResponseTime, pickI18n } from '@/lib/format'
import { ProviderCredential } from '@/components/catalog/ProviderCredential'
import { SearchResultsV3 } from '@/components/search-v3/SearchResultsV3'
import { ServicePageViewed } from '@/components/search-v3/ServicePageViewed'
import type { CatalogResult } from '@/lib/catalog/types'

export function generateStaticParams() {
  return CATEGORY_SLUGS.flatMap((category) => SPECIALIZATIONS[category].map((service) => ({ category, service })))
}

export async function generateMetadata({ params }: { params: Promise<{ category: string; service: string; locale: string }> }): Promise<Metadata> {
  const { category, service } = await params
  if (!isSpecializationOf(category as CategorySlug, service)) return {}
  const t = await getTranslations('services')
  const th = await getTranslations('service_page')
  const name = t(service as 'gst-filing')
  return { title: name, description: th('meta_description', { service: name }), alternates: { canonical: `/services/${category}/${service}` } }
}

/** One row per provider: their lowest price for this service and their facts. */
function providerRows(results: CatalogResult[]) {
  const by = new Map<string, { r: CatalogResult; fromPaise: number; fastest: number }>()
  for (const r of results) {
    const cur = by.get(r.providerId)
    if (!cur) by.set(r.providerId, { r, fromPaise: r.display.taxablePaise, fastest: r.deliveryDays })
    else {
      if (r.display.taxablePaise < cur.fromPaise) { cur.fromPaise = r.display.taxablePaise; cur.r = r }
      cur.fastest = Math.min(cur.fastest, r.deliveryDays)
    }
  }
  return [...by.values()].slice(0, 8)
}

/**
 * Experience v3 E2b FR-2.3 — a level-2 service landing page (flag `search`):
 * a hero line, a dense provider comparison for this service (provider,
 * credential, from-price + GST, delivery, on-time when D1 is on, replies,
 * rating), then the filterable results.
 */
export default async function ServicePage({
  params,
  searchParams,
}: {
  params: Promise<{ category: string; service: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  // Read the request first so the page is always rendered per request.
  const sp = await searchParams
  const { category, service } = await params
  if (!isOnForEveryone('search')) notFound()
  if (!isSpecializationOf(category as CategorySlug, service)) notFound()
  const cat = await getCategoryBySlug(category)
  if (!cat) notFound()
  const locale = await getLocale()
  const t = await getTranslations('service_page')
  const ts = await getTranslations('services')
  const tc = await getTranslations('catalog')
  const tf = await getTranslations('filters_v3')
  const name = ts(service as 'gst-filing')

  const top = await searchCatalogV2({ category, service, sort: 'best' }, { withFacets: false })
  const rows = providerRows(top.results)
  const trust = isOnForEveryone('trust') ? await cardTrustFor(rows.map((x) => x.r.providerId)) : null

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8">
      <ServicePageViewed service={service} />
      <nav className="mb-4 flex flex-wrap items-center gap-1.5 text-xs text-foreground-secondary">
        <Link href="/services" className="hover:text-primary">{tc('all_services')}</Link>
        <span aria-hidden>/</span>
        <Link href={`/services/${category}`} className="hover:text-primary">{pickI18n(cat.nameI18n, locale)}</Link>
        <span aria-hidden>/</span>
        <span className="text-foreground">{name}</span>
      </nav>
      <h1 className="t-large-title">{name}</h1>
      <p className="mt-2 max-w-2xl text-foreground-secondary" data-testid="service-hero">
        {top.total > 0 ? t('hero', { service: name, n: rows.length }) : t('hero_empty', { service: name })}
      </p>

      {rows.length > 0 && (
        <section className="mt-6" aria-labelledby="svc-compare">
          <h2 id="svc-compare" className="t-headline mb-2">{t('compare_heading')}</h2>
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[44rem] border-separate border-spacing-0 text-sm" data-testid="service-provider-table" data-density="compact">
              <thead>
                <tr className="text-left text-xs text-foreground-secondary">
                  <th scope="col" className="border-b border-separator py-2 pr-3 font-medium">{tf('col_provider')}</th>
                  <th scope="col" className="border-b border-separator px-3 py-2 font-medium">{t('col_from')}</th>
                  <th scope="col" className="border-b border-separator px-3 py-2 font-medium">{tf('col_delivery')}</th>
                  <th scope="col" className="border-b border-separator px-3 py-2 font-medium">{tf('col_on_time')}</th>
                  <th scope="col" className="border-b border-separator px-3 py-2 font-medium">{tf('col_replies')}</th>
                  <th scope="col" className="border-b border-separator px-3 py-2 font-medium">{tf('col_rating')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ r, fromPaise, fastest }) => {
                  const stat = trust?.get(r.providerId)?.stat
                  return (
                    <tr key={r.providerId}>
                      <td className="border-b border-separator py-2.5 pr-3">
                        <Link href={`/p/${r.providerSlug}/${r.packageSlug}`} className="hover:text-primary">
                          <ProviderCredential name={r.displayName} credentialKind={r.headlineCredential} verified={r.verified} />
                        </Link>
                      </td>
                      <td className="border-b border-separator px-3 py-2.5 font-semibold tabular-nums">{tc('price_plus_gst', { price: formatINR(fromPaise) })}</td>
                      <td className="border-b border-separator px-3 py-2.5 tabular-nums">{tc('delivery_days', { days: fastest })}</td>
                      <td className="border-b border-separator px-3 py-2.5 tabular-nums">
                        {stat?.kind === 'on_time' ? tc('stat_on_time_short', { pct: formatStatPct(stat.value.pct), n: stat.value.n }) : '—'}
                      </td>
                      <td className="border-b border-separator px-3 py-2.5 tabular-nums">{formatResponseTime(r.medianResponseMinutes) ?? '—'}</td>
                      <td className="border-b border-separator px-3 py-2.5 tabular-nums">{r.reviewCount > 0 ? `★ ${r.avgRating.toFixed(1)} (${r.reviewCount})` : tc('new')}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="mt-8">
        <SearchResultsV3 search={parseSearchV2(sp)} basePath={`/services/${category}/${service}`} fixedCategory={category} fixedService={service} />
      </div>
    </div>
  )
}
