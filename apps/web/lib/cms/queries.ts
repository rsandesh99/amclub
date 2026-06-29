import 'server-only'
import { createPublicClient } from '@/lib/supabase/server'
import type { I18nText } from '@/lib/catalog/types'

export interface Banner {
  id: string
  slot: string
  variant: 'image' | 'hero'
  imageUrl: string | null
  link: string | null
  locale: string | null
  // Hero-variant content
  headline: I18nText | null
  subline: I18nText | null
  ctaLabel: I18nText | null
  ctaHref: string | null
  discountPct: number | null
}

/**
 * Active banners for a slot, respecting the schedule window and locale (A6).
 * `locale=null` banners are shown for every locale; otherwise the banner must
 * match the requested locale. Read via the public (anon) client — the
 * cms_banners RLS already restricts to active + not-ended rows.
 */
export async function getActiveBanners(slot: string, locale: 'en' | 'hi'): Promise<Banner[]> {
  const supabase = createPublicClient()
  const nowIso = new Date().toISOString()
  const { data } = await supabase
    .from('cms_banners')
    .select(
      'id, slot, variant, image_url, link, headline, subline, cta_label, cta_href, discount_pct, locale, starts_at, ends_at, is_active',
    )
    .eq('slot', slot)
    .eq('is_active', true)
    .order('created_at', { ascending: false })

  return (data ?? [])
    .filter((b) => (b.starts_at == null || b.starts_at <= nowIso) && (b.ends_at == null || b.ends_at >= nowIso))
    .filter((b) => b.locale == null || b.locale === locale)
    .map((b) => ({
      id: b.id,
      slot: b.slot,
      variant: (b.variant ?? 'image') as 'image' | 'hero',
      imageUrl: b.image_url,
      link: b.link,
      locale: b.locale,
      headline: (b.headline as I18nText) ?? null,
      subline: (b.subline as I18nText) ?? null,
      ctaLabel: (b.cta_label as I18nText) ?? null,
      ctaHref: b.cta_href,
      discountPct: b.discount_pct,
    }))
}

/**
 * The largest discount currently live in the catalog, as a whole-number
 * percentage. Used as the HONEST default for the hero banner's "up to X% off"
 * claim so the figure is always backed by a real listing (the admin can raise
 * it from /admin/cms, but only once a listing supports the bigger number).
 * Returns 0 when nothing is discounted. ISR-cached at the page level.
 */
export async function getMaxDiscountPct(): Promise<number> {
  const supabase = createPublicClient()
  const { data } = await supabase
    .from('packages')
    .select('discount_bps')
    .eq('status', 'active')
    .is('deleted_at', null)
    .order('discount_bps', { ascending: false })
    .limit(1)
    .maybeSingle()
  const bps = data?.discount_bps ?? 0
  return Math.floor(Number(bps) / 100)
}
