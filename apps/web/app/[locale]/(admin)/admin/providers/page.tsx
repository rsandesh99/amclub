'use client'

import { useEffect, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { ReadinessBadge } from '@/components/admin/ReadinessBadge'

/* eslint-disable @typescript-eslint/no-explicit-any */

const STATUSES = ['', 'active', 'under_review', 'pending_kyc', 'suspended', 'rejected']
// Phase 3a — payout-readiness filter (see lib/payments/readiness.ts).
const READINESS = ['', 'unready', 'ready', 'missing_route', 'bank_unverified', 'not_ready', 'no_bank']

export default function AdminProvidersPage() {
  const t = useTranslations('admin_ops')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [readiness, setReadiness] = useState('')
  const [providers, setProviders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const sp = new URLSearchParams()
    if (q.trim()) sp.set('q', q.trim())
    if (status) sp.set('status', status)
    if (readiness) sp.set('readiness', readiness)
    const res = await fetch(`/api/v1/admin/providers?${sp}`, { cache: 'no-store' })
    const d = await res.json().catch(() => null)
    if (res.ok && d) setProviders(d.providers ?? [])
    setLoading(false)
  }, [q, status, readiness])
  useEffect(() => { load() }, [status, readiness]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <h1 className="font-display text-2xl font-bold">{t('providers_title')}</h1>
      <div className="flex flex-wrap gap-2">
        <form onSubmit={(e) => { e.preventDefault(); load() }} className="flex gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('providers_search')} className="rounded-button border border-border bg-background p-2 text-sm" />
        </form>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('status')} className="rounded-button border border-border bg-background p-2 text-sm">
          {STATUSES.map((s) => <option key={s} value={s}>{s || t('all')}</option>)}
        </select>
        <select value={readiness} onChange={(e) => setReadiness(e.target.value)} aria-label={t('readiness')} className="rounded-button border border-border bg-background p-2 text-sm">
          {READINESS.map((r) => (
            <option key={r} value={r}>{r === '' ? t('readiness_all') : r === 'unready' ? t('readiness_unready') : t(`readiness_${r}` as 'readiness_ready')}</option>
          ))}
        </select>
      </div>

      {loading ? <p className="text-sm text-foreground-secondary">{t('loading')}</p> : (
        <div className="overflow-x-auto rounded-card border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-foreground-secondary">
              <tr><th className="p-3">{t('providers_title')}</th><th className="p-3">{t('state')}</th><th className="p-3">{t('status')}</th><th className="p-3">{t('readiness')}</th><th className="p-3">{t('rating')}</th><th className="p-3"></th></tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id} className="border-b border-border last:border-0">
                  <td className="p-3 font-medium">{p.display_name}{p.capacity_paused && <span className="ml-1 text-xs text-warning">⏸</span>}</td>
                  <td className="p-3">{p.state}</td>
                  <td className="p-3">{p.status}</td>
                  <td className="p-3"><ReadinessBadge readiness={p.readiness} /></td>
                  <td className="p-3">★ {p.avg_rating} ({p.review_count})</td>
                  <td className="p-3 text-right"><Link href={`/admin/providers/${p.id}` as '/admin/providers'} className="text-trust underline">{t('view')}</Link></td>
                </tr>
              ))}
              {providers.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-foreground-secondary">{readiness ? t('readiness_none_match') : t('none')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */
