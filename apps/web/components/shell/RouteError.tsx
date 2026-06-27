'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle } from 'lucide-react'
import { Link } from '@/i18n/navigation'

/** Shared client error-boundary body for route-group error.tsx files.
 *  `reset` re-renders the segment; `error.digest` is logged for Sentry. */
export function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('error_boundary')

  useEffect(() => {
    // Surfaced to the console (and Sentry, when wired). Avoid leaking details to UI.
    console.error('[route error]', error)
  }, [error])

  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-20 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-danger/10">
        <AlertTriangle className="h-7 w-7 text-danger" />
      </span>
      <h1 className="mt-4 text-xl font-semibold">{t('title')}</h1>
      <p className="mt-2 text-sm text-foreground-secondary">{t('subtitle')}</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-button bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary/90"
        >
          {t('retry')}
        </button>
        <Link
          href="/"
          className="rounded-button border border-border px-5 py-2.5 text-sm font-medium text-primary hover:bg-primary/5"
        >
          {t('home')}
        </Link>
      </div>
    </div>
  )
}
