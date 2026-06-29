'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { formatINR } from '@/lib/format'

/* eslint-disable @typescript-eslint/no-explicit-any */

const STATUSES = ['open', 'under_review', 'resolved'] as const

export default function AdminDisputesPage() {
  const t = useTranslations('admin_ops')
  const [status, setStatus] = useState<string>('open')
  const [disputes, setDisputes] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/v1/admin/disputes${status ? `?status=${status}` : ''}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { disputes: [] }))
      .then((d) => setDisputes(d.disputes ?? []))
      .finally(() => setLoading(false))
  }, [status])

  return (
    <div className="space-y-4">
      <h1 className="font-display text-2xl font-bold">{t('disputes_title')}</h1>

      <div className="flex gap-1">
        {STATUSES.map((s) => (
          <button key={s} onClick={() => setStatus(s)} className={`rounded-button px-3 py-1.5 text-sm ${status === s ? 'bg-primary text-white' : 'border border-border'}`}>
            {t(s)}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-foreground-secondary">{t('loading')}</p>
      ) : disputes.length === 0 ? (
        <div className="rounded-card border border-border bg-surface p-10 text-center text-sm text-foreground-secondary">{t('none')}</div>
      ) : (
        <ul className="space-y-2">
          {disputes.map((d) => (
            <li key={d.id}>
              <Link href={`/admin/disputes/${d.id}` as '/admin/disputes'} className="flex items-center justify-between rounded-card border border-border bg-surface p-4 hover:border-primary/40">
                <div>
                  <p className="text-sm font-medium">{d.order?.order_number} · {d.order?.title}</p>
                  <p className="text-xs text-foreground-secondary">{d.reason} · {new Date(d.created_at).toLocaleDateString('en-IN')}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold">{formatINR(Number(d.order?.total_paise ?? 0))}</p>
                  <p className="text-xs text-foreground-secondary">{t(d.status as 'open')}{d.resolution ? ` · ${t(d.resolution as 'refund_full')}` : ''}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */
