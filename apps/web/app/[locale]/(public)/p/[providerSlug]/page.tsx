import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getTranslations, getLocale } from 'next-intl/server'
import { BadgeCheck, MapPin, Clock, CheckCircle2, Languages, ShieldCheck } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { VerificationBadges } from '@/components/catalog/VerificationBadges'
import { headlineCredentialKind } from '@/lib/catalog/credential'
import { PriceBlock } from '@/components/catalog/PriceBlock'
import { Stars } from '@/components/catalog/Stars'
import { JsonLd } from '@/components/catalog/JsonLd'
import { SaveButton } from '@/components/catalog/SaveButton'
import { getProviderBySlug, getPackagesForProvider, getReviews } from '@/lib/catalog/queries'
import { getSiteUrl } from '@/lib/site-url'
import { pickI18n, initials, formatResponseTime } from '@/lib/format'
import { INDIAN_STATES } from '@/lib/constants/india'
import { MART_ENABLED } from '@/lib/flags'
import { listPublicProducts } from '@/lib/mart/queries'
import { ProductCard } from '@/components/mart/ProductCard'

export const revalidate = 300

const STATE_LABEL = new Map(INDIAN_STATES.map((s) => [s.value, s.label]))

export async function generateMetadata({
  params,
}: {
  params: Promise<{ providerSlug: string }>
}): Promise<Metadata> {
  const { providerSlug } = await params
  const provider = await getProviderBySlug(providerSlug)
  if (!provider) return {}
  const desc =
    provider.about ??
    `${provider.displayName} — verified service provider on AMClub. ${provider.completedOrders} orders completed.`
  return {
    title: provider.displayName,
    description: desc.slice(0, 160),
    alternates: { canonical: `/p/${providerSlug}` },
    openGraph: {
      title: `${provider.displayName} — AMClub`,
      description: desc.slice(0, 160),
      type: 'profile',
      ...(provider.logoUrl ? { images: [provider.logoUrl] } : {}),
    },
  }
}

