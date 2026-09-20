'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { Link } from '@/i18n/navigation'
import { MessageSquare, Star, ShieldCheck, StarOff } from 'lucide-react'
import {
  BUYER_DECLINE_REASONS,
  COMPARE_ATTENTION_FLAGS,
  COMPARE_FACT_FLAGS,
  compareLabel,
  declineMessageTemplate,
  type CompareFlag,
  type CompareQuoteResult,
  type ComparePointersCache,
  type DeclineMessageLocale,
  type QuoteDeclineReason,
} from '@amclub/shared'
import type { RfqDetailForBuyer, QuoteForBuyer } from '@/lib/rfq/queries'
import { formatINR, formatINRExact, formatResponseTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { QuoteTermsRow } from './QuoteTermsRow'

type Sort = 'price' | 'delivery' | 'rating' | 'response'

export interface QuoteCompareProps {
  rfq: RfqDetailForBuyer
  /** Deterministic flags + normalised totals (shared compareQuotes) — computed server-side, no flag involved. */
  compare: CompareQuoteResult[]
  /** Cached pointers from the server render, or null (loaded client-side after mount when enabled). */
  pointers: ComparePointersCache | null
  /** AGENT_ENABLED + agents_enabled.compare_pointers + cohort for this buyer. */
  pointersEnabled: boolean
}

/**
 * Buyer compare (S1.2 §6): a side-by-side table on ≥ md (sticky label column,
 * horizontal scroll inside the container) and stacked cards below md. Flags
 * and normalised totals are code; pointers (≤ 3 lines per quote) are the only
 * model output and can never rank. Shortlist is session-only client state.
 * Decline opens a sheet: reason, optional private note, the template preview
 * in the provider's language, no undo (the quote machine has no way back).
 */
export function QuoteCompare({ rfq, compare, pointers: initialPointers, pointersEnabled }: QuoteCompareProps) {
  const t = useTranslations('rfq')
  const locale = useLocale()
  const router = useRouter()
  const [sort, setSort] = useState<Sort>('price')
  const [threadFor, setThreadFor] = useState<string | null>(null)
  const [accepting, setAccepting] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pointers, setPointers] = useState<ComparePointersCache | null>(initialPointers)
  const [pointersState, setPointersState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>(initialPointers ? 'ready' : 'idle')
  const [shortlist, setShortlist] = useState<Set<string>>(new Set())
  const [shortlistOnly, setShortlistOnly] = useState(false)
  const [declining, setDeclining] = useState<QuoteForBuyer | null>(null)
  const [localDeclined, setLocalDeclined] = useState<Record<string, QuoteDeclineReason>>({})

  const goods = rfq.kind === 'goods'
  const specUnit = String(rfq.goodsSpec?.['unit'] ?? '')
  const specQty = Number(rfq.goodsSpec?.['qty'] ?? 0)
  const resultById = useMemo(() => new Map(compare.map((r) => [r.id, r])), [compare])
  const pointerById = useMemo(() => new Map((pointers?.pointers ?? []).map((p) => [p.quote_id, p.lines])), [pointers])
  const labelById = useMemo(() => new Map(rfq.quotes.map((q, i) => [q.id, compareLabel(i)])), [rfq.quotes])

  // Shortlist: sessionStorage keyed by RFQ (per-viewer convenience, never server state).
  const storageKey = `amc:shortlist:${rfq.id}`
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey)
      if (raw) setShortlist(new Set(JSON.parse(raw) as string[]))
    } catch { /* storage unavailable — fine */ }
  }, [storageKey])
  const toggleShortlist = useCallback((id: string) => {
    setShortlist((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try { sessionStorage.setItem(storageKey, JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }, [storageKey])

  // Pointers load after mount when enabled and not cached — the table never waits on the model.
  useEffect(() => {
    if (!pointersEnabled || initialPointers || rfq.quotes.length < 2) return
    let cancelled = false
    setPointersState('loading')
    fetch(`/api/v1/rfq/${rfq.id}/compare?locale=${encodeURIComponent(locale)}`, { cache: 'no-store' })
      .then(async (r) => {
        const d = await r.json().catch(() => null)
        if (cancelled) return
        if (r.ok && d?.pointers) { setPointers(d.pointers); setPointersState('ready') }
        else setPointersState('unavailable')
      })
      .catch(() => { if (!cancelled) setPointersState('unavailable') })
    return () => { cancelled = true }
  }, [pointersEnabled, initialPointers, rfq.id, rfq.quotes.length, locale])

  const sorted = [...rfq.quotes].sort((a, b) => {
    if (sort === 'price') return goods && a.goods && b.goods ? a.goods.unitPricePaise - b.goods.unitPricePaise : (resultById.get(a.id)?.normalizedTotalPaise ?? a.pricePaise) - (resultById.get(b.id)?.normalizedTotalPaise ?? b.pricePaise)
    if (sort === 'delivery') return a.deliveryDays - b.deliveryDays
    if (sort === 'response') {
      const ra = a.provider.medianResponseMinutes, rb = b.provider.medianResponseMinutes
      if (ra == null && rb == null) return 0
      if (ra == null) return 1
      if (rb == null) return -1
      return ra - rb
    }
    return b.provider.avgRating - a.provider.avgRating
  })
  const quotes = shortlistOnly ? sorted.filter((q) => shortlist.has(q.id)) : sorted

  if (rfq.status === 'expired') {
    return (
      <div className="rounded-card border border-border bg-surface p-6 text-center shadow-card">
        <h2 className="text-lg font-semibold">{t('expired_title')}</h2>
        <p className="mt-1 text-sm text-foreground-secondary">{t('expired_body')}</p>
        <div className="mt-4 rounded-button bg-muted p-4 text-left">
          <p className="text-sm font-medium">{t('rescue_title')}</p>
          <p className="mt-1 text-xs text-foreground-secondary">{t('rescue_body')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href={(goods ? '/app/mart/rfq/new' : '/app/rfq/new') as '/app/rfq/new'}><Button>{t('rebroadcast')}</Button></Link>
            <Link href={(goods ? '/mart' : '/services') as '/services'}><Button variant="outline">{t('browse_providers')}</Button></Link>
          </div>
        </div>
      </div>
    )
  }
  if (rfq.quotes.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-border bg-surface p-8 text-center">
        <p className="text-sm font-medium">{t('no_quotes_yet_title')}</p>
        <p className="mt-1 text-sm text-foreground-secondary">{t('no_quotes_yet_body')}</p>
      </div>
    )
  }

  async function accept(quoteId: string) {
    setAccepting(quoteId)
    setError('')
    try {
      const res = await fetch('/api/v1/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId, idempotencyKey: crypto.randomUUID() }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : 'failed')
      if (d.simulated) {
        const sim = await fetch('/api/v1/checkout/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkoutSessionId: d.checkoutSessionId }) })
        const sd = await sim.json()
        if (!sim.ok) throw new Error(sd.error ?? 'failed')
        router.push(`/app/orders/${sd.orderId}?first=1`)
        return
      }
      router.push('/app/orders?processing=1')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'failed')
      setAccepting(null)
    }
  }

  const decided = rfq.status === 'accepted'
  const statusOf = (q: QuoteForBuyer) => (localDeclined[q.id] ? 'declined' : q.status)
  const reasonOf = (q: QuoteForBuyer) => localDeclined[q.id] ?? q.declineReason
  const flagsOf = (q: QuoteForBuyer): CompareFlag[] => resultById.get(q.id)?.flags ?? []
  const totalOf = (q: QuoteForBuyer) => resultById.get(q.id)?.normalizedTotalPaise ?? q.pricePaise
  const notesOf = (q: QuoteForBuyer) => resultById.get(q.id)?.normalizationNotes ?? []
  const noteText = (n: { code: string; paise?: number }) => (n.paise != null ? `${t(`compare_note_${n.code}` as 'compare_note_gst_added')} ${formatINRExact(n.paise)}` : t(`compare_note_${n.code}` as 'compare_note_gst_added'))

  const chipClass = (f: CompareFlag) =>
    COMPARE_FACT_FLAGS.includes(f) ? 'border-success/40 bg-success-soft text-success' : COMPARE_ATTENTION_FLAGS.includes(f) ? 'border-warning/40 bg-warning-soft text-warning' : 'border-border bg-muted text-foreground-secondary'
  const Chips = ({ q }: { q: QuoteForBuyer }) => {
    const fs = flagsOf(q)
    if (fs.length === 0) return <span className="text-xs text-foreground-secondary">{t('compare_no_flags')}</span>
    return (
      <ul className="flex flex-wrap gap-1">
        {fs.map((f) => (
          <li key={f} className={`rounded-chip border px-2 py-0.5 text-[11px] font-medium ${chipClass(f)}`} title={t(`flag_${f}_meaning` as 'flag_gst_unstated_meaning')}>
            {t(`flag_${f}_label` as 'flag_gst_unstated_label')}
          </li>
        ))}
      </ul>
    )
  }
  const Pointers = ({ q }: { q: QuoteForBuyer }) => {
    if (!pointersEnabled || rfq.quotes.length < 2) return null
    const lines = pointerById.get(q.id)
    if (pointersState === 'loading') return <div className="h-3 w-40 animate-pulse rounded bg-muted" aria-label={t('compare_pointers_loading')} />
    if (!lines || lines.length === 0) return null
    return (
      <ul className="space-y-0.5 text-xs text-foreground">
        {lines.map((l, i) => <li key={i}>· {l}</li>)}
      </ul>
    )
  }
  const Actions = ({ q }: { q: QuoteForBuyer }) => {
    const st = statusOf(q)
    return (
      <div className="flex flex-wrap items-center gap-2">
        {!decided && st === 'submitted' && (
          <>
            <Button size="sm" onClick={() => accept(q.id)} loading={accepting === q.id} title={goods && q.goods ? t('goods_accept_note', { qty: q.goods.qty, unit: specUnit, total: formatINRExact(q.goods.totalInclGstPaise) }) : undefined}>
              {accepting === q.id ? t('accepting') : t('accept_quote')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDeclining(q)}>{t('decline_quote_button')}</Button>
          </>
        )}
        {st === 'accepted' && <span className="inline-flex items-center gap-1 text-xs font-medium text-success"><ShieldCheck className="h-3.5 w-3.5" />{t('status_accepted')}</span>}
        {st === 'declined' && (
          <span className="rounded-chip border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground-secondary">
            {reasonOf(q) === 'another_quote_accepted' ? t('declined_reason_label_another_quote_accepted') : reasonOf(q) ? t(`declined_reason_label_${reasonOf(q)}` as 'declined_reason_label_other') : t('status_declined')}
          </span>
        )}
        <button type="button" onClick={() => toggleShortlist(q.id)} aria-pressed={shortlist.has(q.id)} className="inline-flex items-center gap-1 text-xs text-foreground-secondary hover:text-accent" title={t('compare_shortlist')}>
          {shortlist.has(q.id) ? <Star className="h-4 w-4 fill-accent text-accent" /> : <StarOff className="h-4 w-4" />}
        </button>
        <Button variant="ghost" size="sm" onClick={() => setThreadFor(threadFor === q.id ? null : q.id)}>
          <MessageSquare className="mr-1 h-4 w-4" />{t('message_label')}
        </Button>
      </div>
    )
  }
  const Provider = ({ q }: { q: QuoteForBuyer }) => (
    <div className="min-w-0">
      <p className="text-[11px] font-medium text-foreground-secondary">{t('compare_quote_label', { label: labelById.get(q.id) ?? '' })}</p>
      <Link href={`/p/${q.provider.slug}`} className="text-sm font-semibold hover:text-primary">{q.provider.displayName}</Link>
      <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-foreground-secondary">
        {q.provider.avgRating > 0 ? <span className="inline-flex items-center gap-0.5"><Star className="h-3 w-3 fill-accent text-accent" />{q.provider.avgRating.toFixed(1)} ({q.provider.reviewCount})</span> : <span>{t('new_label')}</span>}
        {q.provider.udyamVerified && <span className="inline-flex items-center gap-1 rounded-chip border border-trust/30 bg-trust/10 px-1.5 py-0.5 text-[10px] font-medium text-trust"><ShieldCheck className="h-3 w-3" aria-hidden />{t('udyam_verified')}</span>}
      </p>
    </div>
  )
  const price = (q: QuoteForBuyer) => (goods && q.goods ? `${formatINRExact(q.goods.unitPricePaise)} ${t('goods_per_unit', { unit: specUnit })}` : formatINR(q.pricePaise))
  const yesNoUnstated = (v: boolean | null) => (v == null ? t('term_not_stated') : v ? t('term_yes') : t('term_no'))
  const dateOrUnstated = (iso: string | null) => (iso ? new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`)) : t('term_not_stated'))

  const rows: { key: string; label: string; cell: (q: QuoteForBuyer) => React.ReactNode }[] = [
    { key: 'provider', label: t('compare_table_provider'), cell: (q) => <Provider q={q} /> },
    { key: 'price', label: t('compare_table_price'), cell: (q) => <span className="font-display text-base font-bold text-primary tabular-nums">{price(q)}</span> },
    { key: 'total', label: t('compare_normalized'), cell: (q) => <span className="tabular-nums font-semibold" title={notesOf(q).length ? `${t('compare_normalized_why')}: ${notesOf(q).map(noteText).join('; ')}` : t('compare_normalized_why_none')}>{formatINRExact(totalOf(q))}{notesOf(q).length > 0 && <span className="ml-1 text-[11px] font-normal text-foreground-secondary" aria-hidden>ⓘ</span>}</span> },
    { key: 'delivery', label: t('compare_delivery'), cell: (q) => <span>{t('delivery_days', { days: q.deliveryDays })}</span> },
    { key: 'gst', label: t('term_gst'), cell: (q) => <span>{goods && q.goods ? `${q.goods.gstRateBps / 100}%` : yesNoUnstated(q.gstIncluded)}</span> },
    { key: 'transport', label: t('term_transport'), cell: (q) => <span>{yesNoUnstated(q.transportIncluded)}</span> },
    { key: 'valid', label: t('term_valid_until'), cell: (q) => <span>{dateOrUnstated(q.validUntil)}</span> },
    { key: 'advance', label: t('term_advance'), cell: (q) => <span>{q.advancePercent == null ? t('term_not_stated') : t('term_advance_value', { pct: q.advancePercent })}</span> },
    { key: 'response', label: t('compare_responds'), cell: (q) => <span>{formatResponseTime(q.provider.medianResponseMinutes) ?? '—'}</span> },
    { key: 'orders', label: t('compare_completed_orders'), cell: (q) => <span className="tabular-nums">{q.provider.completedOrders}</span> },
    { key: 'flags', label: t('compare_flags'), cell: (q) => <Chips q={q} /> },
    ...(pointersEnabled && rfq.quotes.length >= 2 ? [{ key: 'pointers', label: t('compare_pointers'), cell: (q: QuoteForBuyer) => <Pointers q={q} /> }] : []),
    { key: 'actions', label: t('compare_actions'), cell: (q) => <Actions q={q} /> },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('compare_title')}</h2>
        <div className="flex flex-wrap items-center gap-3 text-xs text-foreground-secondary">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={shortlistOnly} onChange={(e) => setShortlistOnly(e.target.checked)} disabled={shortlist.size === 0} />
            {t('compare_shortlisted_only')} ({shortlist.size})
          </label>
          <label className="flex items-center gap-2">
            {t('sort_label')}
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="rounded-button border border-border bg-surface px-2 py-1 text-foreground">
              <option value="price">{t('sort_price')}</option>
              <option value="delivery">{t('sort_delivery')}</option>
              <option value="rating">{t('sort_rating')}</option>
              <option value="response">{t('sort_response')}</option>
            </select>
          </label>
        </div>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
      {pointersEnabled && pointersState === 'unavailable' && <p className="text-xs text-foreground-secondary">{t('compare_pointers_unavailable')}</p>}

      {/* ≥ md: side-by-side table, sticky label column, horizontal scroll inside the container only. */}
      <div className="hidden overflow-x-auto rounded-card border border-border bg-surface shadow-card md:block">
        <table className="w-max min-w-full text-sm">
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-border last:border-0 align-top">
                <th scope="row" className="sticky left-0 z-10 w-40 bg-surface px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-foreground-secondary">{row.label}</th>
                {quotes.map((q) => (
                  <td key={q.id} className={`min-w-[14rem] max-w-xs px-3 py-2 ${statusOf(q) === 'declined' ? 'opacity-60' : ''} ${statusOf(q) === 'accepted' ? 'bg-success-soft/40' : ''}`}>{row.cell(q)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* < md: stacked cards (the existing card + chips + pointers). */}
      <ul className="space-y-3 md:hidden">
        {quotes.map((q) => (
          <li key={q.id} className={`rounded-card border bg-surface p-4 shadow-card ${statusOf(q) === 'accepted' ? 'border-success' : statusOf(q) === 'declined' ? 'border-border opacity-60' : 'border-border'}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <Provider q={q} />
              <div className="text-right">
                <p className="font-display text-lg font-bold text-primary tabular-nums">{price(q)}</p>
                <p className="text-xs text-foreground-secondary">{t('compare_normalized')}: <span className="font-semibold text-foreground">{formatINRExact(totalOf(q))}</span></p>
                <p className="text-xs text-foreground-secondary">{t('delivery_days', { days: q.deliveryDays })}{formatResponseTime(q.provider.medianResponseMinutes) ? ` · ${t('responds_in', { time: formatResponseTime(q.provider.medianResponseMinutes) as string })}` : ''}</p>
              </div>
            </div>
            {goods && q.goods && (
              <p className="mt-2 text-xs text-foreground-secondary tabular-nums">{q.goods.qty} {specUnit}{specQty && q.goods.qty !== specQty ? ' *' : ''} · {t('goods_col_gst')} {q.goods.gstRateBps / 100}% · {t('goods_col_incl')} {formatINRExact(q.goods.totalInclGstPaise)} · {t('goods_col_after_itc')} {formatINRExact(q.goods.afterItcPaise)}</p>
            )}
            <div className="mt-2"><Chips q={q} /></div>
            <div className="mt-2"><Pointers q={q} /></div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{q.scope}</p>
            <div className="mt-3 rounded-button border border-border bg-muted/40 p-3">
              <QuoteTermsRow terms={q} />
            </div>
            <div className="mt-3"><Actions q={q} /></div>
            {threadFor === q.id && <MessageThread quote={q} />}
          </li>
        ))}
      </ul>

      {/* Thread panel for the table view (cards render it inline). */}
      {threadFor && quotes.some((q) => q.id === threadFor) && (
        <div className="hidden md:block">
          <MessageThread quote={quotes.find((q) => q.id === threadFor)!} />
        </div>
      )}

      {declining && (
        <DeclineSheet
          quote={declining}
          rfqId={rfq.id}
          onClose={() => setDeclining(null)}
          onDeclined={(reason) => {
            setLocalDeclined((m) => ({ ...m, [declining.id]: reason }))
            setDeclining(null)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function DeclineSheet({ quote, rfqId, onClose, onDeclined }: { quote: QuoteForBuyer; rfqId: string; onClose: () => void; onDeclined: (reason: QuoteDeclineReason) => void }) {
  const t = useTranslations('rfq')
  const [reason, setReason] = useState<QuoteDeclineReason>('price_high')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const providerLocale = (quote.provider.messageLocale ?? 'en') as DeclineMessageLocale
  const preview = declineMessageTemplate(reason, providerLocale).message

  async function submit() {
    setBusy(true)
    setErr('')
    try {
      const res = await fetch(`/api/v1/rfq/${rfqId}/quote/${quote.id}/decline`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, ...(note.trim() ? { note: note.trim() } : {}) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : 'failed')
      onDeclined(reason)
    } catch {
      setErr(t('decline_quote_failed'))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="decline-quote-title">
      <div className="w-full max-w-lg rounded-t-card border border-border bg-surface p-5 shadow-card sm:rounded-card">
        <h3 id="decline-quote-title" className="font-display text-lg font-bold">{t('decline_quote_title')}</h3>
        <p className="mt-0.5 text-xs text-foreground-secondary">{quote.provider.displayName}</p>
        <fieldset className="mt-4 space-y-2">
          <legend className="text-xs font-medium text-foreground-secondary">{t('decline_quote_reason_label')}</legend>
          {BUYER_DECLINE_REASONS.map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm">
              <input type="radio" name="decline-reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
              {t(`decline_quote_reason_${r}` as 'decline_quote_reason_other')}
            </label>
          ))}
        </fieldset>
        <div className="mt-4">
          <label htmlFor="decline-note" className="text-xs font-medium text-foreground-secondary">{t('decline_quote_note_label')}</label>
          <textarea id="decline-note" value={note} onChange={(e) => setNote(e.target.value.slice(0, 200))} rows={2} maxLength={200} className="mt-1 w-full rounded-input border border-border bg-background p-2 text-sm" />
          <p className="mt-1 flex justify-between text-[11px] text-foreground-secondary"><span>{t('decline_quote_note_hint')}</span><span>{note.length}/200</span></p>
        </div>
        <div className="mt-3 rounded-button border border-border bg-muted/40 p-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-foreground-secondary">{t('decline_quote_preview_label')}</p>
          <p className="mt-1 text-sm">{preview}</p>
        </div>
        <p className="mt-3 text-xs text-foreground-secondary">{t('decline_quote_no_undo')}</p>
        {err && <p className="mt-2 text-sm text-danger">{err}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('decline_quote_cancel')}</Button>
          <Button onClick={submit} loading={busy}>{t('decline_quote_submit')}</Button>
        </div>
      </div>
    </div>
  )
}

interface ThreadMsg { id: string; mine: boolean; body: string; redacted: boolean; createdAt: string }

function MessageThread({ quote }: { quote: QuoteForBuyer }) {
  const t = useTranslations('rfq')
  const [messages, setMessages] = useState<ThreadMsg[]>([])
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fetch(`/api/v1/quotes/${quote.id}/messages`)
      .then(async (r) => {
        const d = await r.json().catch(() => null)
        return r.ok && d ? d : { messages: [] }
      })
      .then((d) => { setMessages(d.messages ?? []); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [quote.id])

  async function send() {
    if (!body.trim()) return
    setSending(true)
    try {
      const res = await fetch(`/api/v1/quotes/${quote.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: body.trim() }) })
      if (res.ok) {
        const m = await res.json()
        setMessages((prev) => [...prev, m])
        setBody('')
      }
    } finally { setSending(false) }
  }

  return (
    <div className="mt-3 rounded-button border border-border bg-muted/40 p-3">
      <p className="mb-2 flex items-center gap-1 text-xs text-foreground-secondary"><ShieldCheck className="h-3 w-3" />{t('masked_note')} · {quote.provider.displayName}</p>
      <div className="max-h-48 space-y-2 overflow-y-auto">
        {loaded && messages.length === 0 && <p className="text-xs text-foreground-secondary">{t('no_messages')}</p>}
        {messages.map((m) => (
          <div key={m.id} className={`max-w-[80%] rounded-card px-3 py-1.5 text-sm ${m.mine ? 'ml-auto bg-primary text-white' : 'bg-surface'}`}>{m.body}</div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder={t('message_placeholder')} className="flex-1 rounded-button border border-border bg-surface px-3 py-1.5 text-sm focus:border-primary focus:outline-none" />
        <Button onClick={send} loading={sending}>{t('send')}</Button>
      </div>
    </div>
  )
}
