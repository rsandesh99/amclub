'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { PoolBuyerView } from '@amclub/shared'
import { Link, useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatINRExact } from '@/lib/format'

/**
 * S3.4 (ADR 024) — a member's view of the group: the count (never another member), every group offer with the
 * server's all-in figure per tier, and one choice. Choosing moves no money; at close the buyer gets ONE ordinary quote.
 */
export function PoolBuyerClient({ view, labels }: {
  view: PoolBuyerView
  labels: { service: string; state: string; closesAt: string | null; formBy: string; validUntil: Record<string, string> }
}) {
  const t = useTranslations('pools')
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const open = view.status === 'open'
  const joined = view.me.status === 'joined'

  async function post(path: string, body: unknown, key: string) {
    setBusy(key)
    setError('')
    try {
      const res = await fetch(`/api/v1/pools/${view.id}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string }
        const known = ['rfq_closed', 'too_late', 'offer_unavailable', 'pool_not_open', 'dual_role'] as const
        const k = known.find((x) => x === d.error)
        setError(k ? t(`err_${k}`) : t('err'))
        return
      }
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-5" data-testid="pool-buyer" data-pool-status={view.status}>
      <header>
        <h1 className="font-display text-2xl font-bold">{t('page_title', { service: labels.service })}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">
          {t('page_subtitle', { n: view.joinedCount, state: labels.state })} · <Badge variant={open ? 'info' : 'default'}>{t(`status_${view.status}`)}</Badge>
        </p>
        {open && labels.closesAt && <p className="mt-1 text-sm">{t('closes_at', { when: labels.closesAt })}</p>}
        {view.status === 'forming' && <p className="mt-1 text-sm">{t('forms_by', { min: view.minMembers, when: labels.formBy })}</p>}
        {!['forming', 'open', 'closing'].includes(view.status) && <p className="mt-2 text-sm text-foreground-secondary">{view.me.quoteId ? t('quoted') : t('ended_note')}</p>}
      </header>

      {view.me.status === 'invited' || view.me.status === 'left' ? (
        <div className="rounded-card border border-border bg-surface p-5">
          <p className="text-sm">{t('invitee_note')}</p>
          <p className="mt-2 text-xs text-foreground-secondary">{t('how_it_works')}</p>
          {(view.status === 'forming' || open) && (
            <Button className="mt-3" size="sm" onClick={() => post('membership', { action: 'join' }, 'join')} loading={busy === 'join'} data-testid="pool-join">{t('join')}</Button>
          )}
        </div>
      ) : (
        <section aria-labelledby="pool-offers-title" className="space-y-3">
          <h2 id="pool-offers-title" className="font-display text-lg font-semibold">{t('offers_title')}</h2>
          {open && <p className="text-xs text-foreground-secondary">{t('choice_note')}</p>}
          {view.offers.length === 0 && <p className="rounded-card border border-border bg-surface p-5 text-sm text-foreground-secondary">{t('no_offers')}</p>}
          <ul className="space-y-3">
            {view.offers.map((o) => {
              const mine = view.me.committedOfferId === o.id
              return (
                <li key={o.id} className={`rounded-card border p-5 ${mine ? 'border-primary bg-primary/5' : 'border-border bg-surface'}`} data-testid="pool-offer" data-offer-id={o.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-semibold">{o.providerName}</p>
                    {mine && <Badge variant="success">{t('chosen')}</Badge>}
                  </div>
                  <ul className="mt-2 space-y-1" aria-label={t('tiers_label')}>
                    {o.tiers.map((tier) => (
                      <li key={tier.minMembers} className="flex flex-wrap justify-between gap-2 text-sm">
                        <span className="text-foreground-secondary">{tier.minMembers === 1 ? t('tier_one') : t('tier_many', { n: tier.minMembers })}</span>
                        <span className="tabular-nums font-medium" data-testid="pool-tier-total">
                          {o.gstIncluded
                            ? t('tier_included', { total: formatINRExact(tier.totalPaise) })
                            : t('tier_extra', { price: formatINRExact(tier.pricePaise), gst: formatINRExact(tier.gstPaise), total: formatINRExact(tier.totalPaise) })}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-foreground-secondary">
                    {t('chosen_by', { n: o.committedCount })} · {t('delivery', { n: o.deliveryDays })} · {t('valid_until', { date: labels.validUntil[o.id] ?? o.validUntil })}
                    {o.advancePercent ? <> · {t('advance', { n: o.advancePercent })}</> : null}
                  </p>
                  <p className="mt-2 whitespace-pre-line text-sm">{o.scope}</p>
                  {o.message && <p className="mt-1 text-sm text-foreground-secondary">{o.message}</p>}
                  {open && joined && (
                    o.availableToMe ? (
                      <div className="mt-3">
                        {mine ? (
                          <Button size="sm" variant="ghost" onClick={() => post('commit', { offer_id: null }, `c:${o.id}`)} loading={busy === `c:${o.id}`}>{t('unchoose')}</Button>
                        ) : (
                          <Button size="sm" onClick={() => post('commit', { offer_id: o.id }, `c:${o.id}`)} loading={busy === `c:${o.id}`} data-testid="pool-choose">{t('choose')}</Button>
                        )}
                      </div>
                    ) : (
                      <p className="mt-3 text-xs text-foreground-secondary">{t('unavailable')}</p>
                    )
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap gap-3">
        <Link href={`/app/rfq/${view.me.rfqId}`} className="text-sm font-medium text-primary underline-offset-2 hover:underline">{t('back_to_request')}</Link>
        {joined && (view.status === 'forming' || open) && (
          <Button size="sm" variant="ghost" onClick={() => post('membership', { action: 'leave' }, 'leave')} loading={busy === 'leave'}>{t('leave')}</Button>
        )}
      </div>
    </div>
  )
}
