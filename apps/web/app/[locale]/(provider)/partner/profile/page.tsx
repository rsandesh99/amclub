import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { Badge } from '@/components/ui/badge'
import { ProviderProfileForm, type ProviderProfileInitial } from '@/components/profile/ProviderProfileForm'

export default async function ProviderProfilePage() {
  const t = await getTranslations('profile')
  const tHome = await getTranslations('partner_home')

  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/profile')

  // Owner reads their own row via RLS. All columns here are in the granted
  // public column set (migration 0004) — no PAN/GSTIN/bank exposed.
  const supabase = await createClient()
  const { data: profile } = await supabase
    .from('provider_profiles')
    .select('display_name, about, city, languages, capacity_paused, status, slug, legal_name')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!profile) redirect('/partner/onboarding')

  const langs = Array.isArray(profile.languages)
    ? (profile.languages.filter((l): l is 'en' | 'hi' => l === 'en' || l === 'hi'))
    : []

  const initial: ProviderProfileInitial = {
    displayName: profile.display_name ?? '',
    about: profile.about ?? '',
    city: profile.city ?? '',
    languages: langs.length ? langs : ['en'],
    capacityPaused: profile.capacity_paused ?? false,
  }

  const isActive = profile.status === 'active'

  return (
    <div className="mx-auto max-w-lg px-4 py-6 space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('my_profile')}</h1>
          <p className="mt-1 text-sm text-foreground-secondary">{profile.legal_name}</p>
        </div>
        <Badge variant={isActive ? 'success' : 'warning'}>
          {isActive ? tHome('status_active') : tHome('status_under_review')}
        </Badge>
      </div>

      {isActive && (
        <a
          href={`/p/${profile.slug}`}
          className="inline-block text-sm font-medium text-primary hover:underline"
        >
          {t('view_public_page')} →
        </a>
      )}

      <ProviderProfileForm initial={initial} />
    </div>
  )
}
