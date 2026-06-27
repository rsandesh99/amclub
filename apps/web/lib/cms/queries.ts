import 'server-only'
import { createPublicClient } from '@/lib/supabase/server'

export interface Banner {
  id: string
  slot: string
  imageUrl: string
  link: string | null
  locale: string | null
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
    .select('id, slot, image_url, link, locale, starts_at, ends_at, is_active')
    .eq('slot', slot)
    .eq('is_active', true)
    .order('created_at', { ascending: false })

  return (data ?? [])
    .filter((b) => (b.starts_at == null || b.starts_at <= nowIso) && (b.ends_at == null || b.ends_at >= nowIso))
    .filter((b) => b.locale == null || b.locale === locale)
    .map((b) => ({ id: b.id, slot: b.slot, imageUrl: b.image_url, link: b.link, locale: b.locale }))
}
