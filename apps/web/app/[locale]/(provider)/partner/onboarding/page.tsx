import { getTranslations } from 'next-intl/server'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { redirect } from 'next/navigation'
import { ProviderWizard } from '@/components/wizard/ProviderWizard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default async function ProviderOnboardingPage() {
  const t = await getTranslations('provider_signup')
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/onboarding')

  // An existing provider must never re-run onboarding — resubmitting would
  // reset an approved profile to under_review and wipe verification badges.
  // Only brand-new applicants and rejected reapplicants may proceed.
  const existing = await getProviderProfile(user.id)
  if (existing && existing.status !== 'rejected') redirect('/partner')

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <Card>
          <CardHeader>
            <CardTitle>{t('page_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ProviderWizard skipAuth />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
