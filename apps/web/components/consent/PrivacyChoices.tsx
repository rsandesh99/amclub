'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { currentConsentFromCookie, type AnalyticsConsentChoice } from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { readConsentCookie, setAnalyticsConsent } from '@/components/providers/posthog'

/** E17 — "Privacy choices" on the profile: the current analytics choice and the way to change it. */
export function PrivacyChoices() {
  const t = useTranslations('consent')
  const [choice, setChoice] = useState<AnalyticsConsentChoice | null>(null)
  useEffect(() => { setChoice(currentConsentFromCookie(readConsentCookie())) }, [])
  const set = (c: AnalyticsConsentChoice) => {
    setAnalyticsConsent(c)
    setChoice(c)
    void fetch('/api/v1/me/analytics-consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice: c }) }).catch(() => {})
  }
  return (
    <section className="rounded-card border border-border bg-surface p-4" data-testid="privacy-choices">
      <h2 className="text-sm font-semibold">{t('choices_title')}</h2>
      <p className="mt-1 text-xs text-foreground-secondary">{choice === 'granted' ? t('state_granted') : choice === 'denied' ? t('state_denied') : t('state_unset')}</p>
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" size="sm" disabled={choice === 'denied'} onClick={() => set('denied')}>{t('decline')}</Button>
        <Button variant="secondary" size="sm" disabled={choice === 'granted'} onClick={() => set('granted')}>{t('accept')}</Button>
      </div>
    </section>
  )
}
