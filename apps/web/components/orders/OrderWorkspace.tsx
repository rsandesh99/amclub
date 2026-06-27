'use client'

import { useState, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { formatINR } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ReviewSection } from './ReviewSection'

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

// Timeline event → an existing translation key (mostly status labels).
const EVENT_LABEL: Record<string, string> = {
  placed: 'status_placed',
  accept: 'status_accepted',
  submit_requirements: 'status_requirements_submitted',
  requirements_data: 'event_requirements',
  start: 'status_in_progress',
  deliver: 'status_delivered',
  document_uploaded: 'event_document',
  accept_delivery: 'status_completed',
  auto_accepted: 'status_completed',
  request_revision: 'status_revision_requested',
  resume: 'status_in_progress',
  cancel: 'status_cancelled_by_buyer',
  auto_cancelled: 'status_auto_cancelled',
  refunded: 'status_refunded',
  raise_dispute: 'status_disputed',
  external_wait: 'event_external_wait',
  external_resume: 'event_external_resume',
}

// Events that represent EXTERNAL (government/portal) time, not provider time.
const EXTERNAL_EVENTS = new Set(['external_wait', 'external_resume'])

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
  // External/government wait is a DISPLAY sub-state on in_progress (LOCK 5).
  const externalWait = status === 'in_progress' && !!order['external_wait_since']
  const statusVariant = externalWait ? 'warning' : (STATUS_VARIANT[status] ?? 'default')
  const statusLabel = externalWait ? t('status_external_wait') : t(`status_${status}` as 'status_placed')

  async function toggleExternalWait(active: boolean) {
    setBusy('external_wait')
    setError('')
    try {
      const res = await fetch(`/api/v1/orders/${id}/external-wait`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(typeof d.error === 'string' ? d.error : t('action_failed'))
      }
      router.refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('action_failed'))
    } finally {
      setBusy(null)
    }
  }

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
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : t('action_failed'))
      router.refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('action_failed'))
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
        throw new Error(typeof d.error === 'string' ? d.error : t('upload_failed'))
      }
      router.refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('upload_failed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 space-y-6">
      {/* Header */}
      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-foreground-secondary">{String(order['order_number'])}</p>
            <h1 className="font-display text-xl font-bold">{String(order['title'])}</h1>
          </div>
          <Badge variant={statusVariant}>{statusLabel}</Badge>
        </div>
        {externalWait && (
          <p className="mt-3 rounded-button bg-warning/10 px-3 py-2 text-xs text-warning">
            {t('external_wait_banner')}
          </p>
        )}
        <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-4 text-sm">
          <div><dt className="text-foreground-secondary">{t('total')}</dt><dd className="font-medium">{formatINR(Number(order['total_paise']))}</dd></div>
          {viewerRole === 'provider' && (
            <div><dt className="text-foreground-secondary">{t('you_earn')}</dt><dd className="font-medium">{formatINR(Number(order['provider_earning_paise']))}</dd></div>
          )}
        </dl>
      </div>

      {/* Actions */}
      {(actions.length > 0 || (viewerRole === 'provider' && status === 'in_progress')) && (
        <div className="rounded-card border border-border bg-surface p-5 shadow-card space-y-3">
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
            {/* Provider: flag/clear government-portal wait (display sub-state, LOCK 5) */}
            {viewerRole === 'provider' && status === 'in_progress' && (
              <Button
                variant="outline"
                onClick={() => toggleExternalWait(!externalWait)}
                loading={busy === 'external_wait'}
              >
                {externalWait ? t('action_resume_external') : t('action_mark_external_wait')}
              </Button>
            )}
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      )}

      {/* Reviews — prompt/form for the buyer on completion; reply box for the provider */}
      {(status === 'completed' || status === 'reviewed') && <ReviewSection orderId={id} />}

      {/* Documents */}
      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
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
      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <h2 className="mb-3 text-sm font-semibold">{t('timeline')}</h2>
        <ol className="space-y-3">
          {events.map((e) => {
            const isExternal = EXTERNAL_EVENTS.has(e.event)
            return (
              <li key={e.id} className="flex gap-3 text-sm">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${isExternal ? 'bg-warning' : 'bg-primary'}`} />
                <div>
                  <p className="font-medium">
                    {EVENT_LABEL[e.event] ? t(EVENT_LABEL[e.event] as 'status_placed') : e.event.replace(/_/g, ' ')}
                    {isExternal && (
                      <span className="ml-2 rounded-chip bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning">
                        {t('external_time_tag')}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-foreground-secondary">
                    {new Date(e.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
                  </p>
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
