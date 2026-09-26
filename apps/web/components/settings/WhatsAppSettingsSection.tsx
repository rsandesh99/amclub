'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { MessageCircle, ShieldCheck } from 'lucide-react'
import type { WaConsentPurpose, WaConsentState } from '@amclub/shared'
import { waMeHref } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { Skeleton } from '@/components/ui-v3/Feedback'
import { useAnalytics } from '@/components/providers/posthog'
import { loadWhatsAppConsent, saveWhatsAppConsent } from '@/lib/api/settings-client'
import { OFFICIAL_WHATSAPP } from '@/lib/legal/grievance'
import { WHATSAPP_MARKETING_ENABLED } from '@/lib/public-flags'
import { Switch } from './Switch'

type View = { kind: 'loading' } | { kind: 'not_ready' } | { kind: 'error' } | { kind: 'ready'; state: WaConsentState }

/**
 * Settings → WhatsApp (PRD_WHATSAPP W1; audit §5 item 1). Consent belongs to
 * the account's phone and a purpose (ADR-030 §2): one switch per purpose, each
 * with the notice it records (WA_NOTICE_VERSION). Opt-out is one tap and takes
 * effect at once. The "Offers" switch appears only while marketing is enabled
 * or the person is already opted in to it (so they can always turn it off).
 * Not gated on AGENT_ENABLED: order and request updates are for everyone.
 */
export function WhatsAppSettingsSection({ source = 'web_settings' }: { source?: 'web_settings' }) {
  const t = useTranslations('whatsapp')
  const tCommon = useTranslations('common')
  const { toast } = useToast()
  const analytics = useAnalytics()
  const ids = useId()
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [busy, setBusy] = useState<WaConsentPurpose | null>(null)

  const load = useCallback(async () => {
    setView({ kind: 'loading' })
    const r = await loadWhatsAppConsent()
    setView(r.kind === 'ready' ? { kind: 'ready', state: r.data } : r)
  }, [])
  useEffect(() => { void load() }, [load])

  async function toggle(purpose: WaConsentPurpose, on: boolean) {
    if (view.kind !== 'ready' || busy) return
    const before = view.state
    // Optimistic: the switch moves at once; a failure puts it back.
    setView({ kind: 'ready', state: { ...before, purposes: { ...before.purposes, [purpose]: on ? 'opted_in' : 'opted_out' } } })
    setBusy(purpose)
    const res = await saveWhatsAppConsent(purpose, on, source)
    setBusy(null)
    if (res.ok) {
      setView({ kind: 'ready', state: res.data && typeof res.data.purposes === 'object' ? res.data : { ...before, purposes: { ...before.purposes, [purpose]: on ? 'opted_in' : 'opted_out' } } })
      analytics.capture('whatsapp_consent_changed', { purpose, on, source, device: 'web' })
      toast(on ? t('saved_on') : t('saved_off'), 'success')
      return
    }
    setView({ kind: 'ready', state: before })
    if (res.status === 409) { toast(t('notice_changed'), 'info'); void load() }
    else if (res.status === 422) toast(t('phone_required'), 'error')
    else if (res.status === 503) setView({ kind: 'not_ready' })
    else toast(t('save_failed'), 'error')
  }

  const state = view.kind === 'ready' ? view.state : null
  const number = state?.businessNumber ? waMeHref(state.businessNumber) : waMeHref(OFFICIAL_WHATSAPP.digits)
  const purposes: WaConsentPurpose[] = ['transactional', 'assistant']
  if (state && (WHATSAPP_MARKETING_ENABLED || state.purposes.marketing === 'opted_in')) purposes.push('marketing')

  return (
    <section
      id="whatsapp"
      aria-labelledby={`${ids}-title`}
      className="scroll-mt-24 rounded-card border border-border bg-surface p-4 shadow-card"
      data-testid="whatsapp-settings"
      data-state={view.kind}
    >
      <h2 id={`${ids}-title`} className="flex items-center gap-2 text-base font-semibold">
        <MessageCircle className="h-5 w-5 text-primary" aria-hidden />
        {t('title')}
      </h2>
      <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>

      <div className="mt-3" aria-live="polite">
        {view.kind === 'loading' && (
          <div className="space-y-2" aria-label={t('loading')}>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        )}
        {view.kind === 'not_ready' && <p className="rounded-button bg-primary-soft px-3 py-2 text-sm text-foreground" role="status">{t('not_ready')}</p>}
        {view.kind === 'error' && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <p className="text-foreground-secondary">{t('load_failed')}</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>{tCommon('retry')}</Button>
          </div>
        )}
        {state && (
          <>
            {state.phoneMasked ? (
              <p className="text-sm">{t('your_number', { number: state.phoneMasked })}</p>
            ) : (
              <p className="rounded-button bg-warning-soft px-3 py-2 text-sm text-warning" role="status">{t('no_phone')}</p>
            )}
            {state.suppressed && (
              <p className="mt-2 rounded-button bg-warning-soft px-3 py-2 text-sm text-warning" role="status">
                {state.suppressed === 'not_on_whatsapp' ? t('suppressed_not_on_whatsapp') : t('suppressed_other')}
              </p>
            )}
            <ul className="mt-3 divide-y divide-border rounded-card border border-border">
              {purposes.map((p) => {
                const on = state.purposes[p] === 'opted_in'
                return (
                  <li key={p} className="flex items-start gap-3 px-3 py-3" data-testid={`wa-purpose-${p}`} data-on={on}>
                    <div className="min-w-0 flex-1">
                      <p id={`${ids}-${p}-t`} className="text-sm font-semibold">{t(`${p}_title`)}</p>
                      <p id={`${ids}-${p}-d`} className="mt-0.5 text-xs leading-relaxed text-foreground-secondary">{t(`notice_${p}`)}</p>
                    </div>
                    <Switch
                      checked={on}
                      onChange={(next) => void toggle(p, next)}
                      disabled={!state.phoneMasked || (busy !== null && busy !== p)}
                      busy={busy === p}
                      labelledBy={`${ids}-${p}-t`}
                      describedBy={`${ids}-${p}-d`}
                      testId={`wa-switch-${p}`}
                    />
                  </li>
                )
              })}
            </ul>
            <p className="mt-3 text-xs text-foreground-secondary">{t('stop_hint')}</p>
          </>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <a href={number} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 font-medium text-primary hover:underline">
          <MessageCircle className="h-4 w-4" aria-hidden />
          {t('message_us')}
        </a>
        <Link href="/help/whatsapp-safety" className="inline-flex min-h-11 items-center gap-1.5 font-medium text-primary hover:underline">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          {t('safety_link')}
        </Link>
      </div>
    </section>
  )
}
