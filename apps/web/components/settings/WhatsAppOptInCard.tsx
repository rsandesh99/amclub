'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { MessageCircle, X } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { useAnalytics } from '@/components/providers/posthog'
import { loadWhatsAppConsent } from '@/lib/api/settings-client'

const KEY = 'amc_wa_optin_card_dismissed'

/**
 * "Get order updates on WhatsApp" — a one-time card for people who signed up
 * before the WhatsApp box existed (buyer home, provider Today). Shown only when
 * the account has a phone, WhatsApp is ready, the phone is not suppressed and
 * the person has made no choice yet (never after an opt-out). Dismissing hides
 * it on this device for good.
 */
export function WhatsAppOptInCard({ persona }: { persona: 'buyer' | 'provider' }) {
  const t = useTranslations('whatsapp')
  const analytics = useAnalytics()
  const [show, setShow] = useState(false)

  useEffect(() => {
    let live = true
    try { if (localStorage.getItem(KEY) === '1') return } catch { /* private mode: still ask */ }
    void loadWhatsAppConsent().then((r) => {
      if (!live || r.kind !== 'ready') return
      const s = r.data
      if (s.phoneMasked && !s.suppressed && s.purposes.transactional === 'none') {
        setShow(true)
        analytics.capture('whatsapp_optin_card_shown', { persona, device: 'web' })
      }
    })
    return () => { live = false }
  }, [analytics, persona])

  if (!show) return null

  const dismiss = () => {
    try { localStorage.setItem(KEY, '1') } catch { /* ignore */ }
    setShow(false)
    analytics.capture('whatsapp_optin_card_dismissed', { persona, device: 'web' })
  }

  return (
    <section className="relative flex items-start gap-3 rounded-card border border-primary/30 bg-primary/5 p-4" data-testid="wa-optin-card" aria-labelledby="wa-optin-card-title">
      <MessageCircle className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1 pr-6">
        <h2 id="wa-optin-card-title" className="text-sm font-semibold">{t('card_title')}</h2>
        <p className="mt-0.5 text-xs text-foreground-secondary">{t('card_body')}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Link
            href={(persona === 'provider' ? '/partner/profile#whatsapp' : '/app/profile#whatsapp') as '/app'}
            onClick={() => analytics.capture('whatsapp_optin_card_clicked', { persona, device: 'web' })}
            className="inline-flex min-h-11 items-center rounded-button bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-strong"
          >
            {t('card_cta')}
          </Link>
          <button type="button" onClick={dismiss} className="inline-flex min-h-11 items-center text-sm font-medium text-foreground-secondary hover:text-foreground">
            {t('card_dismiss')}
          </button>
        </div>
      </div>
      <button type="button" onClick={dismiss} className="absolute right-2 top-2 rounded-full p-2 text-foreground-secondary hover:bg-foreground/5" aria-label={t('card_dismiss')}>
        <X className="h-4 w-4" aria-hidden />
      </button>
    </section>
  )
}
