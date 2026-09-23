'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { AGENT_NAMES, AGENT_SETTING_DEFS, type AgentName, type AgentSettingKey } from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { formatINR } from '@/lib/format'

interface SettingRow { key: AgentSettingKey; value: unknown; set: boolean; updated_at: string | null; hint: string }
interface SpendBucket { ai_paise: number; commission_paise: number; ai_share_pct: number | null }
interface Spend { today: SpendBucket; month: SpendBucket }
interface DossierStats { pending: number; decided: number; approve_rate_pct: number | null; median_completed_to_decision_min: number | null }
interface TriageStats { pending: number; decided: number; agreement_rate_pct: number | null; needs_more_info_pct: number | null }

const NUMBER_KEYS: AgentSettingKey[] = ['budget_run_paise', 'budget_user_day_paise', 'budget_month_paise', 'rfq_max_quotes', 'quote_window_hours']
const TEXT_KEYS: AgentSettingKey[] = ['whatsapp_opt_in_text_version', 'evidence_required_from']
// everything else that is not agents_enabled edits as JSON (cohort_user_ids).

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const humanName = (n: string) => n.replace(/_/g, ' ')
const fmtIST = (v: string | null) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '—')

interface MunshiStats {
  week: { proposed: number; approved: number; edited: number; skipped: number; expired: number; failed: number; accepted_from_drafts: number }
  providers_enabled: number
  exit_metric_pct: number | null
  cost_per_approved_paise: number | null
}

