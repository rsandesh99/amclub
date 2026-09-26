import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { Badge } from '@/components/ui/badge'
import { ProviderProfileForm, type ProviderProfileInitial } from '@/components/profile/ProviderProfileForm'
import { AssistantProfileLink } from '@/components/assistant/AssistantProfileLink'
import { WhatsAppSettingsSection } from '@/components/settings/WhatsAppSettingsSection'
import { SettingsLinks } from '@/components/settings/SettingsLinks'
import { AGENT_ENABLED } from '@/lib/flags'
import { PROVIDER_LANGUAGES, type ProviderLanguage } from '@amclub/shared'
import { isOnFor } from '@/lib/experiments'
import { createAdminClient } from '@/lib/supabase/server'
import { ProviderTrustSettings } from '@/components/trust/ProviderTrustSettings'

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
    ? (profile.languages.filter((l): l is ProviderLanguage => (PROVIDER_LANGUAGES as readonly string[]).includes(l)))
    : []

  const initial: ProviderProfileInitial = {
    displayName: profile.display_name ?? '',
    about: profile.about ?? '',
    city: profile.city ?? '',
    languages: langs.length ? langs : ['en'],
    capacityPaused: profile.capacity_paused ?? false,
  }

  const isActive = profile.status === 'active'

  // Experience v3 E3 (flag `trust`): availability + logo. A separate,
  // error-tolerant service-role read — these 0049 columns may not exist yet.
  let trustInitial: Parameters<typeof ProviderTrustSettings>[0]['initial'] | null = null
  if (isOnFor('trust', user.id)) {
    const admin = await createAdminClient()
    const { data: x, error } = await admin.from('provider_profiles').select('next_available_on, capacity_slots, logo_status, logo_url').eq('user_id', user.id).maybeSingle()
    if (!error && x) {
      trustInitial = {
        nextAvailableOn: (x.next_available_on as string | null) ?? null,
        capacitySlots: Number(x.capacity_slots ?? 5),
        logoStatus: (['none', 'pending', 'approved', 'rejected'].includes(x.logo_status as string) ? x.logo_status : 'none') as 'none',
        logoUrl: (x.logo_url as string | null) ?? null,
      }
    }
  }

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

      {/* /p/<slug> resolves only for an active provider, so the link waits for approval. */}
      {isActive ? (
        <Link
          href={`/p/${profile.slug}` as '/app'}
          className="inline-block text-sm font-medium text-primary hover:underline"
        >
          {t('view_public_page')} →
        </Link>
      ) : (
        <p className="text-sm text-foreground-secondary">{t('public_page_pending')}</p>
      )}

      <ProviderProfileForm initial={initial} />

      {trustInitial && <ProviderTrustSettings initial={trustInitial} />}

      {/* PRD_WHATSAPP W1 — WhatsApp consent per purpose, for everyone (not gated on AGENT_ENABLED). */}
      <WhatsAppSettingsSection />
      <SettingsLinks persona="provider" />

      {AGENT_ENABLED && <AssistantProfileLink href="/partner/ai" />}
    </div>
  )
}
