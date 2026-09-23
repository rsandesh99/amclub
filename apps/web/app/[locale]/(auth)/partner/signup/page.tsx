import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ProviderWizard } from '@/components/wizard/ProviderWizard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { isOnForEveryone } from '@/lib/experiments'

export default async function ProviderSignupPage() {
  const t = await getTranslations('provider_signup')
  const tAuth = await getTranslations('auth')

  return (
    <Card>
      <CardHeader>
        <Link href="/" aria-label={tAuth('home')} className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-lg font-bold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">A</Link>
        <CardTitle>{t('page_title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* Experience v3 E10: sign in here, then the four-step wizard at /partner/onboarding. */}
        <ProviderWizard {...(isOnForEveryone('onboarding') ? { handoffTo: '/partner/onboarding' } : {})} />
        <p className="text-center text-sm text-foreground-secondary">
          {tAuth('already_have_account')}{' '}
          <Link href="/login" className="text-primary underline underline-offset-2 hover:no-underline">
            {tAuth('sign_in')}
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}
