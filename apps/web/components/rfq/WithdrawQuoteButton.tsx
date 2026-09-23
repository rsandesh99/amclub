'use client'

import { useCallback, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { ConfirmSheet } from '@/components/ui/confirm-sheet'

/**
 * The provider takes back their own submitted quote (POST …/quote/withdraw).
 * Irreversible — a withdrawn quote cannot be resubmitted on the same request —
 * so it goes through the one confirm surface. The server re-checks everything.
 */
export function WithdrawQuoteButton({ rfqId }: { rfqId: string }) {
  const t = useTranslations('rfq')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Stable: ConfirmSheet's focus effect depends on onClose.
  const close = useCallback(() => setOpen(false), [])

  async function withdraw() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/v1/rfq/${rfqId}/quote/withdraw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      const d = (await res.json().catch(() => ({}))) as { error?: unknown }
      if (!res.ok) {
        setError(
          d.error === 'checkout_in_progress' ? t('withdraw_err_checkout')
            : d.error === 'rfq_closed' || d.error === 'quote_not_withdrawable' ? t('withdraw_err_closed')
              : t('withdraw_failed'),
        )
        return
      }
      setOpen(false)
      router.refresh()
    } catch {
      setError(t('withdraw_failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => { setError(null); setOpen(true) }}>{t('withdraw_button')}</Button>
      <ConfirmSheet
        open={open}
        title={t('withdraw_title')}
        description={t('withdraw_body')}
        confirmLabel={t('withdraw_confirm')}
        cancelLabel={t('withdraw_cancel')}
        variant="danger"
        busy={busy}
        error={error}
        onConfirm={withdraw}
        onClose={close}
      />
    </>
  )
}
