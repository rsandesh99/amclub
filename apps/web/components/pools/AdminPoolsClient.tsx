'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export interface AdminPoolRow {
  id: string
  service: string
  state: string
  status: string
  invited: number
  joined: number
  offers: number
  quoted: number
  paid: number
  closes: string
}

/** S3.4 (ADR 024) — the ops list of group requests, with a cancel for a forming or open group (reason audited). */
export function AdminPoolsClient({ rows }: { rows: AdminPoolRow[] }) {
  const t = useTranslations('pools')
  const router = useRouter()
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState('')

  async function cancel(id: string) {
    const res = await fetch(`/api/v1/agent/admin/pools/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) })
    setMsg(res.ok ? t('cancelled_ok') : t('err'))
    if (res.ok) { setCancelling(null); setReason(''); router.refresh() }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8" data-testid="admin-pools">
      <h1 className="font-display text-2xl font-bold">{t('admin_title')}</h1>
      <p className="mt-1 text-sm text-foreground-secondary">{t('admin_subtitle')}</p>
      {msg && <p role="status" className="mt-3 text-sm">{msg}</p>}
      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-foreground-secondary">{t('admin_empty')}</p>
      ) : (
        <div className="mt-6 overflow-x-auto" tabIndex={0} role="region" aria-label={t('admin_title')}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-foreground-secondary">
                <th className="py-2 pr-3 font-medium">{t('col_service')}</th>
                <th className="py-2 pr-3 font-medium">{t('col_state')}</th>
                <th className="py-2 pr-3 font-medium">{t('col_status')}</th>
                <th className="py-2 pr-3 font-medium">{t('col_joined')}</th>
                <th className="py-2 pr-3 font-medium">{t('col_offers')}</th>
                <th className="py-2 pr-3 font-medium">{t('col_quoted')}</th>
                <th className="py-2 pr-3 font-medium">{t('col_paid')}</th>
                <th className="py-2 pr-3 font-medium">{t('col_closes')}</th>
                <th className="py-2"><span className="sr-only">{t('cancel')}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border align-top" data-pool-id={r.id}>
                  <td className="py-2 pr-3">{r.service}</td>
                  <td className="py-2 pr-3">{r.state}</td>
                  <td className="py-2 pr-3">{t(`status_${r.status}`)}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.joined} / {r.invited}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.offers}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.quoted}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.paid}</td>
                  <td className="py-2 pr-3">{r.closes}</td>
                  <td className="py-2">
                    {(r.status === 'forming' || r.status === 'open') && (
                      cancelling === r.id ? (
                        <div className="flex min-w-56 flex-col gap-2">
                          <label htmlFor={`cancel-${r.id}`} className="text-xs">{t('cancel_reason')}</label>
                          <Input id={`cancel-${r.id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
                          <Button size="sm" variant="danger" disabled={reason.trim().length < 3} onClick={() => cancel(r.id)}>{t('cancel')}</Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => { setCancelling(r.id); setMsg('') }}>{t('cancel')}</Button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
