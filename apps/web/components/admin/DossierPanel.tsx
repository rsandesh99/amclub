'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { anomalyKind, type DossierCheck, type PhotoFinding } from '@amclub/shared'
import { formatINR } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Payout dossier panel (S1.4 §4e). Shows what the Payout-Evidence agent found
 * — checks ✓/✗ with detail, anomalies, the photos with their findings and
 * concerns, recommendation + rationale, model cost — and the founder's two
 * buttons. Approve calls the EXISTING release route with dossier_id (the
 * money-moving tap; disabled while the release gate holds, with the reasons
 * shown). Hold calls the decision route (note required) and moves nothing.
 * `initialAction` focuses a button (deep link); it never auto-submits.
 */
export interface DossierPanelProps {
  dossierId?: string | null
  /** When no dossierId: show the latest dossier for this order. */
  orderId?: string | null
  initialAction?: 'approve' | 'hold' | null
  onClose?: () => void
  onChanged?: () => void
}

type Detail = {
  dossier: {
    id: string
    order_id: string
    payout_id: string | null
    run_id: string | null
    kind: 'service' | 'goods'
    checks: DossierCheck[]
    anomalies: string[]
    photo_findings: PhotoFinding[]
    recommendation: 'approve' | 'hold'
    rationale: string[]
    model_cost_paise: number
    decision: 'approve' | 'hold' | null
    decision_note: string | null
    decided_at: string | null
    created_at: string
  }
  order: { id: string; order_number: string; title: string; status: string } | null
  payout: { id: string; status: string; amount_paise: number; scheduled_for: string | null } | null
  provider: { id: string; display_name: string } | null
  release_gate: { ok: boolean; reasons: string[] }
  photos: Array<{ doc_id: string; stage: string; signed_url: string | null; mime: string | null; uploaded_at: string | null; finding: PhotoFinding | null }>
}

const fmtIST = (v: string | null) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '—')
const humanize = (s: string) => s.replace(/_/g, ' ')

