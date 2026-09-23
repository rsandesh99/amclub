'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { MAX_QUOTE_REVISIONS } from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { QuoteComposer, type QuoteComposerGoods, type QuoteComposerInitial } from './QuoteComposer'

/**
 * S1.3 — "Revise quote" on the provider's own submitted quote: opens the same
 * QuoteComposer in `mode="revise"`, prefilled from the current quote (goods
 * fields included; the S1.1 extraction box is hidden). Submit → PATCH; the
 * page refreshes with the new revision. Shown while the quote is live; at the
 * cap it renders disabled with "no revisions left" (the server re-checks:
 * submitted, RFQ active, revision < MAX).
 */
export function ReviseQuote({ rfqId, initial, revision, goods }: { rfqId: string; initial: QuoteComposerInitial; revision: number; goods?: QuoteComposerGoods | undefined }) {
  const t = useTranslations('rfq')
  const [open, setOpen] = useState(false)
  const left = Math.max(0, MAX_QUOTE_REVISIONS - revision)
  // At the cap the control stays visible but disabled, with the reason — never silently gone.
  if (left === 0) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled aria-describedby={`revise-cap-${rfqId}`}>{t('revise_button')}</Button>
        <span id={`revise-cap-${rfqId}`} className="text-[11px] text-foreground-secondary">{t('revise_none_left')}</span>
      </div>
    )
  }
  if (!open) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>{t('revise_button')}</Button>
        <span className="text-[11px] text-foreground-secondary">{t('revise_left_hint', { left })}</span>
      </div>
    )
  }
  return (
    <div className="mt-3">
      <QuoteComposer rfqId={rfqId} goods={goods} mode="revise" initial={initial} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />
    </div>
  )
}
