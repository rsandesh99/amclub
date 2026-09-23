'use client'

import { useEffect, useRef } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { benchmarkLine, type BenchmarkView } from '@amclub/shared'
import { useAnalytics } from '@/components/providers/posthog'

/**
 * S3.2 — the fair price range, the SAME line for the buyer and every matched provider on a services request. Fixed copy
 * with numbers computed by code from paid jobs (`benchmarkLine`, shared with mobile); the optional sentence under it
 * is informational and output-policed. The parent renders nothing when there is no row — never an empty state.
 */
export function BenchmarkLine({ view, role }: { view: BenchmarkView; role: 'buyer' | 'provider' }) {
  const t = useTranslations('rfq')
  const locale = useLocale()
  const posthog = useAnalytics()
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current) return
    sent.current = true
    posthog.capture('benchmark_shown', { role, scope: view.scope, category: view.category_slug })
  }, [posthog, role, view.scope, view.category_slug])

  return (
    <div className="rounded-button border border-border bg-muted/40 p-3 text-sm" data-testid="benchmark-line">
      <p className="font-medium">{benchmarkLine(view, locale)}</p>
      {view.note && <p className="mt-1 text-xs text-foreground-secondary">{view.note}</p>}
      <details className="mt-1 text-xs text-foreground-secondary">
        <summary className="cursor-pointer select-none text-primary underline underline-offset-2">{t('benchmark_how_title')}</summary>
        <p className="mt-1">{t('benchmark_how_body')}</p>
      </details>
    </div>
  )
}
