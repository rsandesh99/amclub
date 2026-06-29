'use client'

import { useEffect, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function AdminMsmesPage() {
  const t = useTranslations('admin_ops')
  const [q, setQ] = useState('')
  const [msmes, setMsmes] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const sp = new URLSearchParams()
    if (q.trim()) sp.set('q', q.trim())
    const res = await fetch(`/api/v1/admin/msmes?${sp}`, { cache: 'no-store' })
    if (res.ok) setMsmes((await res.json()).msmes ?? [])
    setLoading(false)
  }, [q])
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <h1 className="font-display text-2xl font-bold">{t('msmes_title')}</h1>
      <form onSubmit={(e) => { e.preventDefault(); load() }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('msmes_search')} className="rounded-button border border-border bg-background p-2 text-sm" />
      </form>

      {loading ? <p className="text-sm text-foreground-secondary">{t('loading')}</p> : (
        <div className="overflow-x-auto rounded-card border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-foreground-secondary">
              <tr><th className="p-3">{t('msmes_title')}</th><th className="p-3">{t('state')}</th><th className="p-3">{t('status')}</th><th className="p-3"></th></tr>
            </thead>
            <tbody>
              {msmes.map((m) => (
                <tr key={m.id} className="border-b border-border last:border-0">
                  <td className="p-3 font-medium">{m.business_name}</td>
                  <td className="p-3">{m.state ?? '—'}</td>
                  <td className="p-3">{m.deleted_at ? <span className="text-danger">{t('suspended')}</span> : t('active')}</td>
                  <td className="p-3 text-right"><Link href={`/admin/msmes/${m.id}` as '/admin/msmes'} className="text-trust underline">{t('view')}</Link></td>
                </tr>
              ))}
              {msmes.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-foreground-secondary">{t('none')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */
