'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { GoldStamp } from './primitives'
import type { GoodsActivationState } from '@/lib/mart/activation'

/** Goods activation gate surface — one banner, one action, no re-derivation of the gate. */
export function ActivationBanner({ state }: { state: GoodsActivationState }) {
  const t = useTranslations('mart')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function activate() {
    setBusy(true); setError('')
    const res = await fetch('/api/v1/mart/seller/activate', { method: 'POST' })
    setBusy(false)
    if (res.ok) router.refresh()
    else setError(t('error_generic'))
  }

  if (state === 'active') {
    return (
      <div className="gold-edge-card flex items-center gap-3 p-4">
        <GoldStamp className="h-10 w-10 text-sm">✓</GoldStamp>
        <p className="text-sm font-medium text-emerald-ink">{t('activation_active')}</p>
      </div>
    )
  }
  if (state === 'ready') {
    return (
      <div className="sheet-card p-4">
        <p className="text-sm font-semibold text-emerald-ink">{t('activation_ready_title')}</p>
        <p className="mt-1 text-sm text-foreground-secondary">{t('activation_ready_body')}</p>
        <Button onClick={activate} loading={busy} className="mt-3 bg-emerald hover:bg-emerald-ink">{t('activate_cta')}</Button>
        {error && <p className="mt-2 text-sm text-stamp">{error}</p>}
      </div>
    )
  }
  const title = state === 'gstin_unverified' ? t('activation_gstin_unverified_title') : state === 'no_gstin' ? t('activation_no_gstin_title') : null
  const body = state === 'gstin_unverified' ? t('activation_gstin_unverified_body') : state === 'no_gstin' ? t('activation_no_gstin_body') : t('activation_provider_inactive')
  return (
    <div className="rounded-card border border-warning/30 bg-warning/10 p-4">
      {title && <p className="text-sm font-semibold text-warning">{title}</p>}
      <p className="mt-1 text-sm text-foreground-secondary">{body}</p>
    </div>
  )
}
