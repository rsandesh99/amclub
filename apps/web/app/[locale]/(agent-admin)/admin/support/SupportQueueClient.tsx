'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'

interface Ticket {
  id: string
  ref: string
  user_id: string
  role: 'buyer' | 'provider'
  channel: 'whatsapp' | 'web' | 'mobile'
  intent: string | null
  reason: string
  summary: string | null
  suggested_next: string | null
  status: 'open' | 'in_progress' | 'resolved'
  assigned_to: string | null
  acknowledged_at: string | null
  resolved_at: string | null
  resolution_note: string | null
  order_id: string | null
  rfq_id: string | null
  created_at: string
}

interface Detail {
  ticket: Ticket
  ref: string
  transcript: { id: string; role: string; body: string; created_at: string }[]
  subject: { order?: { id: string; order_number: string; status: string } | null; rfq?: { id: string; title: string; status: string } | null }
}

interface Stats {
  open: number
  in_progress: number
  median_ack_minutes: number | null
  ack_within_sla_pct: number | null
  self_serve_rate_pct: number | null
  turns_7d: number
  escalations_7d: number
  reasons: Record<string, number>
}

const SLA_HOURS = 24

/** The support ticket queue (S2.3): acknowledge, assign, resolve with a note (which re-enables the agent for that user). */
export function SupportQueueClient() {
  const t = useTranslations('admin_support')
  const { toast } = useToast()
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [selected, setSelected] = useState<Detail | null>(null)
  const [note, setNote] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [q, s] = await Promise.all([
      fetch(`/api/v1/agent/admin/support/tickets${showAll ? '?status=all' : ''}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { tickets: [] })).catch(() => ({ tickets: [] })),
      fetch('/api/v1/agent/admin/support/stats', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
    setTickets(q.tickets ?? [])
    setStats(s)
    setLoading(false)
  }, [showAll])
  useEffect(() => {
    void load()
  }, [load])

  async function open(id: string) {
    const d = await fetch(`/api/v1/agent/admin/support/tickets/${id}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    setSelected(d)
    setNote('')
  }
  async function act(id: string, action: 'acknowledge' | 'assign' | 'resolve') {
    if (action === 'resolve' && !note.trim()) return toast(t('note_required'))
    setBusy(true)
    const res = await fetch(`/api/v1/agent/admin/support/tickets/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...(action === 'resolve' ? { note } : {}) }) })
    setBusy(false)
    if (!res.ok) return toast(t('error'))
    toast(t(`toast_${action}`))
    setSelected(null)
    await load()
  }

  const hoursOpen = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 3600000)

  if (loading) return <p className="p-6 text-sm text-foreground-secondary">{t('loading')}</p>

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle', { hours: SLA_HOURS })}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="support-stats">
        {(
          [
            { k: 'stat_open', v: String(stats?.open ?? 0) },
            { k: 'stat_in_progress', v: String(stats?.in_progress ?? 0) },
            { k: 'stat_median_ack', v: stats?.median_ack_minutes == null ? '—' : t('minutes', { n: stats.median_ack_minutes }) },
            { k: 'stat_self_serve', v: stats?.self_serve_rate_pct == null ? '—' : `${stats.self_serve_rate_pct}%` },
          ] as const
        ).map((s) => (
          <div key={s.k} className="rounded-card border border-border bg-surface p-4 shadow-card">
            <p className="text-xs font-medium text-foreground-secondary">{t(s.k)}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{s.v}</p>
          </div>
        ))}
      </div>
      {stats && Object.keys(stats.reasons).length > 0 && (
        <p className="text-xs text-foreground-secondary">
          {t('reasons')}: {Object.entries(stats.reasons).map(([k, v]) => `${k} ${v}`).join(' · ')} · {t('turns_7d', { n: stats.turns_7d })}
        </p>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        {t('show_all')}
      </label>

      <div className="space-y-3">
        {tickets.length === 0 && <p className="text-sm text-foreground-secondary">{t('empty')}</p>}
        {tickets.map((tk) => (
          <article key={tk.id} className="rounded-card border border-border bg-surface p-4 shadow-card" data-testid="support-ticket">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">
                  {tk.ref} · {t(`role_${tk.role}`)} · {tk.channel}
                </p>
                <p className="mt-0.5 text-xs text-foreground-secondary">
                  {t('reason')}: {tk.reason}
                  {tk.intent ? ` · ${tk.intent}` : ''} · {t('open_hours', { n: hoursOpen(tk.created_at) })}
                  {tk.status !== 'resolved' && hoursOpen(tk.created_at) >= SLA_HOURS && <span className="ml-1 font-medium text-destructive">{t('sla_breached')}</span>}
                </p>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tk.status === 'resolved' ? 'bg-success/10 text-success' : tk.status === 'in_progress' ? 'bg-primary/10 text-primary' : 'bg-muted text-foreground-secondary'}`}>{t(`status_${tk.status}`)}</span>
            </div>
            {tk.summary && <p className="mt-2 text-sm">{tk.summary}</p>}
            {tk.suggested_next && <p className="mt-1 text-xs text-foreground-secondary">{t('suggested')}: {t(`next_${tk.suggested_next}`)}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void open(tk.id)}>{t('view')}</Button>
              {tk.status !== 'resolved' && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => void act(tk.id, 'acknowledge')} disabled={busy}>{t('acknowledge')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void act(tk.id, 'assign')} disabled={busy}>{t('assign')}</Button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>

      {selected && (
        <section className="rounded-card border border-primary/30 bg-surface p-4 shadow-card" data-testid="support-ticket-detail">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-lg font-semibold">{selected.ref}</h2>
            <button type="button" onClick={() => setSelected(null)} className="text-sm text-foreground-secondary underline">{t('close')}</button>
          </div>
          {selected.subject.order && <p className="mt-1 text-sm">{t('order')}: {selected.subject.order.order_number} ({selected.subject.order.status})</p>}
          {selected.subject.rfq && <p className="mt-1 text-sm">{t('request')}: {selected.subject.rfq.title} ({selected.subject.rfq.status})</p>}
          <div className="mt-3 max-h-80 space-y-2 overflow-y-auto rounded-card border border-border p-3">
            {selected.transcript.map((m) => (
              <p key={m.id} className={m.role === 'user' ? 'text-sm' : 'text-sm text-foreground-secondary'}>
                <span className="font-medium">{m.role === 'user' ? t('user') : t('assistant')}:</span> {m.body}
              </p>
            ))}
            {selected.transcript.length === 0 && <p className="text-sm text-foreground-secondary">{t('no_transcript')}</p>}
          </div>
          {selected.ticket.status !== 'resolved' && (
            <div className="mt-3 space-y-2">
              <textarea className="field w-full" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('note_placeholder')} maxLength={1000} aria-label={t('note_placeholder')} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void act(selected.ticket.id, 'resolve')} disabled={busy} data-testid="support-resolve">{t('resolve')}</Button>
                <Button size="sm" variant="outline" onClick={() => void act(selected.ticket.id, 'acknowledge')} disabled={busy}>{t('acknowledge')}</Button>
              </div>
            </div>
          )}
          {selected.ticket.resolution_note && <p className="mt-3 text-sm"><span className="font-medium">{t('resolution')}:</span> {selected.ticket.resolution_note}</p>}
        </section>
      )}
    </div>
  )
}
