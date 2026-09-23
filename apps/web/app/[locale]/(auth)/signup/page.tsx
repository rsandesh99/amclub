import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { MsmeWizard } from '@/components/wizard/MsmeWizard'
import { safeNext, withNext } from '@/lib/auth/safe-next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ complete?: string; next?: string }>
}) {
  const { complete, next } = await searchParams
  const t = await getTranslations('msme_signup')
  const tAuth = await getTranslations('auth')

  return (
    <Card>
      <CardHeader>
        {/* /services, not / — a signed-in profile-less user clicking / is
            bounced straight back here by the middleware (a no-op logo). */}
        <Link href="/services" aria-label={tAuth('home')} className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-lg font-bold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">A</Link>
        <CardTitle>{t('page_title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* complete=1 → user already authenticated (Google/email); skip to profile. */}
        <MsmeWizard skipAuth={complete === '1'} next={safeNext(next)} />
        <p className="text-center text-sm text-foreground-secondary">
          {tAuth('already_have_account')}{' '}
          <Link href={withNext('/login', next)} className="text-primary underline underline-offset-2 hover:no-underline">
            {tAuth('sign_in')}
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}
