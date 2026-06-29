'use client'

import { useEffect, useState, useCallback, use } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { formatINR } from '@/lib/format'
import { Button } from '@/components/ui/button'

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function DisputeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const t = useTranslations('admin_ops')
  const router = useRouter()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [partialRupees, setPartialRupees] = useState('')

  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/admin/disputes/${id}`, { cache: 'no-store' })
    if (res.ok) setData(await res.json())
    setLoading(false)
  }, [id])
  useEffect(() => { load() }, [load])

  async function resolve(resolution: string) {
    setBusy(true); setError('')
    const body: any = { resolution }
    if (resolution === 'refund_partial') body.amountPaise = Math.round(Number(partialRupees) * 100)
    const res = await fetch(`/api/v1/admin/disputes/${id}/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const d = await res.json()
    setBusy(false)
    if (!res.ok) { setError(typeof d.error === 'string' ? d.error : 'Failed'); return }
    await load()
  }

  if (loading || !data) return <p className="text-sm text-foreground-secondary">{t('loading')}</p>
  const { dispute, order, events, payment, payout, refund } = data
  const resolved = dispute.status === 'resolved'
  const total = Number(order?.total_paise ?? 0)

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <button onClick={() => router.push('/admin/disputes')} className="text-sm text-trust">← {t('back')}</button>
      <h1 className="font-display text-xl font-bold">{t('order')} {order?.order_number}</h1>

      {/* Amounts */}
      <div className="rounded-card border border-border bg-surface p-4 text-sm">
        <Row label={t('total')} value={formatINR(total)} />
        <Row label={t('provider')} value={formatINR(Number(order?.provider_earning_paise ?? 0))} />
        <Row label={t('payment')} value={payment ? `${payment.status} · ${formatINR(Number(payment.amount_paise))}` : '—'} />
        <Row label={t('payout')} value={payout ? `${payout.status} · ${formatINR(Number(payout.amount_paise))}` : '—'} />
        <Row label={t('manual_refund')} value={refund ? `${refund.status} · ${formatINR(Number(refund.amount_paise))}` : '—'} />
      </div>

      {/* Resolution */}
      {resolved ? (
        <div className="rounded-card border border-success/30 bg-success/10 p-4 text-sm">
          <p className="font-medium text-success">{t('resolved_ok')}</p>
          <p className="mt-1">{t(dispute.resolution as 'refund_full')} · {t('buyer_refund')}: {formatINR(Number(dispute.resolution_amount_paise ?? 0))}</p>
        </div>
      ) : (
        <div className="rounded-card border border-border bg-surface p-4 space-y-3">
          <h2 className="text-sm font-semibold">{t('resolve')}</h2>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" onClick={() => resolve('refund_full')} loading={busy}>{t('refund_full')}</Button>
            <Button onClick={() => resolve('release')} loading={busy}>{t('release')}</Button>
          </div>
          <div className="flex items-end gap-2 border-t border-border pt-3">
            <label className="flex-1 text-xs">{t('partial_amount')}
              <input type="number" value={partialRupees} onChange={(e) => setPartialRupees(e.target.value)} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" placeholder={`≤ ${formatINR(total)}`} />
            </label>
            <Button variant="outline" onClick={() => resolve('refund_partial')} loading={busy} disabled={!partialRupees}>{t('refund_partial')}</Button>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      )}

      {/* Timeline */}
      <div className="rounded-card border border-border bg-surface p-4">
        <h2 className="mb-2 text-sm font-semibold">{t('timeline')}</h2>
        <ol className="space-y-2">
          {events.map((e: any) => (
            <li key={e.id} className="flex gap-2 text-sm">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
              <div>
                <p className="capitalize">{String(e.event).replace(/_/g, ' ')}</p>
                <p className="text-xs text-foreground-secondary">{new Date(e.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between border-b border-border py-1.5 last:border-0"><span className="text-foreground-secondary">{label}</span><span className="tabular-nums">{value}</span></div>
}
/* eslint-enable @typescript-eslint/no-explicit-any */
