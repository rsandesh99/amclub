import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ProviderWizard } from '@/components/wizard/ProviderWizard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default async function ProviderSignupPage() {
  const t = await getTranslations('provider_signup')
  const tAuth = await getTranslations('auth')

  return (
    <Card>
      <CardHeader>
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-white font-bold text-lg">A</div>
        <CardTitle>{t('page_title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ProviderWizard />
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
