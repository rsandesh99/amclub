'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  MILESTONE_OPEN_STATUSES,
  MILESTONE_PHOTO_REQUIRED,
  type MilestoneKind,
} from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EvidenceCapture } from '@/components/orders/EvidenceCapture'

interface Milestone { id: string; kind: MilestoneKind; note: string | null; photo_doc_id: string | null; created_at: string }

/**
 * Services evidence engine (S0.3). Provider captures the next stage as one
 * camera-first action; buyer sees the timeline. work_complete auto-delivers the
 * order. Renders for services orders only (goods have their own workspace).
 */
export function MilestonesCard({ orderId, role, orderStatus }: { orderId: string; role: 'msme' | 'provider'; orderStatus: string }) {
  const t = useTranslations('evidence')
  const [milestones, setMilestones] = useState<Milestone[]>([])
  const [next, setNext] = useState<MilestoneKind | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const d = await fetch(`/api/v1/orders/${orderId}/milestones`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { milestones: [], next: null }))
    setMilestones(d.milestones ?? [])
    setNext(d.next ?? null)
    setLoading(false)
  }, [orderId])
  useEffect(() => { void load() }, [load])

  async function add(kind: MilestoneKind, photoDocId?: string) {
    setBusy(true)
    setError('')
    const body: Record<string, unknown> = { kind }
    if (photoDocId) body['photo_doc_id'] = photoDocId
    if (note.trim()) body['note'] = note.trim()
    const res = await fetch(`/api/v1/orders/${orderId}/milestones`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const d = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) { setError(typeof d.error === 'string' ? d.error : t('add_failed')); return }
    setNote('')
    if (d.delivered) { window.location.reload(); return } // status changed to delivered
    await load()
  }

  const orderOpen = (MILESTONE_OPEN_STATUSES as readonly string[]).includes(orderStatus)
  const canCapture = role === 'provider' && next !== null && orderOpen
  const needsPhoto = next !== null && MILESTONE_PHOTO_REQUIRED.includes(next)

  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card">
      <h2 className="mb-3 text-sm font-semibold">{t('title')}</h2>

      {loading ? (
        <p className="text-sm text-foreground-secondary">{t('loading')}</p>
      ) : (
        <>
          <ol className="space-y-2">
            {milestones.length === 0 && <li className="text-sm text-foreground-secondary">{t('none')}</li>}
            {milestones.map((m) => (
              <li key={m.id} className="flex items-baseline gap-2 text-sm">
                <span aria-hidden className="text-success">✓</span>
                <span className="font-medium">{t(`kind_${m.kind}` as 'kind_accepted')}</span>
                {m.photo_doc_id && <span className="text-xs text-foreground-secondary">📷 {t('photo_attached')}</span>}
                {m.note && <span className="text-xs text-foreground-secondary">— {m.note}</span>}
              </li>
            ))}
          </ol>

          {canCapture && next && (
            <div className="mt-4 space-y-2 border-t border-border pt-4">
              <p className="text-sm font-medium">{t('next_stage', { stage: t(`kind_${next}` as 'kind_accepted') })}</p>
              <Input aria-label={t('note_label')} placeholder={t('note_placeholder')} value={note} onChange={(e) => setNote(e.target.value)} />
              {needsPhoto ? (
                <EvidenceCapture
                  orderId={orderId}
                  kind="milestone_photo"
                  label={t('capture_photo')}
                  onUploaded={(docId) => void add(next, docId)}
                />
              ) : (
                <Button loading={busy} onClick={() => void add(next)}>{t('mark_done', { stage: t(`kind_${next}` as 'kind_accepted') })}</Button>
              )}
              {error && <p className="text-sm text-danger">{error}</p>}
            </div>
          )}
          {role === 'msme' && next && orderOpen && (
            <p className="mt-4 border-t border-border pt-4 text-xs text-foreground-secondary">{t('buyer_waiting')}</p>
          )}
        </>
      )}
    </div>
  )
}
