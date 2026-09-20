'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { DECLINE_REASONS, type DeclineReason } from '@amclub/shared'
import { Button } from '@/components/ui/button'

/**
 * Quote-or-decline (S0.4): the provider's honest "no" beside "Quote". A reason
 * is required so the buyer's update is specific and the score treats it as a
 * decision. Idempotent server side.
 */
export function DeclineRfqButton({ rfqId }: { rfqId: string }) {
  const t = useTranslations('rfq')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<DeclineReason>('capacity')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function decline() {
    setBusy(true)
    setError('')
    const res = await fetch(`/api/v1/rfq/${rfqId}/decline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
    const d = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) { setError(typeof d.error === 'string' ? d.error : t('decline_failed')); return }
    router.refresh()
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>{t('decline_button')}</Button>
    )
  }

  return (
    <div className="rounded-card border border-border bg-muted p-3 text-sm">
      <p className="font-medium">{t('decline_title')}</p>
      <p className="mt-0.5 text-xs text-foreground-secondary">{t('decline_hint')}</p>
      <select
        aria-label={t('decline_reason_label')}
        value={reason}
        onChange={(e) => setReason(e.target.value as DeclineReason)}
        className="mt-2 h-9 w-full rounded-button border border-border bg-surface px-2 text-sm"
      >
        {DECLINE_REASONS.map((r) => <option key={r} value={r}>{t(`decline_reason_${r}` as 'decline_reason_capacity')}</option>)}
      </select>
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="danger" loading={busy} onClick={decline}>{t('decline_confirm')}</Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)}>{t('decline_cancel')}</Button>
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  )
}
