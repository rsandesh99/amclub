'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { Eraser, Eye, FileWarning, PencilLine, Undo2 } from 'lucide-react'
import {
  PRIVACY_DETAILS_MAX,
  PRIVACY_KINDS_NEEDING_DETAILS,
  PRIVACY_REQUEST_DUE_DAYS,
  PRIVACY_REQUEST_KINDS,
  SUPPORT_EMAIL,
  privacyRequestProblem,
  type PrivacyRequestKind,
  type PrivacyRequestView,
} from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { SegmentedControl } from '@/components/ui-v3/SegmentedControl'
import { Skeleton } from '@/components/ui-v3/Feedback'
import { useAnalytics } from '@/components/providers/posthog'
import { createPrivacyRequest, loadPrivacyRequests } from '@/lib/api/settings-client'

const ICONS = { access: Eye, correction: PencilLine, erasure: Eraser, withdrawal: Undo2, grievance: FileWarning } as const
const STATUS_TONE: Record<PrivacyRequestView['status'], string> = {
  open: 'bg-primary/10 text-primary',
  in_progress: 'bg-warning-soft text-warning',
  done: 'bg-success-soft text-success',
  rejected: 'bg-foreground/10 text-foreground-secondary',
}

type View = { kind: 'loading' } | { kind: 'not_ready' } | { kind: 'error' } | { kind: 'ready'; requests: PrivacyRequestView[] }

/**
 * DPDP requests (ADR-030 §6): the person's rights in plain words, their own
 * requests with status and due date, and a form to file one. Web half of
 * /app/privacy and /partner/privacy; mobile has the same screen.
 */
