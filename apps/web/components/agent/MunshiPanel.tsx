'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { CATEGORY_LIST, MUNSHI_CONSENT_TEXT_VERSION, formatRupees, type MunshiDraft, type ThreadReplyDraft } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'

interface WeekCounts {
  proposed: number
  approved: number
  edited: number
  skipped: number
  expired: number
  failed: number
  accepted_from_drafts: number
}

interface MunshiState {
  enabled: boolean
  grant: { web: boolean; whatsapp: boolean; whatsapp_number_masked: string | null }
  paused_until: string | null
  last_scan_at: string | null
  drafts_today: number
  drafts_awaiting: number
  week: WeekCounts
  price_book_rows: number
  settings: { maxDraftsPerDay: number; toleranceBps: number }
}

interface DraftView {
  id: string
  kind: 'quote' | 'ask' | 'skip' | 'reply'
  status: string
  rfq: { id: string; title: string } | null
  quote_id: string | null
  run_id: string | null
  draft: MunshiDraft | ThreadReplyDraft
  basis: { price_book_id: string; price_paise: number; accepted: boolean }[]
  payload: Record<string, unknown> | null
  expires_at: string
  created_at: string
}

interface PriceRow {
  id: string
  category_slug: string
  unit: string
  price_paise: number
  delivery_days: number | null
  source: 'quote' | 'manual'
  accepted_at: string | null
  confirmed_at: string
}

/**
 * The Munshi partner tab (S2.2). Every write here is the provider's own tap:
 * Approve posts the run's proposed payload UNCHANGED as `final` to the
 * decision route (the ordinary quote / clarification / message route runs
 * under the delegated token on resume); Edit opens the composer prefilled
 * with the draft; Skip declines the parked run. No client money arithmetic —
 * the server's paise are rendered as-is.
 */
export function MunshiPanel({ whatsappNumber }: { whatsappNumber: string | null }) {
  const t = useTranslations('partner_munshi')
  const locale = useLocale()
  const { toast } = useToast()
  const [state, setState] = useState<MunshiState | null>(null)
  const [drafts, setDrafts] = useState<DraftView[]>([])
  const [rows, setRows] = useState<PriceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [add, setAdd] = useState({ category_slug: CATEGORY_LIST[0]?.slug ?? '', price: '', delivery_days: '' })

  const load = useCallback(async () => {
    const [s, d, p] = await Promise.all([
      fetch('/api/v1/agent/munshi', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/v1/agent/munshi/drafts', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { drafts: [] })).catch(() => ({ drafts: [] })),
      fetch('/api/v1/partner/price-book', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { rows: [] })).catch(() => ({ rows: [] })),
    ])
    setState(s)
    setDrafts(d?.drafts ?? [])
    setRows(p?.rows ?? [])
    setLoading(false)
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  async function post(path: string, body?: unknown): Promise<Response> {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  }
  async function switchTo(action: 'enable' | 'pause' | 'disable') {
    setBusy(action)
    const res = await post(`/api/v1/agent/munshi/${action}`, action === 'enable' ? { locale, consent_text_version: MUNSHI_CONSENT_TEXT_VERSION } : action === 'pause' ? { hours: 24 } : {})
    setBusy(null)
    if (!res.ok) return toast(t('toast_error'))
    toast(t(action === 'enable' ? 'toast_enabled' : action === 'pause' ? 'toast_paused' : 'toast_disabled'))
    await load()
  }
  async function approve(d: DraftView) {
    if (!d.run_id || !d.payload) return toast(t('toast_error'))
    setBusy(d.id)
    const res = await post(`/api/v1/agent/runs/${d.run_id}/decision`, { approve: true, final: d.payload, input_refs: { munshi_draft_id: d.id } })
    setBusy(null)
    if (!res.ok) return toast(t('toast_error'))
    toast(t('toast_approved'))
    await load()
  }
  async function skip(d: DraftView) {
    setBusy(d.id)
    const res = await post(`/api/v1/agent/munshi/drafts/${d.id}/skip`)
    setBusy(null)
    if (!res.ok) return toast(t('toast_error'))
    toast(t('toast_skipped'))
    await load()
  }
  async function addRow() {
    const price = Number(add.price)
    if (!add.category_slug || !Number.isFinite(price) || price <= 0) return
    setBusy('add')
    // Rupees typed by the provider → paise for the server (display conversion only; the server stores what it receives).
    const res = await post('/api/v1/partner/price-book', { category_slug: add.category_slug, unit: 'job', price_paise: Math.round(price * 100), ...(add.delivery_days ? { delivery_days: Number(add.delivery_days) } : {}) })
    setBusy(null)
    if (!res.ok) return toast(t('toast_error'))
    setAdd({ ...add, price: '', delivery_days: '' })
    await load()
  }
  async function deleteRow(id: string) {
    setBusy(id)
    const res = await fetch(`/api/v1/partner/price-book/${id}`, { method: 'DELETE' })
    setBusy(null)
    if (!res.ok) return toast(t('toast_error'))
    await load()
  }

  if (loading) return <p className="text-sm text-foreground-secondary">{t('loading')}</p>
  if (!state) return <p className="text-sm text-foreground-secondary">{t('unavailable')}</p>
  const catName = (slug: string) => {
    const c = CATEGORY_LIST.find((x) => x.slug === slug)
    return c ? (locale === 'hi' ? c.name_i18n.hi : c.name_i18n.en) : slug
  }
  const hoursLeft = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 3600000))

  return (
    <div className="space-y-6">
      {/* Enable card */}
      <section className="rounded-card border border-border bg-surface p-5 shadow-card" data-testid="munshi-enable-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{t('enable_title')}</h2>
            <p className="mt-1 text-sm text-foreground-secondary">{t('enable_what')}</p>
            <p className="mt-1 text-sm text-foreground-secondary">{t('enable_never')}</p>
          </div>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${state.enabled ? 'bg-success/10 text-success' : 'bg-muted text-foreground-secondary'}`}>
            {state.enabled ? (state.paused_until ? t('paused_badge') : t('enabled_badge')) : t('disabled_badge')}
          </span>
        </div>
        <p className="mt-3 text-xs text-foreground-secondary">{t('consent_text')}</p>
        <p className="mt-1 text-xs text-foreground-secondary">
          {state.grant.whatsapp ? t('whatsapp_on', { number: state.grant.whatsapp_number_masked ?? '' }) : whatsappNumber ? t('whatsapp_off') : t('whatsapp_unavailable')}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {!state.enabled ? (
            <Button onClick={() => switchTo('enable')} disabled={busy === 'enable'} data-testid="munshi-enable">{t('enable_button')}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => switchTo('pause')} disabled={busy === 'pause' || !!state.paused_until}>{t('pause_button')}</Button>
              <Button variant="outline" onClick={() => switchTo('disable')} disabled={busy === 'disable'} data-testid="munshi-disable">{t('disable_button')}</Button>
            </>
          )}
        </div>
        {state.enabled && (
          <p className="mt-3 text-xs text-foreground-secondary">
            {state.paused_until ? t('paused_until', { at: new Date(state.paused_until).toLocaleString('en-IN') }) : state.last_scan_at ? t('last_scan', { at: new Date(state.last_scan_at).toLocaleString('en-IN') }) : t('no_scan_yet')}
            {' · '}
            {t('drafts_today', { n: state.drafts_today, max: state.settings.maxDraftsPerDay })}
          </p>
        )}
      </section>

      {/* Drafts awaiting */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t('drafts_title', { n: drafts.length })}</h2>
        {drafts.length === 0 && <p className="text-sm text-foreground-secondary">{state.price_book_rows === 0 ? t('drafts_empty_no_book') : t('drafts_empty')}</p>}
        {drafts.map((d) => {
          const md = d.kind === 'reply' ? null : (d.draft as MunshiDraft)
          const rd = d.kind === 'reply' ? (d.draft as ThreadReplyDraft) : null
          const prices = d.basis.map((b) => b.price_paise)
          return (
            <article key={d.id} className="rounded-card border border-border bg-surface p-4 shadow-card" data-testid="munshi-draft" data-kind={d.kind}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">{d.rfq?.title ?? '—'}</p>
                  <span className="mt-1 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">{t(`action_${d.kind}`)}</span>
                </div>
                <span className="text-xs text-foreground-secondary">{t('expires_in', { h: hoursLeft(d.expires_at) })}</span>
              </div>
              {md?.action === 'quote' && md.quote && (
                <p className="mt-2 text-base font-semibold tabular-nums">
                  {formatRupees(md.quote.price_paise)} · {t('days', { n: md.quote.delivery_days })}
                </p>
              )}
              {md?.action === 'quote' && md.quote && <p className="mt-1 text-sm">{md.quote.scope}</p>}
              {md?.action === 'ask' && md.question && (
                <p className="mt-2 text-sm">
                  <span className="font-medium">{t('question_label')}:</span> {md.question}
                </p>
              )}
              {rd && <p className="mt-2 text-sm">{rd.body}</p>}
              {d.basis.length > 0 && (
                <p className="mt-2 text-xs text-foreground-secondary">{t('basis_line', { n: d.basis.length, min: formatRupees(Math.min(...prices)), max: formatRupees(Math.max(...prices)) })}</p>
              )}
              {md && (
                <ul className="mt-2 list-disc pl-5 text-xs text-foreground-secondary">
                  {md.rationale.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => approve(d)} disabled={busy === d.id || !d.payload} data-testid="munshi-approve">{t('approve')}</Button>
                {d.kind === 'quote' && d.rfq && (
                  <Link href={{ pathname: '/partner/rfqs/[id]', params: { id: d.rfq.id }, query: { munshi: d.id } } as never} className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted" data-testid="munshi-edit">{t('edit')}</Link>
                )}
                {d.kind !== 'quote' && d.rfq && (
                  <Link href={{ pathname: '/partner/rfqs/[id]', params: { id: d.rfq.id } } as never} className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted">{t('open_request')}</Link>
                )}
                <Button size="sm" variant="ghost" onClick={() => skip(d)} disabled={busy === d.id} data-testid="munshi-skip">{t('skip')}</Button>
              </div>
            </article>
          )
        })}
      </section>

      {/* This week */}
      <section className="rounded-card border border-border bg-surface p-4 shadow-card">
        <h2 className="text-lg font-semibold">{t('week_title')}</h2>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
          {(['proposed', 'approved', 'edited', 'skipped', 'accepted_from_drafts'] as const).map((k) => (
            <div key={k}>
              <dt className="text-xs text-foreground-secondary">{t(`week_${k}`)}</dt>
              <dd className="text-xl font-bold tabular-nums">{state.week[k]}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Price book */}
      <section className="rounded-card border border-border bg-surface p-4 shadow-card" data-testid="munshi-price-book">
        <h2 className="text-lg font-semibold">{t('price_book_title')}</h2>
        <p className="mt-1 text-xs text-foreground-secondary">{t('price_book_hint')}</p>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-foreground-secondary">{t('price_book_empty')}</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-foreground-secondary">
                <th className="py-1">{t('pb_category')}</th>
                <th className="py-1">{t('pb_price')}</th>
                <th className="py-1">{t('pb_delivery')}</th>
                <th className="py-1">{t('pb_source')}</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="py-1">{catName(r.category_slug)}</td>
                  <td className="py-1 tabular-nums">
                    {formatRupees(r.price_paise)}
                    {r.accepted_at && <span className="ml-1 text-success" title={t('pb_accepted')}>✓</span>}
                  </td>
                  <td className="py-1">{r.delivery_days ?? '—'}</td>
                  <td className="py-1 text-xs text-foreground-secondary">{t(r.source === 'manual' ? 'pb_source_manual' : 'pb_source_quote')}</td>
                  <td className="py-1 text-right">
                    <button type="button" onClick={() => deleteRow(r.id)} disabled={busy === r.id} className="text-xs text-destructive underline underline-offset-2">{t('pb_delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-4 grid gap-2 sm:grid-cols-4">
          <select className="field" value={add.category_slug} onChange={(e) => setAdd({ ...add, category_slug: e.target.value })} aria-label={t('pb_category')}>
            {CATEGORY_LIST.map((c) => (
              <option key={c.slug} value={c.slug}>{locale === 'hi' ? c.name_i18n.hi : c.name_i18n.en}</option>
            ))}
          </select>
          <input className="field" inputMode="decimal" placeholder={t('pb_price_placeholder')} value={add.price} onChange={(e) => setAdd({ ...add, price: e.target.value })} aria-label={t('pb_price')} />
          <input className="field" inputMode="numeric" placeholder={t('pb_delivery_placeholder')} value={add.delivery_days} onChange={(e) => setAdd({ ...add, delivery_days: e.target.value })} aria-label={t('pb_delivery')} />
          <Button variant="outline" onClick={addRow} disabled={busy === 'add'} data-testid="munshi-pb-add">{t('pb_add_button')}</Button>
        </div>
      </section>
    </div>
  )
}
