'use client'

import { useEffect, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { formatINR } from '@/lib/format'

/* eslint-disable @typescript-eslint/no-explicit-any */

const todayISO = () => new Date().toISOString().slice(0, 10)
const daysAgoISO = (d: number) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10)

// Expected beats per vercel.json schedules; stale = ~2 missed runs + slack.
const CRON_JOBS = [
  { name: 'auto-cancel', staleAfterMs: 3 * 3600_000 },
  { name: 'auto-accept', staleAfterMs: 3 * 3600_000 },
  { name: 'rfq-expire', staleAfterMs: 3 * 3600_000 },
  { name: 'reconcile', staleAfterMs: 14 * 3600_000 },
  { name: 'payouts', staleAfterMs: 26 * 3600_000 },
  { name: 'provider-stats', staleAfterMs: 26 * 3600_000 },
  // Agent crons beat even while AGENT_ENABLED=false (they only skip the enqueue).
  { name: 'agent-munshi-scan', staleAfterMs: 1 * 3600_000 },
  { name: 'agent-munshi-followup', staleAfterMs: 3 * 3600_000 },
  { name: 'agent-onboarding-expire', staleAfterMs: 3 * 3600_000 },
  // pool-close is omitted: it deliberately records no beat while MART_ENABLED=false.
]

