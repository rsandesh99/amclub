'use client'

import { useEffect, useState, useCallback, use } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { formatINR } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { AdminScoreBlock } from '@/components/admin/AdminScoreBlock'

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function MsmeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const t = useTranslations('admin_ops')
  const router = useRouter()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/admin/msmes/${id}`, { cache: 'no-store' })
    if (res.ok) setData(await res.json())
    setLoading(false)
  }, [id])
  useEffect(() => { load() }, [load])

  async function act(body: any) {
    setBusy(true)
    const res = await fetch(`/api/v1/admin/msmes/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setBusy(false)
    if (res.ok) await load()
  }
  function suspend() {
    const reason = window.prompt(t('reason'))
    if (reason && reason.trim()) act({ action: 'suspend', reason: reason.trim() })
  }

  if (loading || !data) return <p className="text-sm text-foreground-secondary">{t('loading')}</p>
  const m = data.msme

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <button onClick={() => router.push('/admin/msmes')} className="text-sm text-trust">← {t('back')}</button>
      <div className="flex items-start justify-between rounded-card border border-border bg-surface p-4">
        <div>
          <h1 className="font-display text-xl font-bold">{m.business_name}</h1>
          <p className="text-sm text-foreground-secondary">{m.sector ?? '—'} · {m.state ?? '—'} · {m.deleted_at ? t('suspended') : t('active')}</p>
        </div>
        {m.deleted_at
          ? <Button onClick={() => act({ action: 'reactivate' })} loading={busy}>{t('reactivate')}</Button>
          : <Button variant="danger" onClick={suspend} loading={busy}>{t('suspend')}</Button>}
      </div>

      {/* S2.4 — the buyer score is admin-only in v1 */}
      <AdminScoreBlock side="buyer" id={id} />

      <div className="rounded-card border border-border bg-surface p-4">
        <h2 className="mb-2 text-sm font-semibold">{t('orders_title')}</h2>
        {data.orders.length === 0 ? <p className="text-sm text-foreground-secondary">{t('none')}</p> : data.orders.map((o: any) => (
          <div key={o.id} className="flex justify-between border-b border-border py-1.5 text-sm last:border-0"><span>{o.order_number}</span><span className="text-foreground-secondary">{o.status} · {formatINR(Number(o.total_paise))}</span></div>
        ))}
      </div>
    </div>
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */
