'use client'

import { useEffect, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function AdminAuditPage() {
  const t = useTranslations('admin_ops')
  const [action, setAction] = useState('')
  const [logs, setLogs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const sp = new URLSearchParams()
    if (action.trim()) sp.set('action', action.trim())
    const res = await fetch(`/api/v1/admin/audit?${sp}`, { cache: 'no-store' })
    if (res.ok) setLogs((await res.json()).logs ?? [])
    setLoading(false)
  }, [action])
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <h1 className="font-display text-2xl font-bold">{t('audit_title')}</h1>
      <form onSubmit={(e) => { e.preventDefault(); load() }}>
        <input value={action} onChange={(e) => setAction(e.target.value)} placeholder={t('audit_search')} className="rounded-button border border-border bg-background p-2 text-sm" />
      </form>

      {loading ? <p className="text-sm text-foreground-secondary">{t('loading')}</p> : logs.length === 0 ? (
        <div className="rounded-card border border-border bg-surface p-10 text-center text-sm text-foreground-secondary">{t('none')}</div>
      ) : (
        <ul className="space-y-2">
          {logs.map((l) => (
            <li key={l.id} className="rounded-card border border-border bg-surface p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-mono font-medium">{l.action}</span>
                <span className="text-xs text-foreground-secondary">{new Date(l.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</span>
              </div>
              <p className="text-xs text-foreground-secondary">{t('entity')}: {l.entity} · {t('actor')}: {l.actor?.email ?? l.actor_id ?? 'system'}{l.ip ? ` · ${l.ip}` : ''}</p>
              {(l.before || l.after) && (
                <pre tabIndex={0} role="region" aria-label={t('diff')} className="mt-1 overflow-x-auto rounded bg-background p-2 text-[11px] text-foreground-secondary">{JSON.stringify({ before: l.before, after: l.after }, null, 0)}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */
