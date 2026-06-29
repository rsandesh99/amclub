import { getLocale } from 'next-intl/server'
import { getActiveBanners } from '@/lib/cms/queries'
import { pickI18n } from '@/lib/format'
import { HeroBanner } from './HeroBanner'

/**
 * Renders active CMS banners for a slot in the viewer's locale, respecting the
 * schedule window (A6). Handles both variants: image banners and styled hero
 * banners. Server component — safe to drop into any page/section.
 */
export async function BannerSlot({ slot, className }: { slot: string; className?: string }) {
  const locale = await getLocale()
  const banners = await getActiveBanners(slot, locale === 'hi' ? 'hi' : 'en')
  if (banners.length === 0) return null

  return (
    <div className={className ?? 'space-y-3'}>
      {banners.map((b) => {
        if (b.variant === 'hero' && b.headline) {
          return (
            <HeroBanner
              key={b.id}
              headline={pickI18n(b.headline, locale)}
              subline={b.subline ? pickI18n(b.subline, locale) : ''}
              ctaLabel={b.ctaLabel ? pickI18n(b.ctaLabel, locale) : ''}
              ctaHref={b.ctaHref || '/services'}
              discountPct={b.discountPct}
            />
          )
        }
        if (!b.imageUrl) return null
        const img = (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={b.imageUrl} alt="" className="w-full rounded-card object-cover shadow-resting" loading="lazy" />
        )
        return (
          <div key={b.id} className="mx-auto max-w-6xl px-4 py-4">
            {b.link ? (
              <a href={b.link} className="block">{img}</a>
            ) : (
              img
            )}
          </div>
        )
      })}
    </div>
  )
}