export function DossierPanel({ dossierId, orderId, initialAction = null, onClose, onChanged }: DossierPanelProps) {
  const t = useTranslations('admin_ops')
  const te = useTranslations('evidence')
  const { toast } = useToast()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [missing, setMissing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'approve' | 'hold' | null>(null)
  const [note, setNote] = useState('')
  const [noteError, setNoteError] = useState<string | null>(null)
  const [action, setAction] = useState<'approve' | 'hold' | null>(initialAction)

  const load = useCallback(async () => {
    setLoading(true)
    setMissing(false)
    let id = dossierId ?? null
    if (!id && orderId) {
      const r = await fetch(`/api/v1/agent/admin/dossiers?order_id=${encodeURIComponent(orderId)}&status=all&limit=1`, { cache: 'no-store' })
      const d = await r.json().catch(() => null)
      id = r.ok && d?.dossiers?.[0]?.dossier?.id ? (d.dossiers[0].dossier.id as string) : null
    }
    if (!id) {
      setMissing(true)
      setLoading(false)
      return
    }
    const res = await fetch(`/api/v1/agent/admin/dossiers/${id}`, { cache: 'no-store' })
    const body = await res.json().catch(() => null)
    if (res.ok && body) setDetail(body as Detail)
    else setMissing(true)
    setLoading(false)
  }, [dossierId, orderId])
  useEffect(() => { void load() }, [load])

  const stageLabel = (stage: string) => {
    if (stage === 'accepted' || stage === 'site_or_materials' || stage === 'in_progress' || stage === 'work_complete') return te(`kind_${stage}` as 'kind_accepted')
    if (stage === 'dispatch_photo') return t('dossier_stage_dispatch_photo')
    if (stage === 'delivery_photo') return t('dossier_stage_delivery_photo')
    return t('dossier_stage_unknown')
  }
  const anomalyLabel = (a: string) => {
    const k = anomalyKind(a)
    const label = t(`anomaly_${k}` as 'anomaly_unknown')
    const tail = a.includes(':') ? ` (${a.slice(a.indexOf(':') + 1)})` : ''
    return `${label}${tail}`
  }

  async function approve() {
    if (!detail?.payout) return
    setBusy('approve')
    const res = await fetch(`/api/v1/admin/payouts/${detail.payout.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'retry', dossier_id: detail.dossier.id, ...(note.trim() ? { note: note.trim() } : {}) }),
    })
    const d = await res.json().catch(() => ({}))
    setBusy(null)
    if (res.ok) {
      toast(t('dossier_approved_ok'), 'success')
      await load()
      onChanged?.()
    } else {
      toast(typeof d.error === 'string' ? d.error : t('action_failed'), 'error')
    }
  }

  async function hold() {
    if (!detail) return
    if (!note.trim()) {
      setNoteError(t('dossier_note_required'))
      return
    }
    setNoteError(null)
    setBusy('hold')
    const res = await fetch(`/api/v1/agent/admin/dossiers/${detail.dossier.id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'hold', note: note.trim() }),
    })
    const d = await res.json().catch(() => ({}))
    setBusy(null)
    if (res.ok) {
      toast(t('dossier_held_ok'), 'success')
      await load()
      onChanged?.()
    } else {
      toast(typeof d.error === 'string' ? d.error : t('action_failed'), 'error')
    }
  }

  if (loading) return <p className="text-sm text-foreground-secondary">{t('dossier_loading')}</p>
  if (missing || !detail) return <p className="text-sm text-foreground-secondary">{t('dossier_none')}</p>

  const { dossier, payout, release_gate, photos } = detail
  const decided = !!dossier.decision
  const releasable = !!payout && (payout.status === 'held' || payout.status === 'failed')
  const approveDisabled = decided || !releasable || !release_gate.ok || busy !== null
  const recLabel = t(dossier.recommendation === 'approve' ? 'dossier_rec_approve' : 'dossier_rec_hold')

  return (
    <div className="space-y-4 text-sm" data-testid="dossier-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-lg font-bold">{t('dossier_title')}</h2>
          <p className="text-xs text-foreground-secondary">
            {detail.order?.order_number} · {detail.provider?.display_name} · {payout ? formatINR(Number(payout.amount_paise)) : '—'} · {fmtIST(dossier.created_at)} IST
          </p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} className="text-xs text-foreground-secondary underline underline-offset-2">{t('dossier_close')}</button>
        )}
      </div>

      {/* Recommendation */}
      <div className={`rounded-card border p-3 ${dossier.recommendation === 'approve' ? 'border-success/40 bg-success-soft' : 'border-warning/40 bg-warning-soft'}`}>
        <p className="text-xs font-medium text-foreground-secondary">{t('dossier_recommendation')}</p>
        <p className="text-lg font-bold capitalize">{recLabel}</p>
        {dossier.rationale.length > 0 && (
          <div className="mt-1">
            <p className="text-xs font-medium text-foreground-secondary">{t('dossier_rationale')}</p>
            <ul className="mt-0.5 list-disc pl-5 text-xs">
              {dossier.rationale.map((r) => <li key={r} className="break-all">{humanize(r)}</li>)}
            </ul>
          </div>
        )}
        <p className="mt-2 text-xs text-foreground-secondary">
          {decided
            ? t('dossier_decided', { decision: t(dossier.decision === 'approve' ? 'dossier_rec_approve' : 'dossier_rec_hold'), date: fmtIST(dossier.decided_at) })
            : t('dossier_decision_pending')}
          {decided && dossier.decision_note ? ` — “${dossier.decision_note}”` : ''}
        </p>
      </div>

      {/* Checks */}
      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{t('dossier_checks')}</h3>
        <ul className="divide-y divide-border rounded-card border border-border">
          {dossier.checks.map((c) => (
            <li key={c.name} className="flex items-start gap-2 p-2">
              <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${c.ok ? 'bg-success text-white' : 'bg-danger text-white'}`} aria-label={c.ok ? 'ok' : 'failed'}>
                {c.ok ? '✓' : '✗'}
              </span>
              <div className="min-w-0">
                <p className="font-medium">{t(`check_${c.name}` as 'check_buyer_confirmed')}</p>
                {c.detail && <p className="break-words text-xs text-foreground-secondary">{c.detail}</p>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Anomalies */}
      {dossier.anomalies.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{t('dossier_anomalies')}</h3>
          <ul className="flex flex-wrap gap-1">
            {dossier.anomalies.map((a) => (
              <li key={a} className="rounded-full bg-danger-soft px-2 py-0.5 text-xs text-danger">{anomalyLabel(a)}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Photos + findings */}
      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{t('dossier_photos')}</h3>
        {photos.length === 0 ? (
          <p className="text-xs text-foreground-secondary">—</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {photos.map((p) => {
              const f = p.finding
              const ok = !!f && f.looks_like_work && f.matches_stage && !f.is_screenshot_or_document && f.confidence >= 0.6
              return (
                <li key={p.doc_id} className="overflow-hidden rounded-card border border-border">
                  {p.signed_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.signed_url} alt={stageLabel(p.stage)} className="h-40 w-full object-cover" />
                  ) : (
                    <div className="flex h-40 items-center justify-center bg-muted text-xs text-foreground-secondary">—</div>
                  )}
                  <div className="space-y-1 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{stageLabel(p.stage)}</p>
                      {f && (
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${ok ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning'}`}>
                          {ok ? t('dossier_finding_ok') : t('dossier_finding_bad')}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-foreground-secondary">{fmtIST(p.uploaded_at)} IST</p>
                    {f ? (
                      <>
                        <p className="text-xs">
                          {f.looks_like_work ? '✓' : '✗'} {t('dossier_finding_work')} · {f.matches_stage ? '✓' : '✗'} {t('dossier_finding_stage')} · {f.is_screenshot_or_document ? '✗' : '✓'} {t('dossier_finding_doc')} · {t('dossier_finding_confidence')} {Math.round(f.confidence * 100)}%
                        </p>
                        {f.concerns.length > 0 && (
                          <ul className="flex flex-wrap gap-1">
                            {f.concerns.map((c) => <li key={c} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground-secondary">{c}</li>)}
                          </ul>
                        )}
                      </>
                    ) : (
                      <p className="text-xs text-foreground-secondary">{t('dossier_no_finding')}</p>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <p className="text-xs text-foreground-secondary">
        {t('dossier_model_cost')}: {formatINR(Number(dossier.model_cost_paise))}
        {dossier.run_id ? ` · ${t('dossier_run')} ${dossier.run_id.slice(0, 8)}…` : ''}
      </p>

      {/* Decision */}
      {!decided && (
        <section className="space-y-2 rounded-card border border-border bg-surface p-3">
          {!release_gate.ok && (
            <p className="text-xs text-warning">
              {t('dossier_gate_blocked')} {release_gate.reasons.map(humanize).join(', ')}
            </p>
          )}
          {payout && !releasable && <p className="text-xs text-foreground-secondary">{t('dossier_payout_not_releasable', { status: payout.status })}</p>}
          <label className="block text-xs font-medium text-foreground-secondary" htmlFor="dossier-note">{t('dossier_note_label')}</label>
          <textarea
            id="dossier-note"
            value={note}
            onChange={(e) => { setNote(e.target.value); if (noteError) setNoteError(null) }}
            rows={2}
            maxLength={500}
            className="w-full rounded-input border border-border bg-background p-2 text-sm"
          />
          {noteError && <p className="text-xs text-danger">{noteError}</p>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={approve} disabled={approveDisabled} loading={busy === 'approve'} autoFocus={action === 'approve'} onFocus={() => setAction(null)}>
              {t('dossier_approve_btn')}
            </Button>
            <Button variant="outline" onClick={hold} disabled={busy !== null} loading={busy === 'hold'} autoFocus={action === 'hold'} onFocus={() => setAction(null)}>
              {t('dossier_hold_btn')}
            </Button>
          </div>
        </section>
      )}
    </div>
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */
