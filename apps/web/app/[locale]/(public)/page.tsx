import { getTranslations, getLocale } from 'next-intl/server'
import { ShieldCheck, IndianRupee, Search as SearchIcon, ArrowRight, Sparkles } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { SearchBar } from '@/components/catalog/SearchBar'
import { CategoryGrid } from '@/components/catalog/CategoryGrid'
import { ProviderMiniCard } from '@/components/catalog/ProviderMiniCard'
import { getCategories, getTopRatedProviders } from '@/lib/catalog/queries'
import { BannerSlot } from '@/components/cms/BannerSlot'
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
  // (The search bar is the hero's primary action, so no CTA button here — the
  // CMS ctaLabel/ctaHref still drive hero-variant banners in other slots.)
  const adminHero = heroBanners.find((b) => b.variant === 'hero') ?? null
  const hero = {
    headline: adminHero?.headline ? pickI18n(adminHero.headline, locale) : t('hero_promo_headline'),
    subline: adminHero?.subline ? pickI18n(adminHero.subline, locale) : t('hero_promo_subline'),
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

  const discountPct = hero.discountPct ?? 0
  const showDiscount = discountPct > 0

  return (
    <>
      {/* ── Hero — "Confident Marketplace": one full-bleed green band with a
          marigold eyebrow, centered search, popular quick-searches, and the
          trust stats ON the green. Headline/subline + the discount figure are
          CMS-driven (A6); the discount stays backable by the live catalog. ── */}
      <section className="relative overflow-hidden bg-primary text-white">
        <div aria-hidden className="pointer-events-none absolute -right-28 -top-32 h-[420px] w-[420px] rounded-full bg-accent/25 blur-[60px]" />
        <div aria-hidden className="pointer-events-none absolute -bottom-40 left-1/4 h-[360px] w-[360px] rounded-full bg-white/[0.06] blur-[60px]" />

        <div className="relative mx-auto max-w-6xl px-4 pb-10 pt-14 text-center sm:pt-16">
          {showDiscount && (
            <span className="inline-flex items-center gap-1.5 rounded-chip bg-accent px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider text-accent-foreground shadow-xs">
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              {t('hero_eyebrow', { pct: discountPct })}
            </span>
          )}
          <h1 className="mx-auto mt-5 max-w-3xl font-display text-3xl font-bold leading-[1.08] tracking-tight sm:text-5xl">
            {hero.headline}
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-md text-white/85">{hero.subline}</p>
          <div className="mx-auto mt-8 max-w-2xl">
            <SearchBar size="lg" />
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs">
            <span className="text-white/70">{t('popular')}:</span>
            {categories.slice(0, 5).map((c) => (
              <Link
                key={c.slug}
                href={`/services/${c.slug}`}
                className="inline-flex items-center rounded-chip border border-white/30 bg-white/15 px-3.5 py-1.5 font-medium leading-none text-white transition-colors hover:border-white/50 hover:bg-white/25"
              >
                {locale === 'hi' && c.nameI18n.hi ? c.nameI18n.hi : c.nameI18n.en}
              </Link>
            ))}
          </div>
        </div>

        {/* Trust stats ON the green (proof-points are the decoration §4.1) */}
        <div className="relative border-t border-white/15">
          <div className="mx-auto grid max-w-5xl grid-cols-2 gap-6 px-4 py-6 sm:grid-cols-4">
            {stats.map((s) => (
              <div key={s.label} className="text-center">
                <div className="font-display text-2xl font-bold tabular-nums text-white">{s.value}</div>
                <div className="mt-1 text-xs text-white/75">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CMS promotional banners (A6) */}
      <BannerSlot slot="home_hero" />

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

      {/* How it works — on a faint brand wash, numbered 01·02·03 */}
      <section className="border-y border-border bg-primary/[0.04]">
        <div className="mx-auto max-w-5xl px-4 py-14">
          <h2 className="text-center font-display text-2xl font-bold">{t('how_title')}</h2>
          <div className="mt-10 grid gap-8 sm:grid-cols-3">
            {steps.map((s, i) => (
              <div key={i} className="flex flex-col items-center gap-3 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-card bg-primary-soft text-primary">
                  <s.icon className="h-6 w-6" />
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-display text-md font-bold tabular-nums text-primary/50">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <h3 className="text-md font-semibold">{s.title}</h3>
                </div>
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

      {/* Provider CTA — green panel with a soft marigold glow + accent action */}
      <section className="mx-auto max-w-6xl px-4 pb-16 pt-4">
        <div className="relative flex flex-col items-center gap-4 overflow-hidden rounded-card bg-primary px-6 py-10 text-center text-white shadow-lg sm:flex-row sm:justify-between sm:text-left">
          <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-accent/20 blur-[50px]" />
          <div className="relative">
            <h2 className="font-display text-xl font-bold">{t('provider_cta_title')}</h2>
            <p className="mt-1 max-w-lg text-sm text-white/80">{t('provider_cta_body')}</p>
          </div>
          <Link
            href="/partner/signup"
            className="relative inline-flex shrink-0 items-center gap-2 rounded-button bg-accent px-5 py-3 font-semibold text-accent-foreground shadow-xs transition hover:bg-accent/90 hover:shadow-hover active:shadow-pressed motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-primary"
          >
            {t('provider_cta_btn')} <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </>
  )
}