export default async function ProviderProfilePage({
  params,
}: {
  params: Promise<{ providerSlug: string }>
}) {
  const { providerSlug } = await params
  const provider = await getProviderBySlug(providerSlug)
  if (!provider) notFound()

  const t = await getTranslations('catalog')
  const locale = await getLocale()
  // Mart (dark build): the goods query and its copy only run when the flag is
  // on — with MART_ENABLED=false the services storefront is byte-identical.
  const [packages, { reviews, total: reviewTotal }, goods, tm] = await Promise.all([
    getPackagesForProvider(provider.id),
    getReviews(provider.id, 10, 0),
    MART_ENABLED ? listPublicProducts({ sellerSlug: providerSlug, limit: 6 }) : Promise.resolve(null),
    MART_ENABLED ? getTranslations('mart') : Promise.resolve(null),
  ])

  const stateLabel = STATE_LABEL.get(provider.state) ?? provider.state
  const responseTime = formatResponseTime(provider.medianResponseMinutes)
  const headlineCredential = headlineCredentialKind(provider.badges.map((b) => b.kind))
  const appUrl = getSiteUrl()

  // schema.org LocalBusiness + aggregateRating + Service offers (§ Phase 3 SEO).
  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: provider.displayName,
    '@id': `${appUrl}/p/${provider.slug}`,
    url: `${appUrl}/p/${provider.slug}`,
    ...(provider.about ? { description: provider.about } : {}),
    ...(provider.logoUrl ? { image: provider.logoUrl } : {}),
    address: { '@type': 'PostalAddress', addressRegion: stateLabel, addressCountry: 'IN' },
    ...(provider.reviewCount > 0
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: provider.avgRating.toFixed(1),
            reviewCount: provider.reviewCount,
            bestRating: '5',
            worstRating: '1',
          },
        }
      : {}),
    makesOffer: packages.map((pk) => ({
      '@type': 'Offer',
      name: pickI18n(pk.titleI18n, locale),
      priceCurrency: 'INR',
      price: Math.round((pk.pricePaise * (1 - pk.discountBps / 10000)) / 100),
      url: `${appUrl}/p/${provider.slug}/${pk.slug}`,
    })),
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <JsonLd data={jsonLd} />

      {/* Header card */}
      <section className="rounded-card border border-border bg-surface p-6 shadow-card">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xl font-bold text-primary">
            {initials(provider.displayName)}
          </div>
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-2xl font-bold">{provider.displayName}</h1>
              {provider.badges.length > 0 && (
                <BadgeCheck className="h-5 w-5 text-trust" aria-label={t('verified')} />
              )}
              {provider.topRated && (
                <span className="rounded-chip bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent-foreground">
                  {t('top_rated')}
                </span>
              )}
            </div>
            {headlineCredential && (
              <p className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-verified">
                <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
                {t(`badge_${headlineCredential}` as 'badge_gstin')} · {t('verified')}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-foreground-secondary">
              <Stars rating={provider.avgRating} count={provider.reviewCount} />
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" /> {stateLabel}
                {provider.city ? `, ${provider.city}` : ''}
              </span>
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" /> {t('orders_done', { count: provider.completedOrders })}
              </span>
              {responseTime && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" /> {t('responds_in', { time: responseTime })}
                </span>
              )}
              {provider.languages.length > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Languages className="h-3.5 w-3.5" /> {provider.languages.map((l) => l.toUpperCase()).join(', ')}
                </span>
              )}
            </div>
            <div className="mt-3">
              <VerificationBadges badges={provider.badges} />
            </div>
          </div>
          <div className="shrink-0">
            <SaveButton providerId={provider.id} returnPath={`/p/${provider.slug}`} />
          </div>
        </div>

        {provider.categories.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
            {provider.categories.map((c) => (
              <Link
                key={c.slug}
                href={`/services/${c.slug}`}
                className="rounded-chip border border-border px-2.5 py-1 text-xs text-foreground-secondary hover:border-primary/40 hover:text-primary"
              >
                {pickI18n(c.nameI18n, locale)}
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* About */}
      {provider.about && (
        <section className="mt-6">
          <h2 className="font-display text-lg font-bold">{t('about')}</h2>
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground-secondary">
            {provider.about}
          </p>
        </section>
      )}

      {/* Packages */}
      <section className="mt-8">
        <h2 className="font-display text-lg font-bold">{t('packages')}</h2>
        {packages.length === 0 ? (
          <p className="mt-2 text-sm text-foreground-secondary">{t('no_packages')}</p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {packages.map((pk) => (
              <Link
                key={pk.slug}
                href={`/p/${provider.slug}/${pk.slug}`}
                className="group flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card transition-colors hover:border-primary/40"
              >
                <h3 className="text-md font-medium leading-snug text-foreground group-hover:text-primary">
                  {pickI18n(pk.titleI18n, locale)}
                </h3>
                <div className="flex items-center gap-2 text-xs text-foreground-secondary">
                  <span className="inline-flex items-center gap-1 rounded-chip bg-muted px-2 py-0.5">
                    <Clock className="h-3 w-3" /> {t('delivery_days', { days: pk.deliveryDays })}
                  </span>
                </div>
                <div className="mt-auto border-t border-border pt-3">
                  <PriceBlock
                    pricePaise={pk.pricePaise}
                    discountBps={pk.discountBps}
                    memberExtraDiscountBps={pk.memberExtraDiscountBps}
                  />
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Goods (AMC Mart) — active products only; nothing renders when the flag is off. */}
      {MART_ENABLED && goods && tm && goods.products.length > 0 && (
        <section className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-lg font-bold">{tm('seller_goods_title', { name: provider.displayName })}</h2>
            <Link href={`/mart?seller=${provider.slug}` as '/services'} className="text-sm font-medium text-primary hover:underline">
              {tm('view_all_goods')}{goods.total > goods.products.length ? ` (${goods.total})` : ''}
            </Link>
          </div>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {goods.products.map((p) => (
              <li key={p.id}>
                <ProductCard product={p} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Reviews */}
      <section className="mt-8">
        <h2 className="font-display text-lg font-bold">
          {t('reviews')} {reviewTotal > 0 && <span className="text-foreground-secondary">({reviewTotal})</span>}
        </h2>
        {reviews.length === 0 ? (
          <p className="mt-2 text-sm text-foreground-secondary">{t('no_reviews')}</p>
        ) : (
          <ul className="mt-4 space-y-4">
            {reviews.map((r) => (
              <li key={r.id} className="rounded-card border border-border bg-surface p-4">
                <div className="flex items-center justify-between">
                  <Stars rating={r.rating} />
                  <span className="text-xs text-foreground-secondary">{t('verified_buyer')}</span>
                </div>
                {r.body && <p className="mt-2 text-sm text-foreground">{r.body}</p>}
                {r.providerReply && (
                  <div className="mt-3 rounded-button bg-muted p-3 text-sm">
                    <span className="font-medium text-primary">{t('provider_reply')}: </span>
                    <span className="text-foreground-secondary">{r.providerReply}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
