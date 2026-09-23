import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getTranslations, getLocale } from 'next-intl/server'
import { Check, X, Clock, RefreshCw, BadgeCheck, FileText, ChevronRight } from 'lucide-react'
import { rfqFieldLabel } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { PriceBlock } from '@/components/catalog/PriceBlock'
import { Stars } from '@/components/catalog/Stars'
import { JsonLd } from '@/components/catalog/JsonLd'
import { getPackageDetail } from '@/lib/catalog/queries'
import { getPackageExtras } from '@/lib/catalog/package-groups'
import { getSiteUrl } from '@/lib/site-url'
import { pickI18n, initials, formatINR } from '@/lib/format'
import { isOnForEveryone } from '@/lib/experiments'
import { TierProvider, type BuyOption } from '@/components/packages-v3/TierContext'
import { BuyBox, StickyBuyBar, TierTabs } from '@/components/packages-v3/BuyBox'
import { PackageTierMatrix } from '@/components/packages-v3/TierMatrix'
import { RecentViewTracker } from '@/components/recent-v3/RecentViewTracker'

export const revalidate = 300

interface RequirementField {
  name: string
  type: string
  label_en?: string
  label_hi?: string
  required?: boolean
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ providerSlug: string; packageSlug: string }>
}): Promise<Metadata> {
  const { providerSlug, packageSlug } = await params
  const detail = await getPackageDetail(providerSlug, packageSlug)
  if (!detail) return {}
  const title = pickI18n(detail.pkg.titleI18n, 'en')
  return {
    title: `${title} — ${detail.provider.displayName}`,
    description: `${title} by ${detail.provider.displayName}. Transparent pricing, verified provider on AMClub.`,
    alternates: { canonical: `/p/${providerSlug}/${packageSlug}` },
  }
}

