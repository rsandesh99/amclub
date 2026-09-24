'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link, useRouter } from '@/i18n/navigation'
import { formatINRExact } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { ConfirmSheet } from '@/components/ui/confirm-sheet'
import { useAnalytics } from '@/components/providers/posthog'

export interface PlanCard {
  id: string
  title: string
  purchasedOn: string
  totalPaise: number
  heldPaise: number
  next: { seq: number; due: string | null } | null
  remaining: number
  children: { id: string; seq: number; title: string; status: string; totalPaise: number; due: string | null; starts: string | null }[]
}

/** E12c — the plans list; the only action is "Cancel remaining" behind a confirm sheet. Figures are the server's. */
export function PlansClient({ plans }: { plans: PlanCard[] }) {
  const t = useTranslations('plans')
  const to = useTranslations('orders')
  const router = useRouter()
  const analytics = useAnalytics()
  const [confirming, setConfirming] = useState<PlanCard | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function cancel(p: PlanCard) {
    setBusy(true)
    setError(null)
    analytics.capture('plan_cancel_requested', { device: 'web', remaining: p.remaining })
    const res = await fetch(`/api/v1/bundles/${p.id}/cancel-remaining`, { method: 'POST' })
    setBusy(false)
    if (!res.ok) return setError(t('cancel_error'))
    setConfirming(null)
    router.refresh()
  }

  if (plans.length === 0) return <p className="mt-6 rounded-card border border-dashed border-border bg-surface px-6 py-12 text-center text-sm text-foreground-secondary">{t('empty')}</p>

  return (
    <div className="mt-6 space-y-5">
      {plans.map((p) => (
        <section key={p.id} className="rounded-card border border-border bg-surface p-5 shadow-card" data-testid="plan-card" data-plan={p.id}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-semibold">{p.title}</h2>
            <span className="text-xs text-foreground-secondary">{t('purchased_on', { date: p.purchasedOn })}</span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div><dt className="text-foreground-secondary">{t('paid')}</dt><dd className="font-medium tabular-nums">{formatINRExact(p.totalPaise)}</dd></div>
            <div><dt className="text-foreground-secondary">{t('held')}</dt><dd className="font-medium tabular-nums" data-testid="plan-held">{formatINRExact(p.heldPaise)}</dd></div>
            {p.next && <div className="col-span-2"><dt className="text-foreground-secondary">{t('next_due')}</dt><dd className="font-medium">{p.next.due ? t('next_line', { seq: p.next.seq, date: p.next.due }) : t('next_line_nodate', { seq: p.next.seq })}</dd></div>}
          </dl>
          <ol className="mt-4 space-y-2 border-t border-border pt-3">
            {p.children.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 text-sm" data-child={c.seq}>
                <Link href={`/app/orders/${c.id}`} className="min-w-0 hover:text-primary">
                  <span className="text-foreground-secondary tabular-nums">{c.seq}.</span> {c.title}
                  <span className="block text-xs text-foreground-secondary">
                    {to.has(`status_${c.status}` as 'status_placed') ? to(`status_${c.status}` as 'status_placed') : c.status}
                    {c.due ? ` · ${t('due_on', { date: c.due })}` : ''}
                  </span>
                </Link>
                <span className="shrink-0 tabular-nums">{formatINRExact(c.totalPaise)}</span>
              </li>
            ))}
          </ol>
          {p.remaining > 0 && (
            <Button className="mt-4" variant="outline" onClick={() => { setError(null); setConfirming(p) }}>{t('cancel_remaining', { count: p.remaining })}</Button>
          )}
        </section>
      ))}
      <ConfirmSheet
        open={confirming != null}
        title={t('cancel_title')}
        confirmLabel={t('cancel_confirm')}
        cancelLabel={t('cancel_keep')}
        busy={busy}
        error={error}
        variant="danger"
        onClose={() => setConfirming(null)}
        onConfirm={() => (confirming ? cancel(confirming) : undefined)}
      >
        {confirming && <p className="text-sm">{t('cancel_body', { count: confirming.remaining })}</p>}
      </ConfirmSheet>
    </div>
  )
}
