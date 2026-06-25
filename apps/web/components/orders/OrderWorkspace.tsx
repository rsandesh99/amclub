'use client'

import { useState, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { formatINR } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

interface OrderEvent {
  id: string
  event: string
  created_at: string
  actor_id: string | null
}

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  placed: 'info', accepted: 'info', requirements_submitted: 'info', in_progress: 'warning',
  delivered: 'warning', revision_requested: 'warning', completed: 'success', reviewed: 'success',
  disputed: 'danger', refunded: 'default', auto_cancelled: 'default', cancelled_by_buyer: 'default',
}

// Which actions each role sees for a given status.
function actionsFor(role: 'msme' | 'provider', status: string): { action: string; label: string; variant?: 'primary' | 'danger' | 'outline' }[] {
  if (role === 'provider') {
    if (status === 'placed') return [{ action: 'accept', label: 'accept' }]
    if (status === 'requirements_submitted') return [{ action: 'start', label: 'start' }]
    if (status === 'in_progress') return [{ action: 'deliver', label: 'deliver' }]
    if (status === 'revision_requested') return [{ action: 'resume', label: 'resume' }]
  } else {
    if (status === 'accepted') return [{ action: 'submit_requirements', label: 'submit_requirements' }]
    if (status === 'delivered') return [
      { action: 'accept_delivery', label: 'accept_delivery' },
      { action: 'request_revision', label: 'request_revision', variant: 'outline' },
    ]
    if (status === 'placed' || status === 'accepted') return [{ action: 'cancel', label: 'cancel', variant: 'danger' }]
  }
  return []
}

interface DocItem { id: string; file_name: string; kind: string; signedUrl: string | null }

export function OrderWorkspace({
  order,
  events,
  viewerRole,
  documents,
}: {
  order: Record<string, unknown>
  events: OrderEvent[]
  viewerRole: 'msme' | 'provider'
  documents: DocItem[]
}) {
  const t = useTranslations('orders')
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const id = order['id'] as string
  const status = order['status'] as string
  const actions = actionsFor(viewerRole, status)

  async function doAction(action: string) {
    setBusy(action)
    setError('')
    try {
      // Deliver requires a deliverable doc to exist; provider uploads first if none.
      const res = await fetch(`/api/v1/orders/${id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Action failed')
      router.refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  async function uploadDoc(kind: string, file: File) {
    setBusy('upload')
    setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('kind', kind)
      const res = await fetch(`/api/v1/orders/${id}/documents`, { method: 'POST', body: fd })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? 'Upload failed')
      }
      router.refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 space-y-6">
      {/* Header */}
      <div className="rounded-card border border-gray-200 bg-surface p-5 shadow-card">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-foreground-secondary">{String(order['order_number'])}</p>
            <h1 className="font-display text-xl font-bold">{String(order['title'])}</h1>
          </div>
          <Badge variant={STATUS_VARIANT[status] ?? 'default'}>{t(`status_${status}` as 'status_placed')}</Badge>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-gray-100 pt-4 text-sm">
          <div><dt className="text-foreground-secondary">{t('total')}</dt><dd className="font-medium">{formatINR(Number(order['total_paise']))}</dd></div>
          {viewerRole === 'provider' && (
            <div><dt className="text-foreground-secondary">{t('you_earn')}</dt><dd className="font-medium">{formatINR(Number(order['provider_earning_paise']))}</dd></div>
          )}
        </dl>
      </div>

      {/* Actions */}
      {actions.length > 0 && (
        <div className="rounded-card border border-gray-200 bg-surface p-5 shadow-card space-y-3">
          <h2 className="text-sm font-semibold">{t('actions')}</h2>
          {/* Provider deliver flow: attach a deliverable */}
          {viewerRole === 'provider' && status === 'in_progress' && (
            <div>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadDoc('deliverable', f) }}
              />
              <Button variant="secondary" onClick={() => fileRef.current?.click()} loading={busy === 'upload'}>
                {t('attach_deliverable')}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <Button key={a.action} variant={a.variant ?? 'primary'} onClick={() => doAction(a.action)} loading={busy === a.action}>
                {t(`action_${a.label}` as 'action_accept')}
              </Button>
            ))}
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      )}

      {/* Documents */}
      <div className="rounded-card border border-gray-200 bg-surface p-5 shadow-card">
        <h2 className="mb-3 text-sm font-semibold">{t('documents')}</h2>
        {documents.length === 0 ? (
          <p className="text-sm text-foreground-secondary">{t('no_documents')}</p>
        ) : (
          <ul className="space-y-2">
            {documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between text-sm">
                <span>📎 {d.file_name} <span className="text-xs text-foreground-secondary">({d.kind})</span></span>
                {d.signedUrl && <a href={d.signedUrl} target="_blank" rel="noopener noreferrer" className="text-trust underline">{t('download')}</a>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Timeline */}
      <div className="rounded-card border border-gray-200 bg-surface p-5 shadow-card">
        <h2 className="mb-3 text-sm font-semibold">{t('timeline')}</h2>
        <ol className="space-y-3">
          {events.map((e) => (
            <li key={e.id} className="flex gap-3 text-sm">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
              <div>
                <p className="font-medium capitalize">{e.event.replace(/_/g, ' ')}</p>
                <p className="text-xs text-foreground-secondary">
                  {new Date(e.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