export default async function PackageDetailPage({
  params,
}: {
  params: Promise<{ providerSlug: string; packageSlug: string }>
}) {
  const { providerSlug, packageSlug } = await params
  const detail = await getPackageDetail(providerSlug, packageSlug)
  if (!detail) notFound()

  const { provider, pkg } = detail
  const t = await getTranslations('catalog')
  const tv = await getTranslations('packages_v3')
  const locale = await getLocale()
  const title = pickI18n(pkg.titleI18n, locale)
  const appUrl = getSiteUrl()
  // Experience v3 E4 (flag `packages`; static page → "on" only): tiers, the
  // price equation, refund + government lines. Off → the page as before.
  const v3 = isOnForEveryone('packages')
  const extras = v3 ? await getPackageExtras(pkg) : null

  const reqFields: RequirementField[] =
    (pkg.requirementsTemplate as { fields?: RequirementField[] } | null)?.fields ?? []

  // Buy Now → checkout. The (msme) layout auth-walls logged-out users to /login
  // and returns them here after OTP.
  const buyHref = `/app/checkout/${pkg.id}`

  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: title,
    serviceType: pickI18n(pkg.categoryNameI18n, locale),
    provider: {
      '@type': 'LocalBusiness',
      name: provider.displayName,
      url: `${appUrl}/p/${provider.slug}`,
    },
    areaServed: 'IN',
    offers: {
      '@type': 'Offer',
      priceCurrency: 'INR',
      price: Math.round(pkg.display.taxablePaise / 100),
      url: `${appUrl}/p/${provider.slug}/${pkg.slug}`,
      availability: 'https://schema.org/InStock',
    },
  }

  // One purchasable option per tier (or just this package), priced on the server.
  const options: BuyOption[] = extras?.tiers
    ? extras.tiers.tiers.map((o) => ({
        packageId: o.packageId,
        slug: o.slug,
        tier: o.tier,
        title: pickI18n(o.titleI18n, locale),
        idealFor: o.idealForI18n ? pickI18n(o.idealForI18n, locale) : null,
        compareValues: o.compareValues,
        deliveryDays: o.deliveryDays,
        revisionCount: o.revisionCount,
        display: o.display,
        govtDependent: o.govtDependent,
      }))
    : [{
        packageId: pkg.id,
        slug: pkg.slug,
        tier: null,
        title,
        idealFor: null,
        compareValues: {},
        deliveryDays: pkg.deliveryDays,
        revisionCount: pkg.revisionCount,
        display: pkg.display,
        govtDependent: extras?.govtDependent ?? false,
      }]

  const body = (
    // pb-28 below lg keeps the last section clear of the sticky buy bar.
    <div className="mx-auto max-w-5xl px-4 pb-28 pt-8 lg:pb-8">
      <JsonLd data={jsonLd} />
      {isOnForEveryone('search') && <RecentViewTracker kind="package" id={pkg.id} title={title} href={`/p/${provider.slug}/${pkg.slug}`} />}

      {/* Breadcrumb */}
      <nav className="mb-4 flex flex-wrap items-center gap-1 text-xs text-foreground-secondary">
        <Link href="/services" className="hover:text-primary">{t('all_services')}</Link>
        <ChevronRight className="h-3 w-3" />
        {pkg.categorySlug && (
          <>
            <Link href={`/services/${pkg.categorySlug}`} className="hover:text-primary">
              {pickI18n(pkg.categoryNameI18n, locale)}
            </Link>
            <ChevronRight className="h-3 w-3" />
          </>
        )}
        <span className="truncate text-foreground">{title}</span>
      </nav>

      <div className="grid gap-8 lg:grid-cols-3">
        {/* Main */}
        <div className="space-y-8 lg:col-span-2">
          <div>
            <h1 className="font-display text-2xl font-bold leading-tight">{title}</h1>
            <Link
              href={`/p/${provider.slug}`}
              className="mt-3 inline-flex items-center gap-2 text-sm text-foreground-secondary hover:text-primary"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                {initials(provider.displayName)}
              </span>
              <span className="font-medium text-foreground">{provider.displayName}</span>
              {provider.badges.length > 0 && <BadgeCheck className="h-4 w-4 text-trust" />}
              <Stars rating={provider.avgRating} count={provider.reviewCount} />
            </Link>
            {extras?.tiers && <TierTabs className="mt-4 w-full lg:hidden" />}
          </div>

          {extras?.tiers && (
            <section>
              <h2 className="font-display text-lg font-bold">{tv('compare_tiers')}</h2>
              <PackageTierMatrix
                rows={extras.tiers.compareRows.map((r) => ({ key: r.key, label: pickI18n(r.labelI18n, locale) }))}
              />
            </section>
          )}

          {/* Scope */}
          <section>
            <h2 className="font-display text-lg font-bold">{t('whats_included')}</h2>
            <ul className="mt-3 space-y-2">
              {pkg.scopeIncluded.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            {pkg.scopeExcluded.length > 0 && (
              <ul className="mt-3 space-y-2">
                {pkg.scopeExcluded.map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-foreground-secondary">
                    <X className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Deliverables */}
          {pkg.deliverables.length > 0 && (
            <section>
              <h2 className="font-display text-lg font-bold">{t('deliverables')}</h2>
              <ul className="mt-3 space-y-2">
                {pkg.deliverables.map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* What we'll need from you */}
          {reqFields.length > 0 && (
            <section>
              <h2 className="font-display text-lg font-bold">{t('requirements')}</h2>
              <ul className="mt-3 space-y-2">
                {reqFields.map((f) => (
                  <li key={f.name} className="flex items-start gap-2 text-sm text-foreground-secondary">
                    <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-foreground-secondary" />
                    <span>
                      {rfqFieldLabel(f, locale) || f.name}
                      {f.required && <span className="text-danger"> *</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* FAQs */}
          {pkg.faqs.length > 0 && (
            <section>
              <h2 className="font-display text-lg font-bold">{t('faqs')}</h2>
              <div className="mt-3 space-y-3">
                {pkg.faqs.map((f, i) => (
                  <details key={i} className="rounded-card border border-border bg-surface p-4">
                    <summary className="cursor-pointer text-sm font-medium">{f.q}</summary>
                    <p className="mt-2 text-sm text-foreground-secondary">{f.a}</p>
                  </details>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Buy box */}
        <aside className="lg:col-span-1">
          {v3 ? (
            <BuyBox buyNote={t('buy_now_note')} />
          ) : (
            <div className="sticky top-20 rounded-card border border-border bg-surface p-5 shadow-card">
              <PriceBlock display={pkg.display} size="detail" />
              <dl className="mt-4 space-y-2 border-t border-border pt-4 text-sm">
                <div className="flex items-center justify-between">
                  <dt className="inline-flex items-center gap-1.5 text-foreground-secondary">
                    <Clock className="h-4 w-4" /> {t('delivery_time')}
                  </dt>
                  <dd className="font-medium">{t('delivery_days', { days: pkg.deliveryDays })}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="inline-flex items-center gap-1.5 text-foreground-secondary">
                    <RefreshCw className="h-4 w-4" /> {t('revisions_label')}
                  </dt>
                  <dd className="font-medium">{pkg.revisionCount}</dd>
                </div>
              </dl>
              <Link
                href={buyHref}
                className="mt-5 block w-full rounded-button bg-primary px-4 py-3 text-center font-semibold text-white transition-colors hover:bg-primary/90"
              >
                {t('buy_now')}
              </Link>
              <p className="mt-2 text-center text-xs text-foreground-secondary">{t('buy_now_note')}</p>
            </div>
          )}
        </aside>
      </div>

      {v3 ? (
        <StickyBuyBar />
      ) : (
        <>
          {/* E0 / U3 — on phones the buy box sits below the FAQs, so a sticky bar
              keeps the price and Buy now in reach. Hidden from lg up, where the
              sticky aside does the job. */}
          <div
            className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface px-4 pt-3 shadow-card lg:hidden"
            style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
          >
            <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-display text-lg font-bold leading-none tabular-nums">{t('price_plus_gst', { price: formatINR(pkg.display.taxablePaise) })}</p>
                <p className="mt-1 truncate text-xs text-foreground-secondary">{t('delivery_days', { days: pkg.deliveryDays })}</p>
              </div>
              <Link
                href={buyHref}
                className="shrink-0 rounded-button bg-primary px-5 py-3 text-center font-semibold text-white transition-colors hover:bg-primary/90"
              >
                {t('buy_now')}
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  )

  return v3 ? (
    <TierProvider options={options} initialPackageId={pkg.id} mostChosen={extras?.tiers?.mostChosen ?? null}>
      {body}
    </TierProvider>
  ) : (
    body
  )
}
