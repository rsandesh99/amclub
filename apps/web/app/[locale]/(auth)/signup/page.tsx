import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { MsmeWizard } from '@/components/wizard/MsmeWizard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ complete?: string }>
}) {
  const { complete } = await searchParams
  const t = await getTranslations('msme_signup')
  const tAuth = await getTranslations('auth')

  return (
    <Card>
      <CardHeader>
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-white font-bold text-lg">A</div>
        <CardTitle>{t('page_title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* complete=1 → user already authenticated (Google/email); skip to profile. */}
        <MsmeWizard skipAuth={complete === '1'} />
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
