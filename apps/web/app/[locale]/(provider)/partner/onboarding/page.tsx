import { getTranslations } from 'next-intl/server'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { redirect } from 'next/navigation'
import { ProviderWizard } from '@/components/wizard/ProviderWizard'
import { safeNext, withNext } from '@/lib/auth/safe-next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { createAdminClient } from '@/lib/supabase/server'
import { AGENT_ENABLED } from '@/lib/flags'
import { isOnboardingEnabledFor, onboardingDraftView } from '@/lib/agent/onboarding'
import { ONBOARDING_V3_STEPS, type OnboardingV3Step } from '@amclub/shared'
import { isOnFor } from '@/lib/experiments'
import { ProviderWizardV3 } from '@/components/wizard-v3/ProviderWizardV3'

export default async function ProviderOnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; step?: string }>
}) {
  const { next, step } = await searchParams
  const t = await getTranslations('provider_signup')
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(withNext('/partner/onboarding', next))}`)

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

  // Experience v3 E10 (flag `onboarding`): four named steps, GSTIN autofill; ?step= resumes a nudged draft.
  if (isOnFor('onboarding', user.id)) {
    const initialStep = (ONBOARDING_V3_STEPS as readonly string[]).includes(step ?? '') ? (step as OnboardingV3Step) : null
    return (
      <div className="min-h-screen bg-background p-4">
        <div className="mx-auto w-full max-w-lg py-6">
          <h1 className="t-title-1 mb-5">{t('page_title')}</h1>
          <ProviderWizardV3 initialName={user.fullName ?? ''} initialStep={initialStep} next={safeNext(next)} waEnabled={waEnabled} />
        </div>
      </div>
    )
  }
  const waDraft = AGENT_ENABLED ? await onboardingDraftView(admin, user.id) : null

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <Card>
          <CardHeader>
            <CardTitle>{t('page_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ProviderWizard skipAuth waEnabled={waEnabled} waDraft={waDraft} next={safeNext(next)} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
