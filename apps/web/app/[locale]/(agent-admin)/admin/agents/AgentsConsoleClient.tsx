'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { AGENT_NAMES, AGENT_SETTING_DEFS, type AgentName, type AgentSettingKey } from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'

interface SettingRow { key: AgentSettingKey; value: unknown; set: boolean; updated_at: string | null; hint: string }
interface SpendBucket { ai_paise: number; commission_paise: number; ai_share_pct: number | null }
interface Spend { today: SpendBucket; month: SpendBucket }
interface DossierStats { pending: number; decided: number; approve_rate_pct: number | null; median_completed_to_decision_min: number | null }

const NUMBER_KEYS: AgentSettingKey[] = ['budget_run_paise', 'budget_user_day_paise', 'budget_month_paise', 'rfq_max_quotes', 'quote_window_hours']
const TEXT_KEYS: AgentSettingKey[] = ['whatsapp_opt_in_text_version', 'evidence_required_from']
// everything else that is not agents_enabled edits as JSON (cohort_user_ids).

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const humanName = (n: string) => n.replace(/_/g, ' ')
const fmtIST = (v: string | null) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '—')

export function AgentsConsoleClient() {
  const t = useTranslations('admin_agents')
  const { toast } = useToast()
  const [settings, setSettings] = useState<SettingRow[]>([])
  const [spend, setSpend] = useState<Spend | null>(null)
  const [dossiers, setDossiers] = useState<DossierStats | null>(null)
  const [agentsDraft, setAgentsDraft] = useState<Record<string, boolean>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [confirmKill, setConfirmKill] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [s, sp, ds] = await Promise.all([
      fetch('/api/v1/agent/admin/settings', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { settings: [] })),
      fetch('/api/v1/agent/admin/spend', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
      fetch('/api/v1/agent/admin/dossiers/stats', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
    const rows: SettingRow[] = s.settings ?? []
    setSettings(rows)
    const enabled = (rows.find((r) => r.key === 'agents_enabled')?.value ?? {}) as Record<string, boolean>
    setAgentsDraft(Object.fromEntries(AGENT_NAMES.map((n) => [n, Boolean(enabled[n])])))
    setDrafts(Object.fromEntries(rows.filter((r) => r.key !== 'agents_enabled').map((r) => [r.key, toText(r.key, r.value)])))
    setSpend(sp)
    setDossiers(ds)
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
