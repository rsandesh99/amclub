'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Link, useRouter } from '@/i18n/navigation'
import { AuthPanel } from '@/components/auth/AuthPanel'
import { resolvePostAuthRoute } from '@/lib/auth/post-auth'
import { safeNext, withNext } from '@/lib/auth/safe-next'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

export default function LoginPage() {
  // useSearchParams must sit inside a Suspense boundary (Next 15 static render).
  return (
    <Suspense fallback={<div className="h-72 animate-pulse rounded-card bg-muted" />}>
      <LoginInner />
    </Suspense>
  )
}

function LoginInner() {
  const t = useTranslations('auth')
  const router = useRouter()
  const params = useSearchParams()
  // Where an auth-wall sent the user before bouncing them here.
  const next = safeNext(params.get('next'))

  async function handleAuthenticated() {
    // Same decision regardless of method (phone / email / Google): a returning
    // user goes to their intended page (or role home); a brand-new one completes
    // the quick profile first.
    const { isNew, destination } = await resolvePostAuthRoute()
    if (isNew) {
      // Honor provider intent: someone auth-walled on their way to /partner/*
      // gets the PROVIDER wizard, not the buyer one (mirrors the OAuth callback).
      // E0 (U1): the wizard carries `next`, so a buyer auth-walled on the way to
      // checkout lands back on that checkout once the profile is saved.
      router.push(withNext(next?.startsWith('/partner') ? '/partner/onboarding' : '/signup?complete=1', next))
    } else {
      router.push(next ?? destination)
    }
  }

  return (
    <Card>
      <CardHeader>
        <Link href="/" aria-label={t('home')} className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-lg font-bold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">A</Link>
        <CardTitle>{t('login_title')}</CardTitle>
        <CardDescription>{t('login_subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <AuthPanel onAuthenticated={handleAuthenticated} googleRedirectTo={next ?? '/app'} />
        <p className="text-center text-sm text-foreground-secondary">
          {t('no_account')}{' '}
          <Link href="/signup" className="text-primary underline underline-offset-2 hover:no-underline">
            {t('sign_up')}
          </Link>
        </p>
        <p className="text-center text-xs text-foreground-secondary">
          {t('for_providers')}{' '}
          <Link href="/partner/onboarding" className="text-primary underline underline-offset-2 hover:no-underline">
            {t('register_as_provider')}
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}