export function AgentsConsoleClient() {
  const t = useTranslations('admin_agents')
  const tScore = useTranslations('admin_score')
  const tBench = useTranslations('admin_benchmarks')
  const { toast } = useToast()
  const [settings, setSettings] = useState<SettingRow[]>([])
  const [spend, setSpend] = useState<Spend | null>(null)
  const [dossiers, setDossiers] = useState<DossierStats | null>(null)
  const [triages, setTriages] = useState<TriageStats | null>(null)
  const [munshi, setMunshi] = useState<MunshiStats | null>(null)
  // S2.4 — AMC Score distribution (compute / card / ranking switches are ordinary settings rows below)
  const [score, setScore] = useState<{ provider: { subjects: number; scored: number; gated_share_pct: number | null; median: number | null }; buyer: { scored: number }; movers_week: unknown[] } | null>(null)
  // S3.1 — the buying assistant (30 days): sessions, proposal outcomes, RFQs + completed orders from agent sessions, cost
  // S3.2 — fair price ranges: the switches, the last nightly run, the table (aggregates only)
  const [bench, setBench] = useState<{ compute_enabled: boolean; display_enabled: boolean; rows_total: number; last_run: { at: string; result: { keys_considered?: number; rows_written?: number; gated_by_reason?: Record<string, number> } | null } | null; rows: { category_slug: string; scope: string; state: string | null; p25_paise: number; p75_paise: number; sample_n: number; providers_n: number }[] } | null>(null)
  const [procurement, setProcurement] = useState<{ sessions_active: number; sessions_total: number; proposals: { approved: number; edited: number; declined: number; open: number }; rfqs_created: number; orders_from_sessions: number; cost_per_completed_order_paise: number | null } | null>(null)
  const [agentsDraft, setAgentsDraft] = useState<Record<string, boolean>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [confirmKill, setConfirmKill] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [s, sp, ds, ts, ms, sc, pr, bm] = await Promise.all([
      fetch('/api/v1/agent/admin/settings', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { settings: [] })),
      fetch('/api/v1/agent/admin/spend', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
      fetch('/api/v1/agent/admin/dossiers/stats', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/v1/agent/admin/triages/stats', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/v1/agent/admin/munshi/stats', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/v1/agent/admin/score/stats', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/v1/agent/admin/procurement/stats', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/v1/agent/admin/benchmarks/stats', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
    const rows: SettingRow[] = s.settings ?? []
    setSettings(rows)
    const enabled = (rows.find((r) => r.key === 'agents_enabled')?.value ?? {}) as Record<string, boolean>
    setAgentsDraft(Object.fromEntries(AGENT_NAMES.map((n) => [n, Boolean(enabled[n])])))
    setDrafts(Object.fromEntries(rows.filter((r) => r.key !== 'agents_enabled').map((r) => [r.key, toText(r.key, r.value)])))
    setSpend(sp)
    setDossiers(ds)
    setTriages(ts)
    setMunshi(ms)
    setScore(sc)
    setProcurement(pr)
    setBench(bm)
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  async function put(key: AgentSettingKey, value: unknown, label: string) {
    setBusy(label)
    setErrors((e) => ({ ...e, [label]: '' }))
    const res = await fetch('/api/v1/agent/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) })
    const d = await res.json().catch(() => ({}))
    setBusy(null)
    if (!res.ok) { setErrors((e) => ({ ...e, [label]: typeof d.detail === 'string' ? d.detail : t('action_failed') })); return false }
    toast(t('saved'))
    await load()
    return true
  }

  async function saveSetting(key: AgentSettingKey) {
    let value: unknown
    try { value = fromText(key, drafts[key] ?? '') } catch { setErrors((e) => ({ ...e, [key]: t('invalid_value') })); return }
    await put(key, value, key)
  }

  async function kill() {
    setBusy('kill')
    const res = await fetch('/api/v1/agent/admin/kill', { method: 'POST' })
    await res.json().catch(() => ({}))
    setBusy(null)
    setConfirmKill(false)
    if (res.ok) { toast(t('kill_done')); await load() }
  }

  const agentsDirty = settings.length > 0 && AGENT_NAMES.some((n) => {
    const enabled = (settings.find((r) => r.key === 'agents_enabled')?.value ?? {}) as Record<string, boolean>
    return Boolean(agentsDraft[n]) !== Boolean(enabled[n])
  })

  const spendCard = (label: string, b: SpendBucket | undefined) => (
    <div className="rounded-card border border-border bg-surface p-4 shadow-card">
      <p className="text-xs font-medium text-foreground-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{rupees(b?.ai_paise ?? 0)}</p>
      <p className="mt-1 text-xs text-foreground-secondary">
        {t('commission')}: {rupees(b?.commission_paise ?? 0)} · {t('ai_share')}: {b?.ai_share_pct == null ? '—' : `${b.ai_share_pct}%`}
      </p>
    </div>
  )

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
          <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
        </div>
        <Link href={'/admin/agents/runs' as '/admin'} className="text-sm font-medium text-primary underline underline-offset-2">{t('runs_link')}</Link>
      </div>

      {loading ? <p className="text-sm text-foreground-secondary">{t('loading')}</p> : (
        <>
          {/* Spend */}
          <section className="grid gap-3 sm:grid-cols-3">
            {spendCard(t('spend_today'), spend?.today)}
            {spendCard(t('spend_month'), spend?.month)}
            {/* S1.4 — payout dossiers tile */}
            <div className="rounded-card border border-border bg-surface p-4 shadow-card">
              <p className="text-xs font-medium text-foreground-secondary">{t('dossiers_title')}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{t('dossiers_pending', { n: dossiers?.pending ?? 0 })}</p>
              <p className="mt-1 text-xs text-foreground-secondary">
                {t('dossiers_median')}: {dossiers?.median_completed_to_decision_min == null ? '—' : t('dossiers_minutes', { n: dossiers.median_completed_to_decision_min })}
                {' · '}
                {t('dossiers_approve_rate')}: {dossiers?.approve_rate_pct == null ? t('dossiers_none') : `${dossiers.approve_rate_pct}%`}
              </p>
              <Link href={'/admin/payouts' as '/admin'} className="mt-2 inline-block text-xs font-medium text-primary underline underline-offset-2">{t('dossiers_link')}</Link>
            </div>
            {/* S2.2 — Digital Munshi tile */}
            <div className="rounded-card border border-border bg-surface p-4 shadow-card" data-testid="munshi-tile">
              <p className="text-xs font-medium text-foreground-secondary">{t('munshi_title')}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{t('munshi_week', { n: munshi?.week.proposed ?? 0 })}</p>
              <p className="mt-1 text-xs text-foreground-secondary">
                {t('munshi_counts', { a: munshi?.week.approved ?? 0, e: munshi?.week.edited ?? 0, s: munshi?.week.skipped ?? 0 })}
                {' · '}
                {t('munshi_exit')}: {munshi?.exit_metric_pct == null ? t('munshi_none') : `${munshi.exit_metric_pct}%`}
                {' · '}
                {t('munshi_cost')}: {munshi?.cost_per_approved_paise == null ? '—' : `₹${(munshi.cost_per_approved_paise / 100).toFixed(2)}`}
                {' · '}
                {t('munshi_enabled', { n: munshi?.providers_enabled ?? 0 })}
              </p>
            </div>
            {/* S3.1 — buying assistant tile (built dark; enablement is the V1.5→V2 gate) */}
            <div className="rounded-card border border-border bg-surface p-4 shadow-card" data-testid="procurement-tile">
              <p className="text-xs font-medium text-foreground-secondary">{t('proc_title')}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{procurement?.sessions_active ?? 0}</p>
              <p className="mt-1 text-xs text-foreground-secondary">{t('proc_active')} · {t('proc_total', { n: procurement?.sessions_total ?? 0 })}</p>
              <p className="text-xs text-foreground-secondary">{t('proc_proposals', { approved: procurement?.proposals.approved ?? 0, edited: procurement?.proposals.edited ?? 0, declined: procurement?.proposals.declined ?? 0 })}</p>
              <p className="text-xs text-foreground-secondary">{t('proc_outcomes', { rfqs: procurement?.rfqs_created ?? 0, orders: procurement?.orders_from_sessions ?? 0 })} · {t('proc_cost')}: {procurement?.cost_per_completed_order_paise == null ? '—' : formatINR(procurement.cost_per_completed_order_paise)}</p>
            </div>
            {/* S3.2 — fair price ranges tile: review the table for two weeks with compute on before turning display on */}
            <div className="rounded-card border border-border bg-surface p-4 shadow-card" data-testid="benchmarks-tile">
              <p className="text-xs font-medium text-foreground-secondary">{tBench('tile_title')}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{bench?.rows_total ?? 0}</p>
              <p className="mt-1 text-xs text-foreground-secondary">{tBench('tile_rows')} · {tBench('tile_compute')}: {bench?.compute_enabled ? tBench('on') : tBench('off')} · {tBench('tile_display')}: {bench?.display_enabled ? tBench('on') : tBench('off')}</p>
              <p className="text-xs text-foreground-secondary">{tBench('tile_last_run')}: {bench?.last_run?.result ? tBench('tile_run_summary', { keys: bench.last_run.result.keys_considered ?? 0, written: bench.last_run.result.rows_written ?? 0, gated: Object.values(bench.last_run.result.gated_by_reason ?? {}).reduce((a, b) => a + b, 0) }) : '—'}</p>
              {(bench?.rows ?? []).length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs tabular-nums">
                  {(bench?.rows ?? []).slice(0, 8).map((r) => (
                    <li key={`${r.category_slug}|${r.scope}|${r.state ?? ''}`}>{r.category_slug} · {r.scope === 'state' ? r.state : tBench('national')}: {formatINR(r.p25_paise)}–{formatINR(r.p75_paise)} ({r.sample_n}/{r.providers_n})</li>
                  ))}
                </ul>
              )}
            </div>
            {/* S2.4 — AMC Score tile */}
            <div className="rounded-card border border-border bg-surface p-4 shadow-card" data-testid="score-tile">
              <p className="text-xs font-medium text-foreground-secondary">{tScore('tile_title')}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{score?.provider.median ?? '—'}</p>
              <p className="mt-1 text-xs text-foreground-secondary">{tScore('tile_median')} · {tScore('tile_scored')} {score?.provider.scored ?? 0}/{score?.provider.subjects ?? 0}</p>
              <p className="text-xs text-foreground-secondary">{tScore('tile_gated')}: {score?.provider.gated_share_pct == null ? '—' : `${score.provider.gated_share_pct}%`} · {tScore('tile_buyers')} {score?.buyer.scored ?? 0} · {tScore('tile_movers')} {score?.movers_week.length ?? 0}</p>
            </div>
            {/* S1.7 — dispute triages tile */}
            <div className="rounded-card border border-border bg-surface p-4 shadow-card">
              <p className="text-xs font-medium text-foreground-secondary">{t('triage_title')}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{t('triage_pending', { n: triages?.pending ?? 0 })}</p>
              <p className="mt-1 text-xs text-foreground-secondary">
                {t('triage_agreement')}: {triages?.agreement_rate_pct == null ? t('triage_none') : `${triages.agreement_rate_pct}%`}
                {' · '}
                {t('triage_nmi')}: {triages?.needs_more_info_pct == null ? '—' : `${triages.needs_more_info_pct}%`}
              </p>
              <Link href={'/admin/disputes' as '/admin'} className="mt-2 inline-block text-xs font-medium text-primary underline underline-offset-2">{t('triage_link')}</Link>
            </div>
          </section>

          {/* Per-agent enable toggles */}
          <section className="rounded-card border border-border bg-surface shadow-card">
            <div className="flex items-center justify-between border-b border-border p-4">
              <div>
                <h2 className="text-sm font-semibold">{t('agents_title')}</h2>
                <p className="mt-1 text-xs text-foreground-secondary">{t('agents_subtitle')}</p>
              </div>
              <Button size="sm" loading={busy === 'agents_enabled'} disabled={!agentsDirty} onClick={() => put('agents_enabled', agentsDraft, 'agents_enabled')}>{t('save')}</Button>
            </div>
            <ul className="divide-y divide-border">
              {AGENT_NAMES.map((n: AgentName) => (
                <li key={n} className="flex items-center justify-between p-4">
                  <span className="font-mono text-sm capitalize">{humanName(n)}</span>
                  <input aria-label={n} type="checkbox" checked={Boolean(agentsDraft[n])} onChange={(e) => setAgentsDraft((d) => ({ ...d, [n]: e.target.checked }))} className="h-5 w-5 accent-primary" />
                </li>
              ))}
            </ul>
            <p className="border-t border-border px-4 py-3 text-xs text-foreground-secondary">{t('agents_note')}</p>
            {errors['agents_enabled'] && <p className="px-4 pb-3 text-xs text-danger">{errors['agents_enabled']}</p>}
          </section>

          {/* Budgets, cohort, consent version */}
          <section className="rounded-card border border-border bg-surface shadow-card">
            <div className="border-b border-border p-4">
              <h2 className="text-sm font-semibold">{t('budgets_title')}</h2>
              <p className="mt-1 text-xs text-foreground-secondary">{t('budgets_subtitle')}</p>
            </div>
            <ul className="divide-y divide-border">
              {settings.filter((s) => s.key !== 'agents_enabled').map((s) => {
                const isNumber = NUMBER_KEYS.includes(s.key)
                const isText = TEXT_KEYS.includes(s.key)
                return (
                  <li key={s.key} className="grid gap-3 p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]">
                    <div>
                      <p className="font-mono text-sm font-semibold">{s.key}</p>
                      <p className="mt-1 text-xs text-foreground-secondary">{AGENT_SETTING_DEFS[s.key]?.hint ?? s.hint}</p>
                      <p className="mt-1 text-[11px] text-foreground-secondary">{s.set ? t('updated_at', { date: fmtIST(s.updated_at) }) : t('not_set')}</p>
                    </div>
                    <div>
                      {isNumber || isText ? (
                        <Input aria-label={s.key} type={isNumber ? 'number' : 'text'} value={drafts[s.key] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))} />
                      ) : (
                        <textarea aria-label={s.key} value={drafts[s.key] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))} rows={3} className="w-full rounded-button border border-border bg-surface px-3 py-2 font-mono text-xs" />
                      )}
                      {errors[s.key] && <p className="mt-1 text-xs text-danger">{errors[s.key]}</p>}
                    </div>
                    <div className="md:text-right">
                      <Button size="sm" loading={busy === s.key} disabled={(drafts[s.key] ?? '') === toText(s.key, s.value)} onClick={() => saveSetting(s.key)}>{t('save')}</Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>

          {/* Kill switch */}
          <section className="rounded-card border border-danger/40 bg-surface shadow-card">
            <div className="p-4">
              <h2 className="text-sm font-semibold text-danger">{t('kill_title')}</h2>
              <p className="mt-1 text-xs text-foreground-secondary">{t('kill_subtitle')}</p>
              <div className="mt-3">
                {confirmKill ? (
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="danger" loading={busy === 'kill'} onClick={kill}>{t('kill_confirm')}</Button>
                    <Button size="sm" variant="outline" onClick={() => setConfirmKill(false)}>{t('cancel')}</Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setConfirmKill(true)}>{t('kill_button')}</Button>
                )}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function toText(key: AgentSettingKey, value: unknown): string {
  if (value == null) return ''
  if (NUMBER_KEYS.includes(key) || TEXT_KEYS.includes(key)) return String(value)
  return JSON.stringify(value, null, 2)
}

function fromText(key: AgentSettingKey, text: string): unknown {
  // An emptied field clears the key (null) for nullable keys such as
  // rfq_max_quotes / evidence_required_from; the registry rejects null elsewhere.
  if (text.trim() === '') return null
  if (NUMBER_KEYS.includes(key)) return Number(text)
  if (TEXT_KEYS.includes(key)) return text
  return JSON.parse(text)
}
