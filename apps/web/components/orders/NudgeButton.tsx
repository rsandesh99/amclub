'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'

/**
 * S2.3 spine — a fixed-template reminder to the other party of an active order
 * or request, once per 24 hours. No free text; the Support agent is just
 * another caller of the same route.
 */
export function NudgeButton({ subjectKind, subjectId }: { subjectKind: 'order' | 'rfq'; subjectId: string }) {
  const t = useTranslations('orders')
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  async function nudge() {
    setBusy(true)
    const path = subjectKind === 'order' ? `/api/v1/orders/${subjectId}/nudge` : `/api/v1/rfq/${subjectId}/nudge`
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ via: 'web' }) })
    setBusy(false)
    if (res.ok) {
      setSent(true)
      toast(t('nudge_sent'))
    } else if (res.status === 429) toast(t('nudge_capped'))
    else toast(t('nudge_sent'))
  }

  return (
    <Button variant="outline" size="sm" onClick={nudge} disabled={busy || sent} data-testid="nudge-button">
      {t('nudge_button')}
    </Button>
  )
}
