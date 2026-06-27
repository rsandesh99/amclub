import { getLocale } from 'next-intl/server'
import { getActiveBanners } from '@/lib/cms/queries'

/**
 * Renders active CMS banners for a slot in the viewer's locale, respecting the
 * schedule window (A6). Server component — safe to drop into any page/section.
 */
export async function BannerSlot({ slot, className }: { slot: string; className?: string }) {
  const locale = (await getLocale()) === 'hi' ? 'hi' : 'en'
  const banners = await getActiveBanners(slot, locale)
  if (banners.length === 0) return null

  return (
    <div className={className ?? 'mx-auto max-w-6xl px-4 py-4 space-y-3'}>
      {banners.map((b) => {
        const img = (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={b.imageUrl} alt="" className="w-full rounded-card object-cover" loading="lazy" />
        )
        return b.link ? (
          <a key={b.id} href={b.link} className="block">{img}</a>
        ) : (
          <div key={b.id}>{img}</div>
        )
      })}
    </div>
  )
}