export default function AdminDashboardPage() {
  const t = useTranslations('admin_ops')
  const [from, setFrom] = useState(daysAgoISO(30))
  const [to, setTo] = useState(todayISO())
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const qs = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to + 'T23:59:59').toISOString() })
    const res = await fetch(`/api/v1/admin/kpi?${qs}`, { cache: 'no-store' })
    if (res.ok) setData(await res.json())
    setLoading(false)
  }, [from, to])
  useEffect(() => { load() }, [load])

  const f = data?.financial
  const fn = data?.funnel
  const rq = data?.rfq
  const h = data?.health
  const lm = data?.liquidityMatrix

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">{t('dash_title')}</h1>
          <p className="text-sm text-foreground-secondary">{t('dash_subtitle')}</p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-xs">{t('from')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 block rounded-button border border-border bg-background p-1.5 text-sm" /></label>
          <label className="text-xs">{t('to')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 block rounded-button border border-border bg-background p-1.5 text-sm" /></label>
        </div>
      </div>

      {loading || !data ? (
        <p className="text-sm text-foreground-secondary">{t('loading')}</p>
      ) : (
        <>
          {/* Financial */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t('gmv')} value={formatINR(f.gmvPaise)} />
            <Stat label={t('commission')} value={formatINR(f.commissionPaise)} />
            <Stat label={t('take_rate')} value={`${(f.takeRateBps / 100).toFixed(1)}%`} />
            <Stat label={t('completed_orders')} value={`${f.completedOrders} / ${f.totalOrders}`} />
          </div>

          {/* Funnel + health */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t('conversion')} value={`${fn.conversionPct}%`} sub={`${fn.ordersPlaced}/${fn.checkoutSessions} ${t('sessions').toLowerCase()}`} />
            <Stat label={t('quote_response')} value={`${rq.quoteResponseRatePct}%`} sub={`${rq.rfqsCreated} ${t('rfqs_created').toLowerCase()}`} />
            <Stat label={t('dispute_rate')} value={`${h.disputeRatePct}%`} />
            <Stat label={t('repeat_rate')} value={`${h.repeatPurchaseRatePct}%`} />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t('active_providers')} value={String(h.activeProviders)} />
            <Stat label={t('rfqs_accepted')} value={String(rq.rfqsAccepted)} />
            {/* Phase 3b — the Route/bank worklist: fills at approval, empties as you link. */}
            <Stat
              label={t('payout_ready_tile')}
              value={`${h.providersReady ?? 0} / ${h.activeProviders}`}
              sub={h.providersNotReady > 0 ? t('payout_ready_todo', { n: h.providersNotReady }) : t('payout_ready_ok')}
              tone={h.providersNotReady > 0 ? 'warning' : 'default'}
              {...(h.providersNotReady > 0 ? { href: '/admin/providers?status=active&readiness=unready' } : {})}
            />
          </div>

          {/* Top categories / states */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Panel title={t('top_categories')}>
              {data.topCategories.length === 0 ? <Empty label={t('no_supply')} /> : data.topCategories.map((c: any) => (
                <Bar key={c.slug} label={c.name} value={c.count} max={data.topCategories[0].count} />
              ))}
            </Panel>
            <Panel title={t('top_states')}>
              {data.topStates.length === 0 ? <Empty label={t('no_supply')} /> : data.topStates.map((s: any) => (
                <Bar key={s.state} label={s.state} value={s.count} max={data.topStates[0].count} />
              ))}
            </Panel>
          </div>

          {/* Cron liveness (B3) — a job that stops beating turns red here. */}
          <Panel title={t('jobs_title')}>
            <div className="grid gap-2 sm:grid-cols-2">
              {CRON_JOBS.map(({ name, staleAfterMs }) => {
                const hb = (data.cronHeartbeats ?? []).find((x: any) => x.name === name)
                const ageMs = hb ? Date.now() - new Date(hb.last_ok_at).getTime() : Infinity
                const stale = ageMs > staleAfterMs
                return (
                  <div key={name} className={`flex items-center justify-between rounded-button border px-3 py-2 text-sm ${stale ? 'border-danger/40 bg-danger/5' : 'border-border'}`}>
                    <span className="font-medium">{name}</span>
                    <span className={stale ? 'font-semibold text-danger' : 'text-foreground-secondary'}>
                      {hb
                        ? new Date(hb.last_ok_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST'
                        : t('jobs_never')}
                    </span>
                  </div>
                )
              })}
            </div>
            <p className="mt-2 text-xs text-foreground-secondary">{t('jobs_hint')}</p>
          </Panel>

          {/* §7.3 liquidity matrix */}
          <Panel title={t('liquidity')}>
            {lm.categories.length === 0 ? <Empty label={t('no_supply')} /> : (
              // Keyboard users must be able to scroll the wide matrix (axe: scrollable-region-focusable).
              <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t('liquidity')}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-foreground-secondary">
                      <th className="p-2"></th>
                      {lm.states.map((s: string) => <th key={s} className="p-2 text-center">{s}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {lm.categories.map((cat: string) => (
                      <tr key={cat} className="border-t border-border">
                        <td className="p-2 font-medium">{cat}</td>
                        {lm.states.map((s: string) => {
                          const n = lm.matrix[cat]?.[s] ?? 0
                          return <td key={s} className={`p-2 text-center tabular-nums ${n === 0 ? 'text-gray-300' : 'font-semibold text-primary'}`}>{n || '·'}</td>
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, sub, tone = 'default', href }: { label: string; value: string; sub?: string; tone?: 'default' | 'warning'; href?: string }) {
  const body = (
    <div className={`rounded-card border bg-surface p-4 ${tone === 'warning' ? 'border-warning/40' : 'border-border'} ${href ? 'transition-colors hover:border-primary/40' : ''}`}>
      <p className="text-xs text-foreground-secondary">{label}</p>
      <p className={`mt-1 font-display text-xl font-bold ${tone === 'warning' ? 'text-warning' : 'text-primary'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-foreground-secondary">{sub}</p>}
    </div>
  )
  return href ? <Link href={href as '/admin/providers'}>{body}</Link> : body
}
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}
function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-32 shrink-0 truncate">{label}</span>
      <div className="h-3 flex-1 rounded-full bg-primary/10"><div className="h-3 rounded-full bg-primary" style={{ width: `${max > 0 ? (value / max) * 100 : 0}%` }} /></div>
      <span className="w-8 text-right tabular-nums">{value}</span>
    </div>
  )
}
function Empty({ label }: { label: string }) {
  return <p className="text-sm text-foreground-secondary">{label}</p>
}
/* eslint-enable @typescript-eslint/no-explicit-any */
