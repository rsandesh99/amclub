'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { Picker } from '@/components/ui-v3/Picker'
import { SegmentedControl } from '@/components/ui-v3/SegmentedControl'

/* eslint-disable @typescript-eslint/no-explicit-any */

const KINDS = ['access', 'correction', 'erasure', 'withdrawal', 'grievance', 'nomination'] as const
const FINAL = ['done', 'rejected']
const card = 'rounded-card border border-border bg-surface p-4 shadow-card'

/** /admin/privacy — DPDP requests (ADR-030 §6): work the queue, export for access, erase WhatsApp data for erasure. */
export function PrivacyQueueClient() {
  const t = useTranslations('admin_privacy')
  const locale = useLocale()
  const { toast } = useToast()
  const [d, setD] = useState<any>(undefined)
  const [showClosed, setShowClosed] = useState(false)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [form, setForm] = useState({ identifier: '', kind: 'access', source: 'email', details: '' })

  const ist = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString(locale === 'hi' ? 'hi-IN' : 'en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'

  const load = useCallback(async () => {
    const r = await fetch('/api/v1/admin/privacy/requests', { cache: 'no-store' }).catch(() => null)
    setD(r?.ok ? await r.json().catch(() => null) : null)
  }, [])
  useEffect(() => { void load() }, [load])

  const noteFor = (r: any) => notes[r.id] ?? (r.kind === 'access' ? t('resolution_default_access') : r.kind === 'erasure' ? t('resolution_default_erasure') : '')

  async function act(r: any, action: 'in_progress' | 'done' | 'rejected') {
    const resolution = noteFor(r).trim()
    if (action !== 'in_progress' && resolution.length < 10) return toast(t('resolution_required'))
    if (action === 'done' && r.kind === 'erasure' && !window.confirm(t('confirm_erasure'))) return
    setBusy(r.id)
    const res = await fetch(`/api/v1/admin/privacy/requests/${r.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action === 'in_progress' ? { action } : { action, resolution }),
    }).catch(() => null)
    const body = res ? await res.json().catch(() => null) : null
    setBusy(null)
    if (!res?.ok) {
      const code = typeof body?.error === 'string' ? body.error : null
      return toast(code && ['illegal_transition', 'changed', 'not_ready', 'erasure_incomplete', 'no_account'].includes(code) ? t(`err_${code}`) : t('error'))
    }
    if (body?.erasure) toast(t('erasure_summary', { messages: body.erasure.messagesRedacted, media: body.erasure.mediaDeleted, grants: body.erasure.grantsRevoked, held: body.erasure.keptOnHold }))
    else toast(t(`toast_${action}`))
    await load()
  }

  async function record(e: React.FormEvent) {
    e.preventDefault()
    setBusy('new')
    const res = await fetch('/api/v1/admin/privacy/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: form.identifier, kind: form.kind, source: form.source, ...(form.details.trim() ? { details: form.details.trim() } : {}) }),
    }).catch(() => null)
    setBusy(null)
    if (res?.status === 404) return toast(t('record_no_account'))
    if (!res?.ok) return toast(t('error'))
    toast(t('record_created'))
    setForm({ identifier: '', kind: 'access', source: 'email', details: '' })
    await load()
  }

  if (d === undefined) return <p className="text-sm text-foreground-secondary">{t('loading')}</p>
  if (!d) return <p className="text-sm text-destructive">{t('error')}</p>
  const rows: any[] = (d.requests ?? []).filter((r: any) => showClosed || !FINAL.includes(r.status))
  const beat = d.lastRetentionRun

  return (
    <div className="space-y-5" data-testid="privacy-queue">
      <div>
        <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
      </div>
      {d.notReady && <p className="rounded-card border border-warning/40 bg-warning/10 p-3 text-sm" data-testid="privacy-not-ready">{t('not_ready')}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className={card}><p className="text-xs text-foreground-secondary">{t('stat_open')}</p><p className="mt-1 text-2xl font-bold tabular-nums">{d.openCount ?? 0}</p></div>
        <div className={card}><p className="text-xs text-foreground-secondary">{t('stat_overdue')}</p><p className={`mt-1 text-2xl font-bold tabular-nums ${(d.overdueCount ?? 0) > 0 ? 'text-destructive' : ''}`}>{d.overdueCount ?? 0}</p></div>
        <div className={card}><p className="text-xs text-foreground-secondary">{t('stat_due_days_label')}</p><p className="mt-1 text-2xl font-bold tabular-nums">{t('stat_due_days', { n: d.dueDays })}</p></div>
      </div>

      <section className={card} data-testid="privacy-retention">
        <h2 className="text-sm font-semibold">{t('retention_title')}</h2>
        <p className="mt-1 text-sm">{t('retention_text', { n: d.retention?.textDays ?? 0 })} · {t('retention_media', { n: d.retention?.mediaDays ?? 0 })} · {t('retention_unknown', { n: d.retention?.unknownDays ?? 0 })}</p>
        <p className="mt-1 text-xs text-foreground-secondary">
          {beat?.last_ok_at ? t('retention_last_run', { time: ist(beat.last_ok_at), status: beat.status ? t(`run_${beat.status === 'degraded' || beat.status === 'failed' ? beat.status : 'ok'}`) : t('run_ok') }) : t('retention_never_run')}
          {' · '}<Link href="/admin/agents" prefetch={false} className="underline">{t('retention_edit')}</Link>
        </p>
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold">{t('record_title')}</h2>
        <form className="mt-2 grid gap-2 sm:grid-cols-4" onSubmit={record}>
          <label className="text-sm sm:col-span-2">
            <span className="block text-xs text-foreground-secondary">{t('record_identifier')}</span>
            <input className="field-control w-full" required minLength={3} maxLength={200} value={form.identifier} onChange={(e) => setForm({ ...form, identifier: e.target.value })} />
          </label>
          <div className="text-sm">
            <span className="block text-xs text-foreground-secondary" aria-hidden>{t('record_kind')}</span>
            <Picker label={t('record_kind')} value={form.kind} options={KINDS.map((k) => ({ value: k, label: t(`kind_${k}`) }))} onChange={(v) => setForm({ ...form, kind: v ?? 'access' })} />
          </div>
          <div className="text-sm">
            <span className="block text-xs text-foreground-secondary" aria-hidden>{t('record_source')}</span>
            <SegmentedControl<'email' | 'admin'> ariaLabel={t('record_source')} size="sm" value={form.source as 'email' | 'admin'} options={[{ value: 'email', label: t('source_email') }, { value: 'admin', label: t('source_admin') }]} onChange={(v) => setForm({ ...form, source: v })} />
          </div>
          <label className="text-sm sm:col-span-3">
            <span className="block text-xs text-foreground-secondary">{t('record_details')}</span>
            <input className="field-control w-full" maxLength={2000} value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} />
          </label>
          <div className="flex items-end"><Button size="sm" type="submit" disabled={busy === 'new'}>{t('record_submit')}</Button></div>
        </form>
      </section>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
        {t('show_closed')}
      </label>

      <div className="space-y-3">
        {rows.length === 0 && <p className="text-sm text-foreground-secondary">{t('empty')}</p>}
        {rows.map((r) => {
          const final = FINAL.includes(r.status)
          return (
            <article key={r.id} className={`${card} ${r.overdue ? 'border-destructive/50' : ''}`} data-testid="privacy-request">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">{t(`kind_${r.kind}`)} · {t(`source_${r.source}`)}</p>
                  <p className="mt-0.5 text-xs text-foreground-secondary">
                    {r.user ? [r.user.name, r.user.email, r.user.phoneMasked].filter(Boolean).join(' · ') : (r.phoneMasked ?? t('user_unknown'))}
                  </p>
                  <p className="mt-0.5 text-xs text-foreground-secondary">
                    {t('requested', { time: ist(r.created_at) })} · {t('due', { time: ist(r.due_at) })}
                    {r.overdue && <span className="ml-1 font-medium text-destructive">{t('overdue')}</span>}
                    {r.resolved_at && ` · ${t('resolved', { time: ist(r.resolved_at) })}`}
                  </p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.status === 'done' ? 'bg-success/10 text-success' : r.status === 'rejected' ? 'bg-muted text-foreground-secondary' : r.status === 'in_progress' ? 'bg-primary/10 text-primary' : 'bg-warning/10 text-warning'}`}>{t(`status_${r.status}`)}</span>
              </div>
              {r.details && <p className="mt-2 whitespace-pre-wrap text-sm"><span className="font-medium">{t('details')}:</span> {r.details}</p>}
              {r.resolution && <p className="mt-2 whitespace-pre-wrap text-sm"><span className="font-medium">{t('resolution')}:</span> {r.resolution}</p>}
              {r.kind === 'erasure' && !final && <p className="mt-2 text-xs text-foreground-secondary">{t('erasure_note')}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {r.kind === 'access' && r.user_id && (
                  <a className="inline-flex items-center rounded-button border border-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/10" href={`/api/v1/admin/privacy/requests/${r.id}/export`} download data-testid="privacy-export">{t('act_export')}</a>
                )}
                {r.status === 'open' && <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => void act(r, 'in_progress')}>{t('act_in_progress')}</Button>}
              </div>
              {!final && (
                <div className="mt-3 space-y-2">
                  <textarea className="field-control w-full" rows={3} maxLength={2000} value={noteFor(r)} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} placeholder={t('resolution_placeholder')} aria-label={t('resolution_placeholder')} />
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy === r.id} onClick={() => void act(r, 'done')} data-testid="privacy-done">{t('act_done')}</Button>
                    <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => void act(r, 'rejected')}>{t('act_reject')}</Button>
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>
    </div>
  )
}
