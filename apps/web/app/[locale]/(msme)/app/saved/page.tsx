import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Heart } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { ProviderMiniCard } from '@/components/catalog/ProviderMiniCard'
import type { ProviderDetail } from '@/lib/catalog/types'

export default async function SavedPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/saved')

  const t = await getTranslations('catalog')
  const supabase = await createClient()

  const { data: msme } = await supabase
    .from('msme_profiles')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()

  let providers: ProviderDetail[] = []
  if (msme) {
    const { data } = await supabase
      .from('saved_providers')
      .select(
        'provider:provider_profiles(id, display_name, slug, about, logo_url, state, city, languages, avg_rating, review_count, completed_orders, median_response_minutes, top_rated, created_at)',
      )
      .eq('msme_id', msme.id)
      .order('created_at', { ascending: false })

    /* eslint-disable @typescript-eslint/no-explicit-any */
    providers = (data ?? [])
      .map((row: any) => row.provider)
      .filter(Boolean)
      .map((p: any) => ({
        id: p.id,
        displayName: p.display_name,
        slug: p.slug,
        about: p.about,
        logoUrl: p.logo_url,
        state: p.state,
        city: p.city,
        languages: p.languages ?? [],
        avgRating: Number(p.avg_rating ?? 0),
        reviewCount: p.review_count ?? 0,
        completedOrders: p.completed_orders ?? 0,
        medianResponseMinutes: p.median_response_minutes,
        topRated: p.top_rated ?? false,
        createdAt: p.created_at,
        categories: [],
        badges: [],
      }))
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-gray-200 bg-surface px-4 py-3">
        <div className="mx-auto max-w-3xl">
          <h1 className="font-display text-lg font-bold">{t('saved_title')}</h1>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-4 py-6">
        {providers.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-gray-300 bg-surface px-6 py-16 text-center">
            <Heart className="h-10 w-10 text-foreground-secondary" />
            <p className="text-sm text-foreground-secondary">{t('saved_empty')}</p>
            <Link
              href="/services"
              className="mt-2 rounded-button bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary/90"
            >
              {t('saved_empty_cta')}
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {providers.map((p) => (
              <ProviderMiniCard key={p.id} provider={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
