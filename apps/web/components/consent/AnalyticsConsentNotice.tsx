'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { currentConsentFromCookie, ANALYTICS_CONSENT_COOKIE, type AnalyticsConsentChoice } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { ANALYTICS_CONSENT_REQUIRED } from '@/lib/public-flags'
import { readConsentCookie, setAnalyticsConsent } from '@/components/providers/posthog'

/**
 * E17 (N36, gated on D-UX2) — the one-line notice. Equal Accept and Decline
 * (same size, same weight, nothing pre-ticked). Rendered only when the build
 * flag is on and the person has no choice for the current notice version; a
 * signed-in person's stored choice is fetched once and applied without asking.
 */
export function AnalyticsConsentNotice() {
  const t = useTranslations('consent')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!ANALYTICS_CONSENT_REQUIRED) return
    if (currentConsentFromCookie(readConsentCookie())) return
    let live = true
    void (async () => {
      const res = await fetch('/api/v1/me/analytics-consent').catch(() => null)
      const d = res?.ok ? ((await res.json().catch(() => null)) as { choice?: AnalyticsConsentChoice | null } | null) : null
      if (!live) return
      if (d?.choice) setAnalyticsConsent(d.choice)
      else setOpen(true)
    })()
    return () => { live = false }
  }, [])

  if (!open) return null
  const choose = (choice: AnalyticsConsentChoice) => {
    setAnalyticsConsent(choice)
    setOpen(false)
    void fetch('/api/v1/me/analytics-consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice }) }).catch(() => {})
  }
  return (
    <div role="region" aria-label={t('aria')} data-bottom-bar className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-surface px-4 py-3 shadow-card" data-testid="analytics-consent" data-cookie={ANALYTICS_CONSENT_COOKIE}>
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          {t('notice')} <Link href="/privacy" className="font-medium text-primary hover:underline">{t('learn_more')}</Link>
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => choose('denied')} data-testid="consent-decline">{t('decline')}</Button>
          <Button variant="secondary" size="sm" onClick={() => choose('granted')} data-testid="consent-accept">{t('accept')}</Button>
        </div>
      </div>
    </div>
  )
}
