'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { formatINR, formatINRExact } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/toast'

type Status = 'draft' | 'open' | 'closed_met' | 'closed_unmet' | 'ordered' | 'fulfilled' | 'cancelled'
const STATUSES: Status[] = ['draft', 'open', 'closed_met', 'closed_unmet', 'ordered', 'fulfilled', 'cancelled']

interface Pool {
  id: string; title: string; unit: string; status: Status; target_qty: number; min_qty: number; unit_price_paise: number; list_price_paise: number | null
  closes_at: string; committed_qty: number; member_count: number; productName: string | null; product_id: string | null
  seller: { displayName: string; city: string | null } | null; cardI18n: Record<string, string> | null; rationale: Record<string, unknown>
  progress: { pct: number; met: boolean; remainingToMin: number }
}
interface Member { id: string; qty: number; payment_state: string; business_name: string | null; city: string | null; order_id: string | null; pay_by: string | null; discipline: { due: number; honoured: number } }
interface Event { id: string; event_type: string; created_at: string; payload: Record<string, unknown> | null }

const fmtIST = (v: string | null | undefined) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '—')
const toLocalInput = (iso: string) => {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Group-buy worklist (MART_DESIGN.md §5 Group-Buy Agent, §7 M1): drafts the
 * agent proposed → founder edits terms → Approve & open. Close / settle /
 * fulfil / cancel by state. Linear-fast, no motion.
 */
export function PoolsAdmin() {
  const t = useTranslations('admin_mart')
  const { toast } = useToast()
  const [status, setStatus] = useState<Status>('draft')
  const [pools, setPools] = useState<Pool[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<string, { title: string; target_qty: string; min_qty: string; unit_price_paise: string; closes_at: string; en: string; hi: string; te: string }>>({})
  const [dossier, setDossier] = useState<Record<string, { members: Member[]; events: Event[] }>>({})

  const load = useCallback(() => {
    setLoading(true)
    fetch(`/api/v1/mart/admin/pools?status=${status}`, { cache: 'no-store' })
      .then(async (r) => { const d = await r.json().catch(() => null); return r.ok && d ? (d.pools as Pool[]) : [] })
      .then((ps) => {
        setPools(ps)
        setEdits((cur) => {
          const next = { ...cur }
          for (const p of ps) if (!next[p.id]) next[p.id] = { title: p.title, target_qty: String(p.target_qty), min_qty: String(p.min_qty), unit_price_paise: String(p.unit_price_paise), closes_at: toLocalInput(p.closes_at), en: p.cardI18n?.['en'] ?? '', hi: p.cardI18n?.['hi'] ?? '', te: p.cardI18n?.['te'] ?? '' }
          return next
        })
      })
      .finally(() => setLoading(false))
  }, [status])
  useEffect(() => { load() }, [load])

  async function runAgent() {
    setBusy('agent')
    try {
      const res = await fetch('/api/v1/mart/admin/pools/propose', { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { toast(t('action_failed'), 'error'); return }
      const n = (d.created ?? []).length
      toast(n > 0 ? t('pools_run_done', { n }) : t('pools_run_none'), n > 0 ? 'success' : 'info')
      setStatus('draft'); load()
    } finally { setBusy(null) }
  }

  async function act(p: Pool, action: 'approve' | 'cancel' | 'close' | 'award' | 'fulfil') {
    let body: Record<string, unknown> = { action }
    if (action === 'approve') {
      const e = edits[p.id]!
      body = {
        action,
        edits: { title: e.title, target_qty: Number(e.target_qty), min_qty: Number(e.min_qty), unit_price_paise: Number(e.unit_price_paise), closes_at: new Date(e.closes_at).toISOString() },
        card_i18n: e.en || e.hi || e.te ? { en: e.en, hi: e.hi, te: e.te } : null,
      }
    }
    if (action === 'cancel') {
      const r = window.prompt(t('pool_cancel_prompt'))
      if (r === null) return
      body = { action, reason: r.trim() }
    }
    setBusy(p.id)
    try {
      const res = await fetch(`/api/v1/mart/admin/pools/${p.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        const code = typeof d.error === 'string' ? d.error : ''
        const k = `pool_err_${code}`
        toast(code && t.has(k as 'pool_err_not_draft') ? t(k as 'pool_err_not_draft') : t('action_failed'), 'error')
        return
      }
      toast(action === 'award' ? t('pool_award_done', { captured: d.settled?.captured ?? 0, defaulted: d.settled?.defaulted ?? 0 }) : t(`pool_${action}_done` as 'pool_approve_done'), 'success')
      load()
    } finally { setBusy(null) }
  }

  async function openDossier(id: string) {
    if (dossier[id]) { setDossier((d) => { const n = { ...d }; delete n[id]; return n }); return }
    const res = await fetch(`/api/v1/mart/admin/pools/${id}`, { cache: 'no-store' })
    const d = await res.json().catch(() => null)
    if (res.ok && d) setDossier((cur) => ({ ...cur, [id]: { members: d.members, events: d.events } }))
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('pools_title')}</h2>
          <p className="text-sm text-foreground-secondary">{t('pools_subtitle')}</p>
        </div>
        <Button onClick={runAgent} loading={busy === 'agent'} variant="outline">{t('pools_run_agent')}</Button>
      </div>
      <div className="flex flex-wrap gap-1">
        {STATUSES.map((s) => (
          <button key={s} type="button" onClick={() => setStatus(s)} className={`rounded-chip px-3 py-1.5 text-sm ${status === s ? 'bg-primary text-white' : 'bg-muted text-foreground-secondary hover:text-foreground'}`}>
            {t(`pool_status_${s}` as 'pool_status_draft')}
          </button>
        ))}
      </div>
      {loading ? (
        <p className="text-sm text-foreground-secondary">{t('loading')}</p>
      ) : pools.length === 0 ? (
        <p className="text-sm text-foreground-secondary">{t('pools_empty')}</p>
      ) : (
        <ul className="space-y-3">
          {pools.map((p) => {
            const e = edits[p.id]
            const r = p.rationale as { signal?: string; orders?: number; qty_30d?: number; buyers?: number; agent?: string }
            const saving = p.list_price_paise && p.list_price_paise > p.unit_price_paise ? Math.round(((p.list_price_paise - p.unit_price_paise) / p.list_price_paise) * 100) : 0
            return (
              <li key={p.id} className="rounded-card border border-border bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold">{p.title}</p>
                    <p className="text-xs text-foreground-secondary">{p.productName ?? '—'} · {p.seller?.displayName ?? '—'}{p.seller?.city ? ` · ${p.seller.city}` : ''}</p>
                    <p className="mt-1 text-xs text-foreground-secondary">
                      {r.signal === 'orders_30d' ? t('pool_signal_orders', { orders: r.orders ?? 0, qty: r.qty_30d ?? 0, buyers: r.buyers ?? 0 }) : t('pool_signal_schedule')}
                      {saving > 0 ? ` · ${t('pool_saving', { pct: saving })}` : ''}{r.agent === 'stub' ? ` · ${t('pool_stub')}` : ''}
                    </p>
                  </div>
                  <div className="text-right text-sm">
                    <p className="font-semibold tabular-nums">{formatINRExact(p.unit_price_paise)}/{p.unit}{p.list_price_paise ? <span className="ml-1 text-xs text-foreground-secondary line-through">{formatINRExact(p.list_price_paise)}</span> : null}</p>
                    <p className="text-xs text-foreground-secondary tabular-nums">{p.committed_qty}/{p.target_qty} {p.unit} · min {p.min_qty} · {p.member_count} members</p>
                    <p className="text-xs text-foreground-secondary">{t('pool_closes_at')}: {fmtIST(p.closes_at)}</p>
                  </div>
                </div>

                {p.status === 'draft' && e && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-2"><Label htmlFor={`t-${p.id}`}>Title</Label><Input id={`t-${p.id}`} value={e.title} onChange={(ev) => setEdits((c) => ({ ...c, [p.id]: { ...e, title: ev.target.value } }))} /></div>
                    <div><Label htmlFor={`tq-${p.id}`}>{t('pool_target')}</Label><Input id={`tq-${p.id}`} inputMode="numeric" value={e.target_qty} onChange={(ev) => setEdits((c) => ({ ...c, [p.id]: { ...e, target_qty: ev.target.value } }))} /></div>
                    <div><Label htmlFor={`mq-${p.id}`}>{t('pool_min')}</Label><Input id={`mq-${p.id}`} inputMode="numeric" value={e.min_qty} onChange={(ev) => setEdits((c) => ({ ...c, [p.id]: { ...e, min_qty: ev.target.value } }))} /></div>
                    <div><Label htmlFor={`pr-${p.id}`}>{t('pool_price')}</Label><Input id={`pr-${p.id}`} inputMode="numeric" value={e.unit_price_paise} onChange={(ev) => setEdits((c) => ({ ...c, [p.id]: { ...e, unit_price_paise: ev.target.value } }))} /></div>
                    <div><Label htmlFor={`ca-${p.id}`}>{t('pool_closes_at')}</Label><Input id={`ca-${p.id}`} type="datetime-local" value={e.closes_at} onChange={(ev) => setEdits((c) => ({ ...c, [p.id]: { ...e, closes_at: ev.target.value } }))} /></div>
                    <div className="sm:col-span-2">
                      <Label>{t('pool_card')}</Label>
                      <div className="grid gap-2">
                        {(['en', 'hi', 'te'] as const).map((l) => (
                          <Input key={l} className="font-system" value={e[l]} placeholder={l} onChange={(ev) => setEdits((c) => ({ ...c, [p.id]: { ...e, [l]: ev.target.value } }))} />
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {p.status === 'draft' && <Button size="sm" onClick={() => act(p, 'approve')} loading={busy === p.id}>{t('pool_approve')}</Button>}
                  {p.status === 'open' && <Button size="sm" variant="outline" onClick={() => act(p, 'close')} loading={busy === p.id}>{t('pool_close_now')}</Button>}
                  {p.status === 'closed_met' && <Button size="sm" onClick={() => act(p, 'award')} loading={busy === p.id}>{t('pool_award')}</Button>}
                  {p.status === 'ordered' && <Button size="sm" variant="outline" onClick={() => act(p, 'fulfil')} loading={busy === p.id}>{t('pool_fulfil')}</Button>}
                  {(p.status === 'draft' || p.status === 'open' || p.status === 'closed_met') && <Button size="sm" variant="ghost" onClick={() => act(p, 'cancel')} loading={busy === p.id}>{t('pool_cancel')}</Button>}
                  {p.status !== 'draft' && <Button size="sm" variant="ghost" onClick={() => openDossier(p.id)}>{t('pool_dossier')}</Button>}
                  {p.status !== 'draft' && p.status !== 'cancelled' && <Link href={`/mart/pools/${p.id}` as '/services'} className="text-xs font-medium text-primary hover:underline">/mart/pools/…</Link>}
                </div>

                {dossier[p.id] && (
                  <div className="mt-3 grid gap-4 border-t border-border pt-3 sm:grid-cols-2">
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{t('pool_members_title')}</h3>
                      <ul className="mt-1 divide-y divide-border text-sm">
                        {dossier[p.id]!.members.map((m) => (
                          <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                            <span>{m.business_name ?? '—'}{m.city ? ` · ${m.city}` : ''} · <span className="tabular-nums">{m.qty} {p.unit}</span> · {formatINR(m.qty * p.unit_price_paise)}</span>
                            <span className="flex items-center gap-2 text-xs">
                              <Badge variant={m.payment_state === 'captured' ? 'success' : m.payment_state === 'failed' ? 'danger' : 'outline'}>{t(`member_state_${m.payment_state}` as 'member_state_blocked')}</Badge>
                              <span className="text-foreground-secondary">{t('member_discipline', { honoured: m.discipline.honoured, due: m.discipline.due })}</span>
                              {m.order_id && <Link href={`/admin/mart/orders/${m.order_id}` as '/admin/orders'} className="text-primary hover:underline">{t('open_dossier')}</Link>}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{t('pool_events_title')}</h3>
                      <ul className="mt-1 space-y-1 text-xs text-foreground-secondary">
                        {dossier[p.id]!.events.map((ev) => <li key={ev.id}><span className="font-mono">{ev.event_type}</span> · {fmtIST(ev.created_at)}</li>)}
                      </ul>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
