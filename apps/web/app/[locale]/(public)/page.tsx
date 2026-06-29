import { getTranslations, getLocale } from 'next-intl/server'
import { ShieldCheck, IndianRupee, Search as SearchIcon, ArrowRight } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { SearchBar } from '@/components/catalog/SearchBar'
import { CategoryGrid } from '@/components/catalog/CategoryGrid'
import { ProviderMiniCard } from '@/components/catalog/ProviderMiniCard'
import { getCategories, getTopRatedProviders } from '@/lib/catalog/queries'
import { BannerSlot } from '@/components/cms/BannerSlot'
import { HeroBanner } from '@/components/cms/HeroBanner'
import { getActiveBanners, getMaxDiscountPct } from '@/lib/cms/queries'
import { pickI18n } from '@/lib/format'

// ISR — landing refreshes hourly (§ Phase 3 SEO).
export const revalidate = 3600

export default async function LandingPage() {
  const t = await getTranslations('landing')
  const tCat = await getTranslations('catalog')
  const locale = await getLocale()
  const heroLocale = locale === 'hi' ? 'hi' : 'en'
  const [categories, topProviders, heroBanners, maxDiscountPct] = await Promise.all([
    getCategories(),
    getTopRatedProviders(8),
    getActiveBanners('hero', heroLocale),
    getMaxDiscountPct(),
  ])

  // Hero copy + discount come from the CMS `hero` slot when an admin has set
  // one; otherwise fall back to default i18n copy with the REAL catalog max
  // discount so the "up to X%" claim is always backable (item 8 trust rule).
  const adminHero = heroBanners.find((b) => b.variant === 'hero') ?? null
  const hero = {
    headline: adminHero?.headline ? pickI18n(adminHero.headline, locale) : t('hero_promo_headline'),
    subline: adminHero?.subline ? pickI18n(adminHero.subline, locale) : t('hero_promo_subline'),
    ctaLabel: adminHero?.ctaLabel ? pickI18n(adminHero.ctaLabel, locale) : t('hero_promo_cta'),
    ctaHref: adminHero?.ctaHref || '/services',
    discountPct: adminHero ? adminHero.discountPct : maxDiscountPct,
  }

  const stats = [
    { value: '6.3 Cr+', label: t('stat_msmes') },
    { value: '8', label: t('stat_categories') },
    { value: '100%', label: t('stat_verified') },
    { value: '₹', label: t('stat_transparent') },
  ]

  const steps = [
    { icon: SearchIcon, title: t('step1_title'), body: t('step1_body') },
    { icon: ShieldCheck, title: t('step2_title'), body: t('step2_body') },
    { icon: IndianRupee, title: t('step3_title'), body: t('step3_body') },
  ]

  return (
    <>
      {/* Promotional hero banner (CMS-driven, A6) — copy/discount/CTA editable
          from /admin/cms; honest default discount from the live catalog. */}
      <HeroBanner
        headline={hero.headline}
        subline={hero.subline}
        ctaLabel={hero.ctaLabel}
        ctaHref={hero.ctaHref}
        discountPct={hero.discountPct}
      />

      {/* Search hero */}
      <section className="bg-gradient-to-b from-primary/5 to-background">
        <div className="mx-auto max-w-4xl px-4 py-14 text-center sm:py-20">
          <h1 className="font-display text-2xl font-bold leading-tight text-foreground sm:text-[40px] sm:leading-[1.1]">
            {t('hero_title')}
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-md text-foreground-secondary">
            {t('hero_subtitle')}
          </p>
          <div className="mx-auto mt-8 max-w-2xl">
            <SearchBar size="lg" />
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs text-foreground-secondary">
            <span>{t('popular')}:</span>
            {categories.slice(0, 4).map((c) => (
              <Link
                key={c.slug}
                href={`/services/${c.slug}`}
                className="rounded-chip border border-border bg-surface px-2.5 py-1 hover:border-primary/40 hover:text-primary"
              >
                {locale === 'hi' && c.nameI18n.hi ? c.nameI18n.hi : c.nameI18n.en}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* CMS promotional banners (A6) */}
      <BannerSlot slot="home_hero" />

      {/* Trust stats */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto grid max-w-5xl grid-cols-2 gap-6 px-4 py-8 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="text-center">
              <div className="font-display text-2xl font-bold text-primary">{s.value}</div>
              <div className="mt-1 text-xs text-foreground-secondary">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Categories */}
      <section className="mx-auto max-w-6xl px-4 py-12">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h2 className="font-display text-xl font-bold">{t('categories_title')}</h2>
            <p className="mt-1 text-sm text-foreground-secondary">{t('categories_subtitle')}</p>
          </div>
          <Link href="/services" className="text-sm font-medium text-primary hover:underline">
            {tCat('view_all')}
          </Link>
        </div>
        <CategoryGrid categories={categories} />
      </section>

      {/* How it works */}
      <section className="bg-surface">
        <div className="mx-auto max-w-5xl px-4 py-12">
          <h2 className="text-center font-display text-xl font-bold">{t('how_title')}</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            {steps.map((s, i) => (
              <div key={i} className="flex flex-col items-center gap-3 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <s.icon className="h-6 w-6" />
                </div>
                <div className="text-xs font-bold text-accent-foreground">
                  <span className="rounded-chip bg-accent/15 px-2 py-0.5">{i + 1}</span>
                </div>
                <h3 className="font-semibold">{s.title}</h3>
                <p className="max-w-xs text-sm text-foreground-secondary">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Top-rated providers */}
      {topProviders.length > 0 && (
        <section className="mx-auto max-w-6xl px-4 py-12">
          <div className="mb-6 flex items-end justify-between">
            <h2 className="font-display text-xl font-bold">{t('top_rated_title')}</h2>
            <Link href="/services" className="text-sm font-medium text-primary hover:underline">
              {tCat('view_all')}
            </Link>
          </div>
          <div className="flex gap-4 overflow-x-auto pb-2 [scrollbar-width:thin]">
            {topProviders.map((p) => (
              <ProviderMiniCard key={p.id} provider={p} />
            ))}
          </div>
        </section>
      )}

      {/* Provider CTA */}
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <div className="flex flex-col items-center gap-4 rounded-card bg-primary px-6 py-10 text-center text-white sm:flex-row sm:justify-between sm:text-left">
          <div>
            <h2 className="font-display text-xl font-bold">{t('provider_cta_title')}</h2>
            <p className="mt-1 max-w-lg text-sm text-white/80">{t('provider_cta_body')}</p>
          </div>
          <Link
            href="/partner/signup"
            className="inline-flex shrink-0 items-center gap-2 rounded-button bg-accent px-5 py-3 font-semibold text-accent-foreground hover:bg-accent/90"
          >
            {t('provider_cta_btn')} <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </>
  )
}
