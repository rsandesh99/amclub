'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link, useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import type { PoolRfqCard } from '@/lib/pools/types'

/**
 * S3.4 (ADR 024) — the group request card on the buyer's own request page. The agent proposed the group; the buyer
 * joins (one ai_decisions row, on the server), says no thanks, or leaves. Nothing here moves money.
 */
export function PoolInviteCard({ card, serviceLabel, stateLabel, formByLabel, closesAtLabel }: {
  card: PoolRfqCard
  serviceLabel: string
  stateLabel: string
  formByLabel: string
  closesAtLabel: string | null
}) {
  const t = useTranslations('pools')
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function act(action: 'join' | 'leave' | 'dismiss') {
    setBusy(action)
    setError('')
    try {
      const res = await fetch(`/api/v1/pools/${card.poolId}/membership`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string }
        setError(d.error === 'rfq_closed' ? t('err_rfq_closed') : d.error === 'too_late' ? t('err_too_late') : t('err'))
        return
      }
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const others = Math.max(card.joinedCount - (card.memberStatus === 'joined' ? 1 : 0), 1)
  return (
    <section className="rounded-card border border-primary/30 bg-primary/5 p-5" data-testid="pool-card" data-pool-status={card.status} data-member-status={card.memberStatus}>
      <h2 className="font-display text-lg font-semibold">{t('card_title')}</h2>
      {card.quoteId ? (
        <p className="mt-1 text-sm">{t('quoted')}</p>
      ) : card.memberStatus === 'invited' || card.memberStatus === 'left' ? (
        <>
          <p className="mt-1 text-sm">{t('invite_body', { n: others, state: stateLabel, service: serviceLabel })}</p>
          <p className="mt-2 text-xs text-foreground-secondary">{t('how_it_works')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => act('join')} loading={busy === 'join'} data-testid="pool-join">{t('join')}</Button>
            {card.memberStatus === 'invited' && (
              <Button size="sm" variant="ghost" onClick={() => act('dismiss')} loading={busy === 'dismiss'}>{t('dismiss')}</Button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm">
            {card.status === 'forming'
              ? t('joined_forming', { min: card.minMembers, n: card.joinedCount })
              : card.status === 'open' && closesAtLabel
                ? t('joined_open', { when: closesAtLabel })
                : card.status === 'closing'
                  ? t('closing')
                  : t('ended_note')}
          </p>
          {card.status === 'forming' && <p className="mt-1 text-xs text-foreground-secondary">{t('forms_by', { min: card.minMembers, when: formByLabel })}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href={`/app/pools/${card.poolId}`} className="inline-flex min-h-[36px] items-center rounded-button bg-primary px-3 text-sm font-medium text-primary-foreground" data-testid="pool-view">{t('view_group')}</Link>
            {(card.status === 'forming' || card.status === 'open') && (
              <Button size="sm" variant="ghost" onClick={() => act('leave')} loading={busy === 'leave'}>{t('leave')}</Button>
            )}
          </div>
        </>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  )
}
