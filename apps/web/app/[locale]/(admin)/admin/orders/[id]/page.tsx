'use client'

import { useEffect, useState, useCallback, use } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { formatINR } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { DossierPanel } from '@/components/admin/DossierPanel'

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function AdminOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const t = useTranslations('admin_ops')
  const router = useRouter()
  const { toast } = useToast()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/admin/orders/${id}`, { cache: 'no-store' })
    if (res.ok) setData(await res.json())
    setLoading(false)
  }, [id])
  useEffect(() => { load() }, [load])

  async function act(body: any) {
    setBusy(true)
    const res = await fetch(`/api/v1/admin/orders/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setBusy(false)
    if (res.ok) { await load(); toast(t('action_done'), 'success') }
    else { const d = await res.json().catch(() => ({})); toast(typeof d.error === 'string' ? d.error : t('action_failed'), 'error') }
  }
  function manualRefund() {
    const r = window.prompt(t('refund_amount'))
    const rupees = Number(r)
    if (rupees > 0) act({ action: 'manual_refund', amountPaise: Math.round(rupees * 100) })
  }

  if (loading || !data) return <p className="text-sm text-foreground-secondary">{t('loading')}</p>
  const { order, events, payment, payout, refund, dossier } = data
  const payoutStuck = payout && (payout.status === 'failed' || payout.status === 'held')

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <button onClick={() => router.push('/admin/orders')} className="text-sm text-trust">← {t('back')}</button>
      <div className="rounded-card border border-border bg-surface p-4">
        <h1 className="font-display text-xl font-bold">{order.order_number}</h1>
        <p className="text-sm text-foreground-secondary">{order.title} · {order.status}</p>
        <dl className="mt-3 space-y-1 text-sm">
          <Row label={t('total')} value={formatINR(Number(order.total_paise))} />
          <Row label={t('commission')} value={formatINR(Number(order.commission_paise))} />
          <Row label={t('payment')} value={payment ? `${payment.status} · ${formatINR(Number(payment.amount_paise))}` : '—'} />
          <Row label={t('payout')} value={payout ? `${payout.status} · ${formatINR(Number(payout.amount_paise))}` : '—'} />
          <Row label={t('manual_refund')} value={refund ? `${refund.status} · ${formatINR(Number(refund.amount_paise))}` : '—'} />
        </dl>
      </div>

      <div className="flex flex-wrap gap-2 rounded-card border border-border bg-surface p-4">
        {payoutStuck && <Button onClick={() => act({ action: 'retry_payout' })} loading={busy}>{t('retry_payout')}</Button>}
        {payment && !refund && <Button variant="outline" onClick={manualRefund} loading={busy}>{t('manual_refund')}</Button>}
      </div>

      {/* S1.4 — the Payout-Evidence agent's dossier (the detail route returns `dossier` only while AGENT_ENABLED). */}
      {dossier && (
        <div className="rounded-card border border-border bg-surface p-4">
          <DossierPanel dossierId={dossier.id} onChanged={load} />
        </div>
      )}

      <div className="rounded-card border border-border bg-surface p-4">
        <h2 className="mb-2 text-sm font-semibold">{t('timeline')}</h2>
        <ol className="space-y-2">
          {events.map((e: any) => (
            <li key={e.id} className="flex gap-2 text-sm">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
              <div><p className="capitalize">{String(e.event).replace(/_/g, ' ')}</p><p className="text-xs text-foreground-secondary">{new Date(e.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</p></div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between"><dt className="text-foreground-secondary">{label}</dt><dd className="tabular-nums">{value}</dd></div>
}
/* eslint-enable @typescript-eslint/no-explicit-any */
