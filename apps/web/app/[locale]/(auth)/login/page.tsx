'use client'

import { useTranslations } from 'next-intl'
import { Link, useRouter } from '@/i18n/navigation'
import { AuthPanel } from '@/components/auth/AuthPanel'
import { resolvePostAuthRoute } from '@/lib/auth/post-auth'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

export default function LoginPage() {
  const t = useTranslations('auth')
  const router = useRouter()

  async function handleAuthenticated() {
    // Same decision regardless of method (phone / email / Google): a returning
    // user goes to their role home; a brand-new one completes the quick profile.
    const { isNew, destination } = await resolvePostAuthRoute()
    router.push(isNew ? '/signup?complete=1' : destination)
  }

  return (
    <Card>
      <CardHeader>
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-white font-bold text-lg">A</div>
        <CardTitle>{t('login_title')}</CardTitle>
        <CardDescription>{t('login_subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <AuthPanel onAuthenticated={handleAuthenticated} googleRedirectTo="/app" />
        <p className="text-center text-sm text-foreground-secondary">
          {t('no_account')}{' '}
          <Link href="/signup" className="text-primary underline underline-offset-2 hover:no-underline">
            {t('sign_up')}
          </Link>
        </p>
        <p className="text-center text-xs text-foreground-secondary">
          {t('for_providers')}{' '}
          <Link href="/partner/signup" className="text-primary underline underline-offset-2 hover:no-underline">
            {t('register_as_provider')}
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}