export function PrivacyRequests({ persona }: { persona: 'buyer' | 'provider' }) {
  const t = useTranslations('privacy_requests')
  const tCommon = useTranslations('common')
  const format = useFormatter()
  const analytics = useAnalytics()
  const ids = useId()
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [kind, setKind] = useState<PrivacyRequestKind>('access')
  const [details, setDetails] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeZone: 'Asia/Kolkata' })

  const load = useCallback(async () => {
    const r = await loadPrivacyRequests()
    setView(r.kind === 'ready' ? { kind: 'ready', requests: r.data } : r)
  }, [])
  useEffect(() => { void load() }, [load])

  async function submit() {
    const problem = privacyRequestProblem({ kind, details })
    if (problem) { setNote({ tone: 'error', text: t(problem) }); return }
    setBusy(true); setNote(null)
    const res = await createPrivacyRequest({ kind, details: details.trim() || null })
    setBusy(false)
    if (res.ok) {
      analytics.capture('privacy_request_created', { kind, persona, device: 'web' })
      setNote({ tone: 'ok', text: t('sent', { date: date(res.request.dueAt) }) })
      setDetails('')
      setView((v) => (v.kind === 'ready' ? { kind: 'ready', requests: [res.request, ...v.requests] } : v))
      return
    }
    if (res.status === 409) setNote({ tone: 'error', text: res.dueAt ? t('already_open', { date: date(res.dueAt) }) : t('already_open_nodate') })
    else if (res.status === 422) setNote({ tone: 'error', text: res.error === 'details_too_long' ? t('details_too_long') : t('details_required') })
    else if (res.status === 429) setNote({ tone: 'error', text: t('rate_limited') })
    else if (res.status === 503) setView({ kind: 'not_ready' })
    else setNote({ tone: 'error', text: t('send_failed') })
  }

  const needsDetails = PRIVACY_KINDS_NEEDING_DETAILS.includes(kind)

  return (
    <div className="space-y-6" data-testid="privacy-requests" data-state={view.kind}>
      <section aria-labelledby={`${ids}-rights`} className="rounded-card border border-border bg-surface p-4 shadow-card">
        <h2 id={`${ids}-rights`} className="text-base font-semibold">{t('rights_title')}</h2>
        <ul className="mt-3 space-y-3">
          {PRIVACY_REQUEST_KINDS.map((k) => {
            const Icon = ICONS[k]
            return (
              <li key={k} className="flex items-start gap-3">
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t(`right_${k}`)}</p>
                  <p className="text-xs text-foreground-secondary">{t(`right_${k}_body`)}</p>
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      <section aria-labelledby={`${ids}-list`} className="space-y-2">
        <h2 id={`${ids}-list`} className="text-base font-semibold">{t('list_title')}</h2>
        {view.kind === 'loading' && <Skeleton className="h-16 w-full" />}
        {view.kind === 'error' && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <p className="text-foreground-secondary">{t('load_failed')}</p>
            <Button size="sm" variant="outline" onClick={() => { setView({ kind: 'loading' }); void load() }}>{tCommon('retry')}</Button>
          </div>
        )}
        {view.kind === 'not_ready' && <p className="rounded-card bg-primary-soft px-4 py-3 text-sm" role="status">{t('not_ready', { email: SUPPORT_EMAIL })}</p>}
        {view.kind === 'ready' && view.requests.length === 0 && <p className="text-sm text-foreground-secondary">{t('empty')}</p>}
        {view.kind === 'ready' && view.requests.length > 0 && (
          <ul className="divide-y divide-border rounded-card border border-border bg-surface">
            {view.requests.map((r) => (
              <li key={r.id} className="px-4 py-3" data-testid="privacy-request-row" data-kind={r.kind} data-status={r.status}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{t(`kind_${r.kind}`)}</p>
                  <span className={`rounded-chip px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[r.status]}`}>{t(`status_${r.status}`)}</span>
                </div>
                <p className="mt-0.5 text-xs text-foreground-secondary">
                  {t('filed_on', { date: date(r.createdAt) })}
                  {' · '}
                  {r.resolvedAt ? t('resolved_on', { date: date(r.resolvedAt) }) : t('due_by', { date: date(r.dueAt) })}
                </p>
                {r.resolution && <p className="mt-1 text-sm">{r.resolution}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.kind !== 'not_ready' && (
        <section aria-labelledby={`${ids}-form`} className="space-y-3 rounded-card border border-border bg-surface p-4 shadow-card">
          <h2 id={`${ids}-form`} className="text-base font-semibold">{t('form_title')}</h2>
          <p className="text-xs text-foreground-secondary">{t('form_body', { days: PRIVACY_REQUEST_DUE_DAYS })}</p>
          <div>
            <p id={`${ids}-kind`} className="mb-1 text-sm font-medium">{t('kind_label')}</p>
            <SegmentedControl
              wrap
              size="sm"
              ariaLabelledBy={`${ids}-kind`}
              value={kind}
              options={PRIVACY_REQUEST_KINDS.map((k) => ({ value: k, label: t(`kind_${k}`) }))}
              onChange={(k) => { setKind(k); setNote(null) }}
            />
          </div>
          {kind === 'erasure' && <p className="rounded-button bg-warning-soft px-3 py-2 text-xs text-warning" role="note">{t('erasure_warning')}</p>}
          <div>
            <label htmlFor={`${ids}-details`} className="mb-1 block text-sm font-medium">
              {t('details_label')}{!needsDetails && <span className="font-normal text-foreground-secondary"> ({tCommon('optional')})</span>}
            </label>
            <Textarea
              id={`${ids}-details`}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              maxLength={PRIVACY_DETAILS_MAX}
              rows={3}
              aria-describedby={`${ids}-details-hint`}
              aria-required={needsDetails}
              data-testid="privacy-details"
            />
            <p id={`${ids}-details-hint`} className="mt-1 text-xs text-foreground-secondary">
              {kind === 'correction' ? t('details_hint_correction') : kind === 'grievance' ? t('details_hint_grievance') : t('details_hint_other')}
            </p>
          </div>
          {note && <p className={note.tone === 'ok' ? 'text-sm text-success' : 'text-sm text-danger'} role={note.tone === 'ok' ? 'status' : 'alert'}>{note.text}</p>}
          <Button onClick={() => void submit()} loading={busy} className="w-full sm:w-auto" data-testid="privacy-submit">{t('submit')}</Button>
        </section>
      )}
    </div>
  )
}
