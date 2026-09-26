'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { Picker } from '@/components/ui-v3/Picker'

/* eslint-disable @typescript-eslint/no-explicit-any */

const TABS = ['overview', 'delivery', 'templates', 'spend', 'consents', 'unrouted'] as const
type Tab = (typeof TABS)[number]
const STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed', 'stub', 'skipped'] as const

async function getJson(url: string): Promise<{ ok: boolean; status: number; body: any }> {
  try {
    const r = await fetch(url, { cache: 'no-store' })
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) }
  } catch {
    return { ok: false, status: 0, body: null }
  }
}

function useIst() {
  const locale = useLocale()
  return (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString(locale === 'hi' ? 'hi-IN' : 'en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—'
}

const card = 'rounded-card border border-border bg-surface p-4 shadow-card'

/** /admin/whatsapp — the WhatsApp ops console (ADR-030 §6). Every tab reads its own admin route. */
export function WhatsAppConsoleClient() {
  const t = useTranslations('admin_whatsapp')
  const [tab, setTab] = useState<Tab>('overview')

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('tab')
    if (q && (TABS as readonly string[]).includes(q)) setTab(q as Tab)
  }, [])
  function select(next: Tab) {
    setTab(next)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', next)
    window.history.replaceState(null, '', url.toString())
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
      </div>
      <div role="tablist" aria-label={t('title')} className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => select(k)}
            className={`rounded-t-button px-3 py-2 text-sm font-medium ${tab === k ? 'border-b-2 border-primary text-primary' : 'text-foreground-secondary hover:text-foreground'}`}
          >
            {t(`tab_${k}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'overview' && <Overview />}
        {tab === 'delivery' && <Delivery />}
        {tab === 'templates' && <Templates />}
        {tab === 'spend' && <Spend />}
        {tab === 'consents' && <Consents />}
        {tab === 'unrouted' && <Unrouted />}
      </div>
    </div>
  )
}

function NotReady() {
  const t = useTranslations('admin_whatsapp')
  return <p className="rounded-card border border-warning/40 bg-warning/10 p-3 text-sm" data-testid="wa-not-ready">{t('not_ready')}</p>
}

function Loading() {
  const t = useTranslations('admin_whatsapp')
  return <p className="text-sm text-foreground-secondary">{t('loading')}</p>
}

function Failed() {
  const t = useTranslations('admin_whatsapp')
  return <p className="text-sm text-destructive">{t('error')}</p>
}

// ── overview ─────────────────────────────────────────────────────────────────

function Overview() {
  const t = useTranslations('admin_whatsapp')
  const ist = useIst()
  const [d, setD] = useState<any>(undefined)
  useEffect(() => { void getJson('/api/v1/admin/whatsapp/overview').then((r) => setD(r.ok ? r.body : null)) }, [])
  if (d === undefined) return <Loading />
  if (!d) return <Failed />
  const drv = d.driver
  const flag = (on: boolean) => (on ? t('ov_set') : t('ov_missing'))
  return (
    <div className="space-y-4" data-testid="wa-overview">
      {d.notReady && <NotReady />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className={card}>
          <p className="text-xs font-medium text-foreground-secondary">{t('ov_driver')}</p>
          <p className="mt-1 text-lg font-bold">{drv.driver === 'stub' ? t('ov_driver_stub') : drv.driver}</p>
          <p className={`mt-1 text-xs ${drv.live ? 'text-success' : 'text-foreground-secondary'}`}>{drv.live ? t('ov_live') : t('ov_not_live')} · {drv.configured ? t('ov_configured') : t('ov_not_configured')}</p>
        </div>
        <div className={card}>
          <p className="text-xs font-medium text-foreground-secondary">{t('ov_graph_version')}</p>
          <p className="mt-1 text-lg font-bold tabular-nums">{drv.graphVersion}</p>
        </div>
        <div className={card}>
          <p className="text-xs font-medium text-foreground-secondary">{t('ov_quality')}</p>
          <p className="mt-1 text-lg font-bold">{d.health.quality ?? '—'}</p>
          <p className="mt-1 text-xs text-foreground-secondary">{t('ov_tier')}: {d.health.tier ?? '—'}{d.health.at ? ` · ${ist(d.health.at)}` : ''}</p>
        </div>
        <div className={card}>
          <p className="text-xs font-medium text-foreground-secondary">{t('ov_conversations')}</p>
          <p className="mt-1 text-lg font-bold tabular-nums">{d.conversations ?? '—'}</p>
          <p className="mt-1 text-xs text-foreground-secondary">{t('ov_bound', { n: d.boundConversations ?? 0 })}</p>
        </div>
      </div>
      <div className={`${card} grid gap-2 text-sm sm:grid-cols-2`}>
        <p>{t('ov_last_inbound')}: <span className="font-medium">{d.lastInboundAt ? ist(d.lastInboundAt) : t('ov_never')}</span></p>
        <p>{t('ov_last_status')}: <span className="font-medium">{d.lastStatusAt ? ist(d.lastStatusAt) : t('ov_never')}</span></p>
        <p>{t('ov_account_event')}: <span className="font-medium">{d.health.event ?? '—'}</span></p>
        <p>{t('ov_phone_number_id')}: {flag(drv.phoneNumberIdSet)} · {t('ov_token')}: {flag(drv.tokenSet)} · {t('ov_app_secret')}: {flag(drv.appSecretSet)} · {t('ov_waba_id')}: {flag(drv.wabaIdSet)}</p>
      </div>
      <p className="text-xs text-foreground-secondary">{t('ov_secrets_note')}</p>
    </div>
  )
}

// ── delivery log ─────────────────────────────────────────────────────────────

function Delivery() {
  const t = useTranslations('admin_whatsapp')
  const ist = useIst()
  const [f, setF] = useState({ kind: '', status: '', error: '' })
  const [d, setD] = useState<any>(undefined)
  const [detail, setDetail] = useState<any>(null)
  const load = useCallback(async (filters: { kind: string; status: string; error: string }) => {
    setD(undefined)
    const sp = new URLSearchParams()
    if (filters.kind) sp.set('kind', filters.kind)
    if (filters.status) sp.set('status', filters.status)
    if (filters.error) sp.set('error', filters.error)
    const r = await getJson(`/api/v1/admin/whatsapp/messages?${sp}`)
    setD(r.ok ? r.body : null)
  }, [])
  useEffect(() => { void load({ kind: '', status: '', error: '' }) }, [load])
  async function view(id: string) {
    const r = await getJson(`/api/v1/admin/whatsapp/messages/${id}`)
    setDetail(r.ok ? r.body?.message ?? null : null)
  }
  return (
    <div className="space-y-4" data-testid="wa-delivery">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void load(f) }}>
        <div className="w-48 text-sm">
          <span className="block text-xs text-foreground-secondary" aria-hidden>{t('dl_filter_kind')}</span>
          <Picker label={t('dl_filter_kind')} value={f.kind || null} placeholder={t('dl_all')} allowClear clearLabel={t('dl_all')} options={(d?.kinds ?? []).map((k: string) => ({ value: k, label: k }))} onChange={(v) => setF({ ...f, kind: v ?? '' })} />
        </div>
        <div className="w-48 text-sm">
          <span className="block text-xs text-foreground-secondary" aria-hidden>{t('dl_filter_status')}</span>
          <Picker label={t('dl_filter_status')} value={f.status || null} placeholder={t('dl_all')} allowClear clearLabel={t('dl_all')} options={STATUSES.map((s) => ({ value: s, label: t(`status_${s}`) }))} onChange={(v) => setF({ ...f, status: v ?? '' })} />
        </div>
        <label className="text-sm">
          <span className="block text-xs text-foreground-secondary">{t('dl_filter_error')}</span>
          <input className="field-control w-32" inputMode="numeric" value={f.error} onChange={(e) => setF({ ...f, error: e.target.value.replace(/\D/g, '') })} />
        </label>
        <Button size="sm" type="submit">{t('dl_apply')}</Button>
      </form>
      {d === undefined ? <Loading /> : !d ? <Failed /> : d.notReady ? <NotReady /> : (
        <>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="font-medium">{t('dl_total', { n: d.total })}</span>
            {STATUSES.filter((s) => d.counts[s]).map((s) => (
              <span key={s} className="rounded-full bg-muted px-2 py-0.5">{t(`status_${s}`)} {d.counts[s]}</span>
            ))}
          </div>
          {d.topErrors.length > 0 && (
            <div className={card}>
              <p className="text-xs font-medium text-foreground-secondary">{t('dl_top_errors')}</p>
              <ul className="mt-1 space-y-0.5 text-sm">
                {d.topErrors.map((e: any) => <li key={e.code} className="tabular-nums">{e.code}{e.title ? ` · ${e.title}` : ''} — {e.n}</li>)}
              </ul>
            </div>
          )}
          {d.rows.length === 0 ? <p className="text-sm text-foreground-secondary">{t('dl_none')}</p> : (
            <div className="overflow-x-auto rounded-card border border-border" tabIndex={0} role="region" aria-label={t('tab_delivery')}>
              <table className="w-full text-left text-sm">
                <thead className="bg-muted text-xs text-foreground-secondary">
                  <tr>
                    <th className="p-2">{t('dl_col_time')}</th><th className="p-2">{t('dl_col_kind')}</th><th className="p-2">{t('dl_col_template')}</th>
                    <th className="p-2">{t('dl_col_language')}</th><th className="p-2">{t('dl_col_status')}</th><th className="p-2">{t('dl_col_error')}</th>
                    <th className="p-2">{t('dl_col_phone')}</th><th className="p-2"><span className="sr-only">{t('dl_view')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r: any) => (
                    <tr key={r.id} className="border-t border-border" data-testid="wa-delivery-row">
                      <td className="whitespace-nowrap p-2">{ist(r.createdAt)}</td>
                      <td className="p-2 font-mono text-xs">{r.kind}</td>
                      <td className="p-2 font-mono text-xs">{r.template ?? '—'}</td>
                      <td className="p-2">{r.language ?? '—'}</td>
                      <td className="p-2">{(STATUSES as readonly string[]).includes(r.status) ? t(`status_${r.status}`) : r.status}</td>
                      <td className="p-2 text-xs">{r.errorCode != null ? `${r.errorCode}${r.errorTitle ? ` · ${r.errorTitle}` : ''}` : '—'}</td>
                      <td className="p-2 tabular-nums">{r.phoneMasked ?? '—'}</td>
                      <td className="p-2"><Button size="sm" variant="ghost" onClick={() => void view(r.id)}>{t('dl_view')}</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {detail && (
        <section className={`${card} border-primary/30`} data-testid="wa-message-detail">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-base font-semibold">{t('dl_detail_title')}</h2>
            <button type="button" className="text-sm text-foreground-secondary underline" onClick={() => setDetail(null)}>{t('close')}</button>
          </div>
          <p className="mt-1 text-xs text-foreground-secondary">{ist(detail.createdAt)} · {detail.phoneMasked ?? '—'} · {detail.kind}{detail.template ? ` · ${detail.template}` : ''}</p>
          {detail.redactedAt ? <p className="mt-2 text-sm italic">{t('dl_redacted', { time: ist(detail.redactedAt) })}</p> : (
            <>
              <p className="mt-2 whitespace-pre-wrap text-sm"><span className="font-medium">{t('dl_body')}:</span> {detail.body ?? t('dl_no_body')}</p>
              {detail.transcript && <p className="mt-1 whitespace-pre-wrap text-sm"><span className="font-medium">{t('dl_transcript')}:</span> {detail.transcript}</p>}
            </>
          )}
          {detail.hasMedia && <p className="mt-1 text-xs">{t('dl_media', { mime: detail.mime ?? '—' })}</p>}
          {detail.legalHold && <p className="mt-1 text-xs font-medium">{t('dl_legal_hold')}</p>}
          <p className="mt-2 text-xs text-foreground-secondary">{t('dl_read_logged')}</p>
        </section>
      )}
    </div>
  )
}

// ── templates ────────────────────────────────────────────────────────────────

function Templates() {
  const t = useTranslations('admin_whatsapp')
  const ist = useIst()
  const { toast } = useToast()
  const [d, setD] = useState<any>(undefined)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const r = await getJson('/api/v1/admin/whatsapp/templates')
    setD(r.ok ? r.body : null)
  }, [])
  useEffect(() => { void load() }, [load])
  async function sync() {
    setBusy(true)
    const r = await fetch('/api/v1/admin/whatsapp/templates/sync', { method: 'POST' }).catch(() => null)
    const body = r ? await r.json().catch(() => null) : null
    setBusy(false)
    if (r?.ok) toast(t('tp_synced', { n: body?.fetched ?? 0 }))
    else if (body?.error === 'not_configured') toast(t('tp_sync_not_configured'))
    else if (body?.error === 'not_ready') toast(t('not_ready'))
    else toast(t('tp_sync_failed'))
    await load()
  }
  if (d === undefined) return <Loading />
  if (!d) return <Failed />
  return (
    <div className="space-y-4" data-testid="wa-templates">
      {d.notReady && <NotReady />}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => void sync()} disabled={busy || !d.syncConfigured} data-testid="wa-template-sync">{busy ? t('tp_syncing') : t('tp_sync')}</Button>
        <p className="text-xs text-foreground-secondary">
          {d.syncConfigured ? (d.lastSyncedAt ? t('tp_last_synced', { time: ist(d.lastSyncedAt) }) : t('tp_never_synced')) : t('tp_sync_not_configured')}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {(['in_code_not_approved', 'approved_not_in_code', 'ok', 'not_in_code'] as const).filter((k) => d.flags?.[k]).map((k) => (
          <span key={k} className="rounded-full bg-muted px-2 py-0.5">{t(`flag_${k}`)} {d.flags[k]}</span>
        ))}
      </div>
      {d.rows.length === 0 ? <p className="text-sm text-foreground-secondary">{t('tp_none')}</p> : (
        <div className="overflow-x-auto rounded-card border border-border" tabIndex={0} role="region" aria-label={t('tab_templates')}>
          <table className="w-full text-left text-sm">
            <thead className="bg-muted text-xs text-foreground-secondary">
              <tr>
                <th className="p-2">{t('tp_col_name')}</th><th className="p-2">{t('tp_col_language')}</th><th className="p-2">{t('tp_col_category')}</th>
                <th className="p-2">{t('tp_col_status')}</th><th className="p-2">{t('tp_col_reason')}</th><th className="p-2">{t('tp_col_synced')}</th><th className="p-2">{t('tp_col_flag')}</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r: any) => (
                <tr key={`${r.name}|${r.language}`} className="border-t border-border">
                  <td className="p-2 font-mono text-xs">{r.name}{r.kinds.length ? <span className="block text-foreground-secondary">{r.kinds.join(', ')}</span> : null}</td>
                  <td className="p-2">{r.language}</td>
                  <td className="p-2">{r.category ?? '—'}</td>
                  <td className="p-2">{r.status}</td>
                  <td className="p-2 text-xs">{r.rejectionReason ?? '—'}</td>
                  <td className="whitespace-nowrap p-2 text-xs">{ist(r.syncedAt)}</td>
                  <td className={`p-2 text-xs font-medium ${r.flag === 'ok' ? 'text-success' : r.flag === 'not_in_code' ? 'text-foreground-secondary' : 'text-destructive'}`}>{t(`flag_${r.flag}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── spend ────────────────────────────────────────────────────────────────────

function Spend() {
  const t = useTranslations('admin_whatsapp')
  const [d, setD] = useState<any>(undefined)
  useEffect(() => { void getJson('/api/v1/admin/whatsapp/spend').then((r) => setD(r.ok ? r.body : null)) }, [])
  if (d === undefined) return <Loading />
  if (!d) return <Failed />
  if (d.notReady) return <NotReady />
  const rep = d.report
  return (
    <div className="space-y-4" data-testid="wa-spend">
      <p className="text-xs text-foreground-secondary">{t('sp_note')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className={card}><p className="text-xs text-foreground-secondary">{t('sp_cost')}</p><p className="mt-1 text-2xl font-bold tabular-nums">{rep.total.cost}</p></div>
        <div className={card}><p className="text-xs text-foreground-secondary">{t('sp_messages')}</p><p className="mt-1 text-2xl font-bold tabular-nums">{rep.total.messages}</p></div>
        <div className={card}><p className="text-xs text-foreground-secondary">{t('sp_billable')}</p><p className="mt-1 text-2xl font-bold tabular-nums">{rep.total.billable}</p></div>
      </div>
      {d.truncated && <p className="text-xs text-warning">{t('sp_truncated')}</p>}
      {rep.byCategory.length > 0 && (
        <div className={card}>
          <p className="text-xs font-medium text-foreground-secondary">{t('sp_by_category')}</p>
          <ul className="mt-1 space-y-0.5 text-sm">
            {rep.byCategory.map((c: any) => <li key={c.category} className="tabular-nums">{c.category}: {c.cost} · {t('sp_count', { n: c.messages, b: c.billable })}</li>)}
          </ul>
        </div>
      )}
      {rep.days.length === 0 ? <p className="text-sm text-foreground-secondary">{t('sp_none')}</p> : (
        <div className="overflow-x-auto rounded-card border border-border" tabIndex={0} role="region" aria-label={t('tab_spend')}>
          <table className="w-full text-left text-sm">
            <thead className="bg-muted text-xs text-foreground-secondary">
              <tr><th className="p-2">{t('sp_day')}</th><th className="p-2">{t('sp_category')}</th><th className="p-2">{t('sp_messages')}</th><th className="p-2">{t('sp_billable')}</th><th className="p-2">{t('sp_cost')}</th></tr>
            </thead>
            <tbody>
              {rep.days.map((r: any) => (
                <tr key={`${r.day}|${r.category}`} className="border-t border-border tabular-nums">
                  <td className="p-2">{r.day}</td><td className="p-2">{r.category}</td><td className="p-2">{r.messages}</td><td className="p-2">{r.billable}</td><td className="p-2">{r.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── consents and suppressions ────────────────────────────────────────────────

function Consents() {
  const t = useTranslations('admin_whatsapp')
  const ist = useIst()
  const { toast } = useToast()
  const [d, setD] = useState<any>(undefined)
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(async () => {
    const r = await getJson('/api/v1/admin/whatsapp/consents')
    setD(r.ok ? r.body : null)
  }, [])
  useEffect(() => { void load() }, [load])
  async function clear(key: string) {
    if (!window.confirm(t('cs_clear_confirm'))) return
    setBusy(key)
    const r = await fetch(`/api/v1/admin/whatsapp/suppressions/${key}`, { method: 'DELETE' }).catch(() => null)
    setBusy(null)
    toast(r?.ok ? t('cs_cleared') : t('error'))
    await load()
  }
  if (d === undefined) return <Loading />
  if (!d) return <Failed />
  if (d.notReady) return <NotReady />
  return (
    <div className="space-y-4" data-testid="wa-consents">
      <div className="grid gap-3 sm:grid-cols-3">
        {d.counts.map((c: any) => (
          <div key={c.purpose} className={card}>
            <p className="text-xs font-medium text-foreground-secondary">{t(`purpose_${c.purpose}`)}</p>
            <p className="mt-1 text-sm tabular-nums">{t('cs_opted_in')}: <span className="font-bold">{c.optedIn}</span> · {t('cs_opted_out')}: <span className="font-bold">{c.optedOut}</span></p>
          </div>
        ))}
      </div>
      <div className={card}>
        <h2 className="text-sm font-semibold">{t('cs_recent_optouts')}</h2>
        {d.recentOptOuts.length === 0 ? <p className="mt-1 text-sm text-foreground-secondary">{t('cs_none')}</p> : (
          <ul className="mt-2 space-y-1 text-sm">
            {d.recentOptOuts.map((e: any, i: number) => (
              <li key={i} className="tabular-nums">{ist(e.at)} · {e.phoneMasked ?? '—'} · {t(`purpose_${e.purpose}`)} · {t('cs_source')}: {e.source}{e.keyword ? ` · “${e.keyword}”` : ''}</li>
            ))}
          </ul>
        )}
      </div>
      <div className={card}>
        <h2 className="text-sm font-semibold">{t('cs_suppressions')}</h2>
        <p className="mt-1 text-xs text-foreground-secondary">{t('cs_suppressions_note')}</p>
        {d.suppressions.length === 0 ? <p className="mt-1 text-sm text-foreground-secondary">{t('cs_none')}</p> : (
          <ul className="mt-2 space-y-2 text-sm">
            {d.suppressions.map((s: any) => (
              <li key={s.key} className="flex flex-wrap items-center justify-between gap-2" data-testid="wa-suppression">
                <span className="tabular-nums">{s.phoneMasked ?? '—'} · {t(`sup_reason_${s.reason}`)}{s.errorCode != null ? ` (${s.errorCode})` : ''} · {s.until ? t('cs_until', { time: ist(s.until) }) : t('cs_until_cleared')} · {ist(s.at)}</span>
                <Button size="sm" variant="outline" disabled={busy === s.key} onClick={() => void clear(s.key)}>{t('cs_clear')}</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── unrouted inbound ─────────────────────────────────────────────────────────

function Unrouted() {
  const t = useTranslations('admin_whatsapp')
  const ist = useIst()
  const { toast } = useToast()
  const [rows, setRows] = useState<any[] | null | undefined>(undefined)
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const r = await getJson('/api/v1/admin/whatsapp/unrouted')
    setRows(r.ok ? r.body?.rows ?? [] : null)
  }, [])
  useEffect(() => { void load() }, [load])
  async function send(conversationId: string) {
    if (!text.trim()) return
    setBusy(true)
    const r = await fetch(`/api/v1/admin/whatsapp/unrouted/${conversationId}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, clickId: crypto.randomUUID() }) }).catch(() => null)
    const body = r ? await r.json().catch(() => null) : null
    setBusy(false)
    if (r?.status === 409 && body?.error === 'outside_window') return toast(t('ur_outside_window'))
    if (!r?.ok) return toast(t('error'))
    toast(t('ur_outcome', { outcome: body?.outcome ?? '—', reason: body?.reason ?? '—' }))
    setText('')
    setReplyTo(null)
  }
  async function ticket(conversationId: string) {
    setBusy(true)
    const r = await fetch(`/api/v1/admin/whatsapp/unrouted/${conversationId}/ticket`, { method: 'POST' }).catch(() => null)
    const body = r ? await r.json().catch(() => null) : null
    setBusy(false)
    if (r?.status === 409 && body?.error === 'no_account') return toast(t('ur_no_account'))
    toast(r?.ok ? t('ur_ticket_opened', { ref: body?.ref ?? '' }) : t('error'))
  }
  if (rows === undefined) return <Loading />
  if (rows === null) return <Failed />
  return (
    <div className="space-y-3" data-testid="wa-unrouted">
      <p className="text-sm text-foreground-secondary">{t('ur_intro')}</p>
      {rows.length === 0 && <p className="text-sm text-foreground-secondary">{t('ur_none')}</p>}
      {rows.map((m) => (
        <article key={m.id} className={card} data-testid="wa-unrouted-row">
          <p className="text-xs text-foreground-secondary tabular-nums">{ist(m.at)} · {m.phoneMasked ?? '—'} · {m.kind}</p>
          <p className="mt-1 text-sm">{m.preview || '—'}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={!m.windowOpen || busy} onClick={() => { setReplyTo(m.id); setText('') }}>{t('ur_reply')}</Button>
            <Button size="sm" variant="ghost" disabled={!m.hasAccount || busy} onClick={() => void ticket(m.conversationId)}>{t('ur_open_ticket')}</Button>
            {!m.windowOpen && <span className="text-xs text-foreground-secondary">{t('ur_window_closed')}</span>}
            {m.windowOpen && <span className="text-xs text-foreground-secondary">{t('ur_window_until', { time: ist(m.windowUntil) })}</span>}
            {!m.hasAccount && <span className="text-xs text-foreground-secondary">{t('ur_no_account')}</span>}
          </div>
          {replyTo === m.id && (
            <div className="mt-2 space-y-2">
              <textarea className="field-control w-full" rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('ur_reply_placeholder')} aria-label={t('ur_reply_placeholder')} />
              <Button size="sm" disabled={busy || !text.trim()} onClick={() => void send(m.conversationId)}>{t('ur_send')}</Button>
            </div>
          )}
        </article>
      ))}
    </div>
  )
}
