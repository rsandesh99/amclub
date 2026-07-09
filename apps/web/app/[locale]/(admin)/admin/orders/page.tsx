'use client'

import { useEffect, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { formatINR } from '@/lib/format'

/* eslint-disable @typescript-eslint/no-explicit-any */

const STATUSES = ['', 'placed', 'accepted', 'in_progress', 'delivered', 'completed', 'disputed', 'resolved_refund', 'resolved_partial', 'resolved_release', 'refunded', 'auto_cancelled']

export default function AdminOrdersPage() {
  const t = useTranslations('admin_ops')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [orders, setOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const sp = new URLSearchParams()
    if (q.trim()) sp.set('q', q.trim())
    if (status) sp.set('status', status)
    const res = await fetch(`/api/v1/admin/orders?${sp}`, { cache: 'no-store' })
    if (res.ok) setOrders((await res.json()).orders ?? [])
    setLoading(false)
  }, [q, status])
  useEffect(() => { load() }, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <h1 className="font-display text-2xl font-bold">{t('orders_title')}</h1>
      <div className="flex flex-wrap gap-2">
        <form onSubmit={(e) => { e.preventDefault(); load() }}><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('orders_search')} className="rounded-button border border-border bg-background p-2 text-sm" /></form>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('status')} className="rounded-button border border-border bg-background p-2 text-sm">
          {STATUSES.map((s) => <option key={s} value={s}>{s || t('all')}</option>)}
        </select>
      </div>

      {loading ? <p className="text-sm text-foreground-secondary">{t('loading')}</p> : (
        <div className="overflow-x-auto rounded-card border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-foreground-secondary">
              <tr><th className="p-3">{t('order')}</th><th className="p-3">{t('status')}</th><th className="p-3">{t('total')}</th><th className="p-3"></th></tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-border last:border-0">
                  <td className="p-3 font-medium">{o.order_number}<span className="ml-1 text-xs text-foreground-secondary">{o.source}</span></td>
                  <td className="p-3">{o.status}</td>
                  <td className="p-3 tabular-nums">{formatINR(Number(o.total_paise))}</td>
                  <td className="p-3 text-right"><Link href={`/admin/orders/${o.id}` as '/admin/orders'} className="text-trust underline">{t('view')}</Link></td>
                </tr>
              ))}
              {orders.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-foreground-secondary">{t('none')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */
