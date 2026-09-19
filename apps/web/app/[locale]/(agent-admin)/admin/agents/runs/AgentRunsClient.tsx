'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { AGENT_PERSONAS, AGENT_RUN_STATUSES } from '@amclub/shared'
import { Button } from '@/components/ui/button'

interface RunRow {
  id: string
  user_id: string
  persona: string
  status: string
  surface: string
  cost_est_paise: number
  created_at: string
  completed_at: string | null
}
interface EventRow { id: string; kind: string; tool: string | null; actor: string; payload: unknown; created_at: string }
interface InvRow { id: string; task_class: string | null; tier: string | null; status: string; latency_ms: number; cost_est_paise: number | null; input_tokens: number | null; output_tokens: number | null }
interface DecisionRow { id: string; feature: string; tool: string | null; corrected_fields: string[]; decided_at: string }
interface Detail { run: RunRow & { error: string | null; meta: unknown; input_tokens: number | null; output_tokens: number | null }; events: EventRow[]; invocations: InvRow[]; decisions: DecisionRow[] }

const rupees = (paise: number | null) => `₹${((paise ?? 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const fmtIST = (v: string | null) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' }) : '—')

export function AgentRunsClient() {
  const t = useTranslations('admin_agents')
  const [runs, setRuns] = useState<RunRow[]>([])
  const [persona, setPersona] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const qs = new URLSearchParams()
    if (persona) qs.set('persona', persona)
    if (status) qs.set('status', status)
    const r = await fetch(`/api/v1/agent/admin/runs?${qs.toString()}`, { cache: 'no-store' }).then((res) => (res.ok ? res.json() : { runs: [] }))
    setRuns(r.runs ?? [])
    setLoading(false)
  }, [persona, status])
  useEffect(() => { void load() }, [load])

  async function open(id: string) {
    setDetailLoading(true)
    setDetail(null)
    const d = await fetch(`/api/v1/agent/admin/runs/${id}`, { cache: 'no-store' }).then((res) => (res.ok ? res.json() : null))
    setDetail(d)
    setDetailLoading(false)
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">{t('runs_title')}</h1>
          <p className="mt-1 text-sm text-foreground-secondary">{t('runs_subtitle')}</p>
        </div>
        <Link href={'/admin/agents' as '/admin'} className="text-sm font-medium text-primary underline underline-offset-2">{t('back')}</Link>
      </div>

      <div className="flex flex-wrap gap-2">
        <select aria-label={t('filter_persona')} value={persona} onChange={(e) => setPersona(e.target.value)} className="h-9 rounded-button border border-border bg-surface px-2 text-sm">
          <option value="">{t('all_personas')}</option>
          {AGENT_PERSONAS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select aria-label={t('filter_status')} value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 rounded-button border border-border bg-surface px-2 text-sm">
          <option value="">{t('all_statuses')}</option>
          {AGENT_RUN_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {loading ? <p className="text-sm text-foreground-secondary">{t('loading')}</p> : runs.length === 0 ? (
        <p className="rounded-card border border-border bg-surface p-6 text-sm text-foreground-secondary">{t('no_runs')}</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-foreground-secondary">
                <th className="px-4 py-2 font-medium">{t('col_created')}</th>
                <th className="px-2 py-2 font-medium">{t('col_persona')}</th>
                <th className="px-2 py-2 font-medium">{t('col_status')}</th>
                <th className="px-2 py-2 font-medium">{t('col_surface')}</th>
                <th className="px-2 py-2 font-medium">{t('col_cost')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-4 py-2 tabular-nums text-foreground-secondary">{fmtIST(r.created_at)}</td>
                  <td className="px-2 py-2">{r.persona}</td>
                  <td className="px-2 py-2">{r.status}</td>
                  <td className="px-2 py-2 text-foreground-secondary">{r.surface}</td>
                  <td className="px-2 py-2 tabular-nums">{rupees(r.cost_est_paise)}</td>
                  <td className="px-4 py-2 text-right"><Button size="sm" variant="outline" onClick={() => open(r.id)}>{t('view')}</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(detail || detailLoading) && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => setDetail(null)}>
          <div className="h-full w-full max-w-lg overflow-y-auto bg-surface p-6 shadow-card" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t('run_detail')}</h2>
              <button onClick={() => setDetail(null)} className="text-sm text-foreground-secondary hover:text-foreground" aria-label={t('close')}>✕</button>
            </div>
            {detailLoading || !detail ? <p className="mt-4 text-sm text-foreground-secondary">{t('loading')}</p> : (
              <div className="mt-4 space-y-5 text-sm">
                <div className="rounded-card border border-border p-3">
                  <p className="font-mono text-xs text-foreground-secondary">{detail.run.id}</p>
                  <p className="mt-1">{detail.run.persona} · {detail.run.status} · {detail.run.surface}</p>
                  <p className="mt-1 text-xs text-foreground-secondary">{t('col_cost')}: {rupees(detail.run.cost_est_paise)} · {detail.run.input_tokens ?? 0}/{detail.run.output_tokens ?? 0} tok</p>
                  {detail.run.error && <p className="mt-1 text-xs text-danger">{detail.run.error}</p>}
                </div>

                <div>
                  <p className="mb-2 text-xs font-semibold uppercase text-foreground-secondary">{t('trace')}</p>
                  <ol className="space-y-1">
                    {detail.events.map((e) => (
                      <li key={e.id} className="flex items-baseline gap-2 text-xs">
                        <span className="tabular-nums text-foreground-secondary">{fmtIST(e.created_at)}</span>
                        <span className="font-medium">{e.kind}</span>
                        {e.tool && <span className="font-mono text-foreground-secondary">{e.tool}</span>}
                        <span className="text-foreground-secondary">({e.actor})</span>
                      </li>
                    ))}
                  </ol>
                </div>

                {detail.invocations.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase text-foreground-secondary">{t('calls')}</p>
                    <ul className="space-y-1">
                      {detail.invocations.map((iv) => (
                        <li key={iv.id} className="flex items-baseline justify-between text-xs">
                          <span>{iv.task_class} <span className="text-foreground-secondary">({iv.tier})</span></span>
                          <span className="tabular-nums text-foreground-secondary">{iv.input_tokens ?? 0}/{iv.output_tokens ?? 0} · {rupees(iv.cost_est_paise)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {detail.decisions.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase text-foreground-secondary">{t('decisions')}</p>
                    <ul className="space-y-1">
                      {detail.decisions.map((d) => (
                        <li key={d.id} className="text-xs">
                          <span className="font-medium">{d.feature}</span>{d.tool && <span className="font-mono text-foreground-secondary"> · {d.tool}</span>}
                          <span className="text-foreground-secondary"> · {fmtIST(d.decided_at)}</span>
                          {d.corrected_fields.length > 0 && <span className="text-warning"> · edited: {d.corrected_fields.join(', ')}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
