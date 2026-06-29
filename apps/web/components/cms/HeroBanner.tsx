import { getTranslations } from 'next-intl/server'
import { Sparkles, ArrowRight } from 'lucide-react'
import { Link } from '@/i18n/navigation'

/**
 * The landing hero promo (item 8). On-brand (#1B4D3E), premium — not a loud
 * sale banner. All copy + the discount figure + CTA + on/off come from the CMS
 * `hero` slot (see lib/cms/queries + /admin/cms); this component only renders
 * what it is handed. The discount figure is shown ONLY when > 0 so we never
 * surface a claim the catalog can't back.
 *
 * Server component — resolves its own chrome words; content is passed in
 * already locale-resolved.
 */
export async function HeroBanner({
  headline,
  subline,
  ctaLabel,
  ctaHref,
  discountPct,
}: {
  headline: string
  subline: string
  ctaLabel: string
  ctaHref: string
  discountPct: number | null
}) {
  const t = await getTranslations('landing')
  const showDiscount = typeof discountPct === 'number' && discountPct > 0
  const external = /^https?:\/\//.test(ctaHref)

  const ctaClass =
    'inline-flex items-center gap-2 rounded-button bg-accent px-5 py-3 font-semibold text-accent-foreground ' +
    'shadow-xs transition hover:bg-accent/90 hover:shadow-hover active:shadow-pressed motion-safe:active:scale-[0.98] ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-primary'

  const cta = external ? (
    <a href={ctaHref} className={ctaClass}>
      {ctaLabel} <ArrowRight className="h-4 w-4" aria-hidden />
    </a>
  ) : (
    <Link href={ctaHref} className={ctaClass}>
      {ctaLabel} <ArrowRight className="h-4 w-4" aria-hidden />
    </Link>
  )

  return (
    <section className="mx-auto max-w-6xl px-4 pt-6">
      <div className="relative overflow-hidden rounded-card bg-primary text-white shadow-lg">
        {/* tasteful brand glow — decorative only */}
        <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-accent/20 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-28 left-1/4 h-72 w-72 rounded-full bg-white/5 blur-3xl" />

        <div className="relative flex flex-col gap-6 px-6 py-10 sm:px-10 sm:py-12 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            {showDiscount && (
              <span className="inline-flex items-center gap-1.5 rounded-chip bg-accent px-3 py-1 text-xs font-bold uppercase tracking-wide text-accent-foreground shadow-xs">
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                {t('hero_eyebrow', { pct: discountPct })}
              </span>
            )}
            <h2 className="mt-4 font-display text-3xl font-bold leading-tight sm:text-4xl">{headline}</h2>
            <p className="mt-3 max-w-xl text-md text-white/85">{subline}</p>
            <div className="mt-6">{cta}</div>
          </div>

          {showDiscount && (
            <div aria-hidden className="hidden shrink-0 text-right lg:block">
              <div className="font-display text-5xl font-extrabold leading-none text-white">{discountPct}%</div>
              <div className="mt-1 text-sm font-semibold uppercase tracking-[0.2em] text-white/70">
                {t('hero_savings')}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
