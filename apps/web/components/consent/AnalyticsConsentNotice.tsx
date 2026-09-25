'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslations } from 'next-intl'
import { currentConsentFromCookie, ANALYTICS_CONSENT_COOKIE, type AnalyticsConsentChoice } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { ANALYTICS_CONSENT_REQUIRED } from '@/lib/public-flags'
import { readConsentCookie, setAnalyticsConsent } from '@/components/providers/posthog'
import { useBottomBarLift } from '@/components/shell-v3/useBottomBarLift'
import { cn } from '@/lib/utils'

/**
 * E17 (N36, gated on D-UX2) — the one-line notice. Equal Accept and Decline
 * (same size, same weight, nothing pre-ticked). Rendered only when the build
 * flag is on and the person has no choice for the current notice version; a
 * signed-in person's stored choice is fetched once and applied without asking.
 *
 * Placement: it never covers the navigation or a page's pinned action. On
 * phones and tablets it is a compact strip sitting ON TOP of whatever is
 * pinned to the bottom (the tab bar, a sticky pay / continue bar — every
 * `[data-bottom-bar]`); from lg it is a small card in the bottom-right corner,
 * clear of the left side rail. It is itself a `[data-bottom-bar]`, so the
 * corner assistant lifts above it.
 */
export function AnalyticsConsentNotice() {
  const t = useTranslations('consent')
  const [open, setOpen] = useState(false)
  const self = useRef<HTMLDivElement>(null)
  const lift = useBottomBarLift(open, self)

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
    <div
      ref={self}
      role="region"
      aria-label={t('aria')}
      data-bottom-bar
      className={cn(
        'fixed inset-x-0 bottom-[var(--consent-lift)] z-50 border-t border-border bg-surface px-4 pt-2 shadow-card',
        // At the very bottom (nothing pinned below it) it clears the phone's home indicator.
        lift > 0 ? 'pb-2' : 'pb-[max(0.5rem,env(safe-area-inset-bottom))]',
        'lg:left-auto lg:right-6 lg:bottom-[calc(var(--consent-lift)_+_1.5rem)] lg:w-[24rem] lg:rounded-card lg:border lg:p-4 lg:shadow-modal',
      )}
      style={{ '--consent-lift': `${lift}px` } as CSSProperties}
      data-testid="analytics-consent"
      data-cookie={ANALYTICS_CONSENT_COOKIE}
    >
      <div className="mx-auto flex max-w-5xl items-center gap-3 lg:flex-col lg:items-stretch">
        <p className="min-w-0 flex-1 text-xs text-foreground sm:text-sm">
          {t('notice')} <Link href="/privacy" className="font-medium text-primary hover:underline">{t('learn_more')}</Link>
        </p>
        {/* Equal: same variant, same size (compact on phones, so the notice text keeps the width). */}
        <div className="flex shrink-0 gap-2 lg:justify-end">
          <Button variant="secondary" size="sm" className="px-2.5 text-xs sm:px-3 sm:text-sm" onClick={() => choose('denied')} data-testid="consent-decline">{t('decline')}</Button>
          <Button variant="secondary" size="sm" className="px-2.5 text-xs sm:px-3 sm:text-sm" onClick={() => choose('granted')} data-testid="consent-accept">{t('accept')}</Button>
        </div>
      </div>
    </div>
  )
}
