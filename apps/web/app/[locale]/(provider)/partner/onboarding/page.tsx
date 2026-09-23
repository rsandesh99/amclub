import { getTranslations } from 'next-intl/server'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { redirect } from 'next/navigation'
import { ProviderWizard } from '@/components/wizard/ProviderWizard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { createAdminClient } from '@/lib/supabase/server'
import { AGENT_ENABLED } from '@/lib/flags'
import { isOnboardingEnabledFor, onboardingDraftView } from '@/lib/agent/onboarding'

export default async function ProviderOnboardingPage() {
  const t = await getTranslations('provider_signup')
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/onboarding')

  // An existing provider must never re-run onboarding — resubmitting would
  // reset an approved profile to under_review and wipe verification badges.
  // Only brand-new applicants, pending_kyc applicants (KYC never finished —
  // the dashboard's "Complete onboarding" CTA lands here) and rejected
  // reapplicants may proceed. Mirrors the POST /api/v1/profile/provider
  // re-registration guard and /profile/me canOnboard; redirecting pending_kyc
  // back to /partner made that CTA a dead loop.
  const existing = await getProviderProfile(user.id)
  if (existing && existing.status !== 'rejected' && existing.status !== 'pending_kyc') redirect('/partner')

  // S1.6 — the "Finish on WhatsApp" flag and the CONFIRMED interview draft, server-side so the
  // prefilled fields and their chips render on first paint. Both null/false while dark.
  const admin = await createAdminClient()
  const waEnabled = AGENT_ENABLED ? await isOnboardingEnabledFor(admin, user.id) : false
  const waDraft = AGENT_ENABLED ? await onboardingDraftView(admin, user.id) : null

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <Card>
          <CardHeader>
            <CardTitle>{t('page_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ProviderWizard skipAuth waEnabled={waEnabled} waDraft={waDraft} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
