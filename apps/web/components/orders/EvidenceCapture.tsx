'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { enqueueUpload, flushQueue, subscribe, discardQueued, type QueuedUpload } from '@/lib/offline/upload-queue'

/**
 * Camera-first evidence capture, shared by goods dispatch/delivery (and
 * available to services milestones): opens the rear camera, writes the
 * capture to the offline queue, uploads, and shows a retry chip while a
 * photo is waiting for signal. `onUploaded` receives the order_documents id.
 */
export function EvidenceCapture({
  orderId,
  kind,
  label,
  accept = 'image/*',
  onUploaded,
  compact = false,
}: {
  orderId: string
  kind: 'dispatch_photo' | 'delivery_photo' | 'other' | 'deliverable'
  label: string
  accept?: string
  onUploaded: (docId: string) => void
  compact?: boolean
}) {
  const t = useTranslations('mart')
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [queued, setQueued] = useState<QueuedUpload[]>([])
  const endpoint = `/api/v1/orders/${orderId}/documents`

  useEffect(() => {
    const unsub = subscribe((items) => setQueued(items.filter((i) => i.endpoint === endpoint && i.fields['kind'] === kind)))
    const retry = () => void flushQueue((item, id) => { if (item.endpoint === endpoint && item.fields['kind'] === kind && id) { onUploaded(id); setDone(true) } })
    window.addEventListener('online', retry)
    retry()
    return () => { unsub(); window.removeEventListener('online', retry) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, kind])

  async function onFile(file: File) {
    setBusy(true)
    try {
      const { id } = await enqueueUpload({ endpoint, fields: { kind }, file })
      if (id) { onUploaded(id); setDone(true) }
    } finally { setBusy(false) }
  }

  const mine = queued
  return (
    <div className="space-y-2">
      <input ref={ref} type="file" accept={accept} capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = '' }} />
      <Button variant={done ? 'secondary' : 'primary'} size={compact ? 'sm' : 'md'} className={done ? '' : 'bg-emerald hover:bg-emerald-ink'} loading={busy} onClick={() => ref.current?.click()}>
        {done ? `✓ ${label}` : label}
      </Button>
      {mine.length > 0 && (
        <ul className="space-y-1" aria-live="polite">
          {mine.map((q) => (
            <li key={q.id} className="flex items-center justify-between gap-2 rounded-button bg-warning/10 px-3 py-2 text-xs text-warning">
              <span className="truncate">{q.fileName} · {q.attempts >= 99 ? (q.lastError ?? t('upload_failed')) : t('queued_upload')}</span>
              <span className="flex shrink-0 gap-2">
                {q.attempts < 99 && <button type="button" className="font-semibold underline" onClick={() => void flushQueue((item, id) => { if (item.id === q.id && id) { onUploaded(id); setDone(true) } })}>{t('retry_upload')}</button>}
                <button type="button" className="underline" onClick={() => void discardQueued(q.id)}>{t('remove')}</button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
