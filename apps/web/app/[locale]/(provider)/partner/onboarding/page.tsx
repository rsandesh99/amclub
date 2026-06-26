import { getTranslations } from 'next-intl/server'
import { getSessionUser } from '@/lib/auth/session'
import { redirect } from 'next/navigation'
import { ProviderWizard } from '@/components/wizard/ProviderWizard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default async function ProviderOnboardingPage() {
  const t = await getTranslations('provider_signup')
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/onboarding')

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
