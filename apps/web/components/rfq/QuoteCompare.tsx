'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { Link } from '@/i18n/navigation'
import { MessageSquare, Star, ShieldCheck, StarOff } from 'lucide-react'
import {
  BUYER_DECLINE_REASONS,
  COMPARE_ATTENTION_FLAGS,
  QUOTE_STATUS,
  COMPARE_FACT_FLAGS,
  DEFAULT_GST_BPS,
  compareLabel,
  declineMessageTemplate,
  type CompareFlag,
  type CompareOrdering,
  type CompareQuoteResult,
  type ComparePointersCache,
  type DeclineMessageLocale,
  type QuoteDeclineReason,
} from '@amclub/shared'
import type { RfqDetailForBuyer, QuoteForBuyer } from '@/lib/rfq/queries'
import { formatINR, formatINRExact, formatResponseTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { ConfirmSheet } from '@/components/ui/confirm-sheet'
import { CHECKOUT_ERROR_KEYS, checkoutErrorKey, isCheckoutExpired, newIdempotencyKey, payCheckout, startCheckout } from '@/lib/payments/razorpay-client'
import { QuoteTermsRow } from './QuoteTermsRow'
import { useAnalytics } from '@/components/providers/posthog'
import type { BenchmarkView, QuoteChoice } from '@amclub/shared'
import type { CompareChoices } from '@/lib/rfq/compare'
import { BenchmarkLine } from './BenchmarkLine'
import { SegmentedControl } from '@/components/ui-v3/SegmentedControl'

type Sort = 'price' | 'delivery' | 'rating' | 'response' | 'reliability'

export interface QuoteCompareProps {
  rfq: RfqDetailForBuyer
  /** Deterministic flags + normalised totals (shared compareQuotes) — computed server-side, no flag involved. */
  compare: CompareQuoteResult[]
  /** Cached pointers from the server render, or null (loaded client-side after mount when enabled). */
  pointers: ComparePointersCache | null
  /** AGENT_ENABLED + agents_enabled.compare_pointers + cohort for this buyer. */
  pointersEnabled: boolean
  /**
   * S2.4 — the server's order (ADR-010 §7). `reliability` only above the threshold with the switch on; the ids are
   * all this screen ever gets — never a score. Absent = the price order, exactly as before.
   */
  ordering?: CompareOrdering
  /**
   * S3.1 — the procurement agent's "go with B" link, VERIFIED server-side (the buyer's own approved choose_quote for this
   * RFQ + quote). The page opens its ordinary confirm sheet for that quote once; the checkout call is the one below, on
   * the buyer's own tap. Absent = nothing changes.
   */
  payQuoteId?: string | null
  /** S3.2 — the fair price range for this request (services, display switch on, a row passed the gates), or null = nothing. */
  benchmark?: BenchmarkView | null
  /**
   * PRD Experience v3 E7 (flag `compare`) — grouped rows (Price · Time · Terms · Provider · Flags), a sticky header,
   * scope on desktop, Compact by default, grouped cards below md. Same data, money and actions as v2.
   */
  v3?: boolean
  /**
   * E12b / ADR 020 — Economy · Standard · Express per quote, each with its checkout total and flags (server-computed),
   * and the lowest / fastest across them. Null / absent = no quote has options: the screen exactly as before.
   */
  choices?: CompareChoices | null
}

/**
 * Buyer compare (S1.2 §6): a side-by-side table on ≥ md (sticky label column,
 * horizontal scroll inside the container) and stacked cards below md. Flags
 * and normalised totals are code; pointers (≤ 3 lines per quote) are the only
 * model output and can never rank. Shortlist is session-only client state.
 * Decline opens a sheet: reason, optional private note, the template preview
 * in the provider's language, no undo (the quote machine has no way back).
 */
export function QuoteCompare({ rfq, compare, pointers: initialPointers, pointersEnabled, ordering, payQuoteId = null, benchmark = null, v3 = false, choices = null }: QuoteCompareProps) {
  const t = useTranslations('rfq')
  const tc = useTranslations('checkout')
  const locale = useLocale()
  const router = useRouter()
  const posthog = useAnalytics()
  const reliability = ordering?.mode === 'reliability'
  const [sort, setSortState] = useState<Sort>(reliability ? 'reliability' : 'price')
  const setSort = (next: Sort) => {
    if (next !== sort) {
      if (v3) posthog.capture('compare_sorted', { key: next, device: 'web' })
      else posthog.capture('compare_sort_changed', { locale, device: 'web', from: sort, to: next })
    }
    setSortState(next)
  }
  // E7 — v3 density: Compact by default on desktop.
  const [density, setDensity] = useState<'compact' | 'comfortable'>('compact')
  const rank = useMemo(() => new Map((ordering?.ids ?? []).map((id, i) => [id, i])), [ordering])
  const [threadFor, setThreadFor] = useState<string | null>(null)
  const [accepting, setAccepting] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pointers, setPointers] = useState<ComparePointersCache | null>(initialPointers)
  const [pointersState, setPointersState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>(initialPointers ? 'ready' : 'idle')
  const [shortlist, setShortlist] = useState<Set<string>>(new Set())
  const [shortlistOnly, setShortlistOnly] = useState(false)
  const [declining, setDeclining] = useState<QuoteForBuyer | null>(null)
  const [localDeclined, setLocalDeclined] = useState<Record<string, QuoteDeclineReason>>({})
  // Accept = confirm first (UX D1), then one checkout per quote. The key is
  // stable per quote for the page lifetime (P0-5): a retry or a double tap
  // resumes the same session instead of minting a second payable order.
  const [confirming, setConfirming] = useState<QuoteForBuyer | null>(null)
  const [confirmErr, setConfirmErr] = useState('')
  // E12b — the option picked per quote (null / absent = Standard, the quote itself).
  const [picked, setPicked] = useState<Record<string, string | null>>({})
  const quoteKeys = useRef(new Map<string, string>())
  const closeConfirm = useCallback(() => { setConfirming(null); setConfirmErr('') }, [])
  // S3.1 — open the ORDINARY confirm sheet for the agent-chosen quote once (a submitted quote on an undecided request only)
  const payOpened = useRef(false)
  useEffect(() => {
    if (!payQuoteId || payOpened.current || rfq.status === 'accepted') return
    const q = rfq.quotes.find((x) => x.id === payQuoteId && x.status === QUOTE_STATUS.submitted)
    if (!q) return
    payOpened.current = true
    setConfirming(q)
    posthog.capture('procurement_checkout_opened', { rfq_id: rfq.id, device: 'web' })
  }, [payQuoteId, rfq, posthog])
  /** E12b — the chosen option's server figures for this quote, or null (no options → the quote as before). */
  const choiceOf = (q: QuoteForBuyer): QuoteChoice | null => {
    const cs = choices?.byQuote[q.id]
    if (!cs || cs.length < 2) return null
    return cs.find((c) => c.optionId === (picked[q.id] ?? null)) ?? null
  }
  const keyForQuote = (quoteId: string) => {
    let k = quoteKeys.current.get(quoteId)
    if (!k) { k = newIdempotencyKey(); quoteKeys.current.set(quoteId, k) }
    return k
  }

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
    if (v3 && !shortlist.has(id)) posthog.capture('quote_shortlisted', { device: 'web' })
    setShortlist((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try { sessionStorage.setItem(storageKey, JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }, [storageKey, v3, shortlist, posthog])

  // E7 — one page view per mount (the S1.2 server compare_viewed fires only from the pointers route).
  const viewed = useRef(false)
  useEffect(() => {
    if (!v3 || viewed.current || rfq.quotes.length === 0) return
    viewed.current = true
    posthog.capture('compare_viewed', { quotes: rfq.quotes.length, device: 'web' })
    // E15 F1 — which deterministic flags the buyer saw (one event per flag kind per view): the outcome labels' inputs.
    const kinds = new Set(compare.flatMap((r) => r.flags))
    for (const flag of kinds) posthog.capture('compare_flag_viewed', { flag, device: 'web' })
  }, [v3, rfq.quotes.length, posthog, compare])

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
    if (sort === 'reliability') return (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
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
            <Link href={(goods ? '/app/mart/rfq/new' : `/app/rfq/new?from=${rfq.id}`) as '/app/rfq/new'}><Button>{t('rebroadcast')}</Button></Link>
            <Link href={(goods ? '/mart' : '/services') as '/services'}><Button variant="outline">{t('browse_providers')}</Button></Link>
          </div>
        </div>
      </div>
    )
  }
  if (rfq.quotes.length === 0) {
    const empty = (
      <div className="rounded-card border border-dashed border-border bg-surface p-8 text-center">
        <p className="text-sm font-medium">{t('no_quotes_yet_title')}</p>
        <p className="mt-1 text-sm text-foreground-secondary">{t('no_quotes_yet_body')}</p>
      </div>
    )
    // S3.2 — the range shows as soon as the request is open (above where the table will be); nothing when there is none
    return benchmark ? <div className="space-y-4"><BenchmarkLine view={benchmark} role="buyer" />{empty}</div> : empty
  }

  function askAccept(q: QuoteForBuyer) {
    setError('')
    setConfirmErr('')
    setConfirming(q)
  }

  // P0-4 — the same payment path as package checkout: simulation materialises
  // now; real keys open the Razorpay sheet. The WEBHOOK creates the order (and
  // finalizeQuoteAcceptance closes the RFQ); the redirect is cosmetic.
  async function accept(q: QuoteForBuyer) {
    // E7 — the buyer's confirm tap (intent only; payment truth stays the webhook).
    if (v3) posthog.capture('quote_accepted', { device: 'web' })
    setAccepting(q.id)
    setConfirmErr('')
    // E12b — the picked option rides to checkout, which re-reads and re-prices it; each choice has its own key.
    const optionId = choiceOf(q)?.optionId ?? null
    const keyName = optionId ? `${q.id}:${optionId}` : q.id
    try {
      const data = await startCheckout('/api/v1/checkout', { quoteId: q.id, idempotencyKey: keyForQuote(keyName), ...(optionId ? { optionId } : {}) })
      await payCheckout(data, {
        description: rfq.title,
        onPaid: (o) => router.push(o.kind === 'order' ? `/app/orders/${o.orderId}?first=1` : '/app/orders?processing=1'),
        onDismiss: () => { setAccepting(null); setError(tc('payment_cancelled')) },
      })
      // The sheet is open (or we are navigating) — the confirm has done its job.
      setConfirming(null)
    } catch (e: unknown) {
      // ADR 027 — an expired session is never resumed: the next tap starts a fresh one.
      if (isCheckoutExpired(e)) quoteKeys.current.delete(keyName)
      setConfirmErr(tc(checkoutErrorKey(e, CHECKOUT_ERROR_KEYS, 'failed') as 'failed'))
      setAccepting(null)
    }
  }

  const decided = rfq.status === 'accepted'
  const statusOf = (q: QuoteForBuyer) => (localDeclined[q.id] ? 'declined' : q.status)
  const reasonOf = (q: QuoteForBuyer) => localDeclined[q.id] ?? q.declineReason
  const flagsOf = (q: QuoteForBuyer): CompareFlag[] => choiceOf(q)?.flags ?? resultById.get(q.id)?.flags ?? []
  const totalOf = (q: QuoteForBuyer) => choiceOf(q)?.normalizedTotalPaise ?? resultById.get(q.id)?.normalizedTotalPaise ?? q.pricePaise
  const daysOf = (q: QuoteForBuyer) => choiceOf(q)?.deliveryDays ?? q.deliveryDays
  const pricePaiseOf = (q: QuoteForBuyer) => choiceOf(q)?.pricePaise ?? q.pricePaise
  // E12b — Economy · Standard · Express, picked per quote (the figures are the server's).
  const OptionChips = ({ q }: { q: QuoteForBuyer }) => {
    const cs = choices?.byQuote[q.id]
    if (!cs || cs.length < 2) return <span className="text-xs text-foreground-secondary">{t('cmp3_option_standard_only')}</span>
    const current = picked[q.id] ?? null
    return (
      <div className="flex flex-wrap gap-1" role="group" aria-label={t('cmp3_options')} data-testid="quote-options">
        {cs.map((c) => (
          <button
            key={c.label}
            type="button"
            aria-pressed={current === c.optionId}
            data-option={c.label}
            onClick={() => {
              setPicked((p) => ({ ...p, [q.id]: c.optionId }))
              posthog.capture('quote_option_selected', { device: 'web', label: c.label })
            }}
            className={`rounded-chip border px-2 py-0.5 text-[11px] font-medium ${current === c.optionId ? 'border-primary bg-primary/10 text-primary' : 'border-border text-foreground-secondary'}`}
          >
            {t(`cmp3_option_${c.label}`)} · {t('delivery_days', { days: c.deliveryDays })}
          </button>
        ))}
      </div>
    )
  }
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
            <Button size="sm" onClick={() => askAccept(q)} loading={accepting === q.id} disabled={accepting != null && accepting !== q.id} title={goods && q.goods ? t('goods_accept_note', { qty: q.goods.qty, unit: specUnit, total: formatINRExact(q.goods.totalInclGstPaise) }) : undefined}>
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
  const price = (q: QuoteForBuyer) => (goods && q.goods ? `${formatINRExact(q.goods.unitPricePaise)} ${t('goods_per_unit', { unit: specUnit })}` : formatINR(pricePaiseOf(q)))
  // S1.3 — "rev N" beside the price once revised; the popover lists quote_events.revised (before → after).
  const RevChip = ({ q }: { q: QuoteForBuyer }) => {
    if (q.revision <= 1) return null
    return (
      <details className="relative inline-block align-middle">
        <summary className="cursor-pointer list-none rounded-chip border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning" title={t('revise_history_title')}>
          {t('revise_chip', { n: q.revision })}
        </summary>
        <div className="absolute left-0 z-20 mt-1 w-64 rounded-button border border-border bg-surface p-2 text-left text-[11px] shadow-card">
          <p className="font-semibold">{t('revise_history_title')}</p>
          <ul className="mt-1 space-y-0.5 text-foreground-secondary">
            {q.revisions.map((r) => (
              <li key={r.revision}>{t('revise_history_row', { n: r.revision, from: formatINR(r.before.pricePaise), to: formatINR(r.after.pricePaise), daysFrom: r.before.deliveryDays, daysTo: r.after.deliveryDays })}</li>
            ))}
          </ul>
        </div>
      </details>
    )
  }
  const yesNoUnstated = (v: boolean | null) => (v == null ? t('term_not_stated') : v ? t('term_yes') : t('term_no'))
  const dateOrUnstated = (iso: string | null) => (iso ? new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`)) : t('term_not_stated'))

  const rows: { key: string; label: string; cell: (q: QuoteForBuyer) => React.ReactNode }[] = [
    { key: 'provider', label: t('compare_table_provider'), cell: (q) => <Provider q={q} /> },
    { key: 'price', label: t('compare_table_price'), cell: (q) => <span className="inline-flex flex-wrap items-center gap-1.5"><span className="font-display text-base font-bold text-primary tabular-nums">{price(q)}</span><RevChip q={q} /></span> },
    { key: 'total', label: t('compare_normalized'), cell: (q) => <span className="tabular-nums font-semibold" title={notesOf(q).length ? `${t('compare_normalized_why')}: ${notesOf(q).map(noteText).join('; ')}` : t('compare_normalized_why_none')}>{formatINRExact(totalOf(q))}{notesOf(q).length > 0 && <span className="ml-1 text-[11px] font-normal text-foreground-secondary" aria-hidden>ⓘ</span>}</span> },
    ...(choices ? [{ key: 'options', label: t('cmp3_options'), cell: (q: QuoteForBuyer) => <OptionChips q={q} /> }] : []),
    { key: 'delivery', label: t('compare_delivery'), cell: (q) => <span>{t('delivery_days', { days: daysOf(q) })}</span> },
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

  // ── E7 v3: the same cells, grouped (FR-7.1) ──────────────────────────────────
  const has = (q: QuoteForBuyer, f: CompareFlag) => flagsOf(q).includes(f)
  const Tag = ({ tone, children }: { tone: 'fact' | 'attention'; children: React.ReactNode }) => (
    <span className={`ml-1.5 inline-block rounded-chip px-1.5 py-0.5 align-middle text-[10px] font-medium ${tone === 'fact' ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning'}`}>{children}</span>
  )
  const gstCell = (q: QuoteForBuyer) => {
    if (goods && q.goods) return <span>{q.goods.gstRateBps / 100}%</span>
    if (q.gstIncluded === true) return <span>{t('cmp3_gst_included')}</span>
    if (q.gstIncluded === false) return <span>{t('cmp3_gst_extra', { pct: DEFAULT_GST_BPS / 100 })}</span>
    return <span className="text-warning" title={t('flag_gst_unstated_meaning')}>{t('cmp3_gst_unstated')} <span aria-hidden>⚠</span></span>
  }
  const Scope = ({ q }: { q: QuoteForBuyer }) => (
    q.scope.length > 140 ? (
      <details className="text-xs">
        <summary className="cursor-pointer list-none"><span className={density === 'compact' ? 'line-clamp-3 whitespace-pre-wrap' : 'whitespace-pre-wrap'}>{q.scope}</span><span className="mt-0.5 block text-[11px] font-medium text-primary">{t('cmp3_scope_more')}</span></summary>
        <p className="mt-1 whitespace-pre-wrap">{q.scope}</p>
      </details>
    ) : <p className="whitespace-pre-wrap text-xs">{q.scope}</p>
  )
  const ratingCell = (q: QuoteForBuyer) => (q.provider.avgRating > 0
    ? <span className="inline-flex items-center gap-0.5 tabular-nums"><Star className="h-3 w-3 fill-accent text-accent" aria-hidden />{q.provider.avgRating.toFixed(1)} ({q.provider.reviewCount})</span>
    : <span>{t('new_label')}</span>)
  type V3Row = { key: string; label: string; cell: (q: QuoteForBuyer) => React.ReactNode }
  const v3Groups: { key: string; label: string; rows: V3Row[] }[] = [
    {
      key: 'price', label: t('cmp3_group_price'), rows: [
        ...(choices ? [{ key: 'options', label: t('cmp3_options'), cell: (q: QuoteForBuyer) => <OptionChips q={q} /> }] : []),
        { key: 'as_quoted', label: t('compare_table_price'), cell: (q) => <span className="inline-flex flex-wrap items-center gap-1.5"><span className="font-display text-base font-bold text-primary tabular-nums">{price(q)}</span><RevChip q={q} /></span> },
        { key: 'gst', label: t('term_gst'), cell: gstCell },
        ...(goods ? [{ key: 'goods', label: t('goods_col_incl'), cell: (q: QuoteForBuyer) => (q.goods ? <span className="text-xs tabular-nums">{q.goods.qty} {specUnit}{specQty && q.goods.qty !== specQty ? ' *' : ''} · {formatINRExact(q.goods.totalInclGstPaise)} · {t('goods_col_after_itc')} {formatINRExact(q.goods.afterItcPaise)}</span> : null) }] : []),
        { key: 'total', label: t('compare_normalized'), cell: (q) => <span className="font-semibold tabular-nums" title={notesOf(q).length ? `${t('compare_normalized_why')}: ${notesOf(q).map(noteText).join('; ')}` : t('compare_normalized_why_none')}>{formatINRExact(totalOf(q))}{notesOf(q).length > 0 && <span className="ml-1 text-[11px] font-normal text-foreground-secondary" aria-hidden>ⓘ</span>}{has(q, 'cheapest_after_normalization') && <Tag tone="fact">{t('cmp3_lowest')}</Tag>}</span> },
      ],
    },
    {
      key: 'time', label: t('cmp3_group_time'), rows: [
        { key: 'delivery', label: t('compare_delivery'), cell: (q) => <span>{t('delivery_days', { days: daysOf(q) })}{has(q, 'fastest') && <Tag tone="fact">{t('cmp3_fastest')}</Tag>}</span> },
        { key: 'valid', label: t('term_valid_until'), cell: (q) => <span>{dateOrUnstated(q.validUntil)}{has(q, 'validity_short') && <Tag tone="attention">{t('cmp3_soon')}</Tag>}{has(q, 'validity_expired') && <Tag tone="attention">{t('flag_validity_expired_label')}</Tag>}</span> },
      ],
    },
    {
      key: 'terms', label: t('cmp3_group_terms'), rows: [
        { key: 'advance', label: t('term_advance'), cell: (q) => <span>{q.advancePercent == null ? t('term_not_stated') : t('term_advance_value', { pct: q.advancePercent })}{has(q, 'advance_high') && <Tag tone="attention">{t('cmp3_high')}</Tag>}</span> },
        { key: 'transport', label: t('term_transport'), cell: (q) => <span>{yesNoUnstated(q.transportIncluded)}</span> },
        { key: 'scope', label: t('cmp3_scope'), cell: (q) => <Scope q={q} /> },
      ],
    },
    {
      key: 'provider', label: t('cmp3_group_provider'), rows: [
        { key: 'rating', label: t('cmp3_rating'), cell: ratingCell },
        { key: 'orders', label: t('compare_completed_orders'), cell: (q) => <span className="tabular-nums">{q.provider.completedOrders}</span> },
        { key: 'response', label: t('compare_responds'), cell: (q) => <span>{formatResponseTime(q.provider.medianResponseMinutes) ?? '—'}</span> },
      ],
    },
    {
      key: 'flags', label: t('compare_flags'), rows: [
        { key: 'flags', label: t('compare_flags'), cell: (q) => <Chips q={q} /> },
        ...(pointersEnabled && rfq.quotes.length >= 2 ? [{ key: 'pointers', label: t('compare_pointers'), cell: (q: QuoteForBuyer) => <Pointers q={q} /> }] : []),
      ],
    },
  ]
  const pad = density === 'compact' ? 'px-3 py-1.5' : 'px-3 py-3'
  const cellTone = (q: QuoteForBuyer) => `${statusOf(q) === 'declined' ? 'opacity-60' : ''} ${statusOf(q) === 'accepted' ? 'bg-success-soft/40' : ''}`
  const shortlistOnlyToggle = (
    <label className="flex items-center gap-1.5">
      <input type="checkbox" checked={shortlistOnly} onChange={(e) => setShortlistOnly(e.target.checked)} disabled={shortlist.size === 0} />
      {t('compare_shortlisted_only')} ({shortlist.size})
    </label>
  )
  const sortOptions = [
    ...(reliability ? [{ value: 'reliability' as const, label: t('cmp3_sort_reliability') }] : []),
    { value: 'price' as const, label: t('cmp3_sort_total') },
    { value: 'delivery' as const, label: t('sort_delivery') },
    { value: 'rating' as const, label: t('sort_rating') },
    { value: 'response' as const, label: t('cmp3_sort_response') },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('compare_title')}</h2>
        {v3 ? (
          <div className="flex w-full flex-wrap items-center gap-3 text-xs text-foreground-secondary md:w-auto" data-testid="compare-v3-controls">
            {shortlistOnlyToggle}
            <span id="cmp3-sort-label">{t('sort_label')}</span>
            <SegmentedControl size="sm" ariaLabelledBy="cmp3-sort-label" value={sort} onChange={setSort} options={sortOptions} className="w-full md:w-auto" />
            <SegmentedControl
              size="sm"
              ariaLabel={t('cmp3_density_label')}
              value={density}
              onChange={setDensity}
              options={[{ value: 'compact', label: t('cmp3_density_compact') }, { value: 'comfortable', label: t('cmp3_density_comfortable') }]}
              className="hidden md:grid"
            />
          </div>
        ) : (
        <div className="flex flex-wrap items-center gap-3 text-xs text-foreground-secondary">
          {shortlistOnlyToggle}
          <label className="flex items-center gap-2">
            {t('sort_label')}
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="rounded-button border border-border bg-surface px-2 py-1 text-foreground">
              {reliability && <option value="reliability">{t('sort_reliability')}</option>}
              <option value="price">{t('sort_price')}</option>
              <option value="delivery">{t('sort_delivery')}</option>
              <option value="rating">{t('sort_rating')}</option>
              <option value="response">{t('sort_response')}</option>
            </select>
          </label>
        </div>
        )}
      </div>

      {/* S3.2 — the fair price range above the table (the same line the matched providers see); nothing when there is none */}
      {benchmark && <BenchmarkLine view={benchmark} role="buyer" />}
      {/* E12b — the lowest and fastest across every option of every quote (server-computed). */}
      {choices && (choices.lowest || choices.fastest) && (() => {
        const name = (ref: { quoteId: string; optionId: string | null }) => {
          const c = choices.byQuote[ref.quoteId]?.find((x) => x.optionId === ref.optionId)
          return c ? { who: t('compare_quote_label', { label: labelById.get(ref.quoteId) ?? '' }), c } : null
        }
        const lo = choices.lowest ? name(choices.lowest) : null
        const fa = choices.fastest ? name(choices.fastest) : null
        return (
          <p className="text-xs text-foreground-secondary" data-testid="option-extremes">
            {lo && t('cmp3_options_lowest', { who: lo.who, option: t(`cmp3_option_${lo.c.label}`), total: formatINRExact(lo.c.normalizedTotalPaise) })}
            {lo && fa && ' · '}
            {fa && t('cmp3_options_fastest', { who: fa.who, option: t(`cmp3_option_${fa.c.label}`), days: fa.c.deliveryDays })}
          </p>
        )
      })()}

      {/* S2.4 — one fixed line, never a number; price is one tap away */}
      {sort === 'reliability' && (
        <p className="text-xs text-foreground-secondary" data-testid="reliability-line">
          {t('reliability_line')}{' '}
          <button type="button" onClick={() => setSort('price')} className="text-primary underline underline-offset-2">{t('reliability_switch')}</button>
        </p>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
      {pointersEnabled && pointersState === 'unavailable' && <p className="text-xs text-foreground-secondary">{t('compare_pointers_unavailable')}</p>}

      {v3 ? (
        <>
          {/* E7 ≥ md: grouped rows, sticky quote header + label column, scroll inside the container only; scope on desktop. */}
          <div className="hidden max-h-[75vh] overflow-auto rounded-card border border-border bg-surface shadow-card md:block" data-testid="compare-v3-table">
            <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
              <caption className="sr-only">{t('compare_title')}</caption>
              <thead>
                <tr>
                  <th scope="col" className="sticky left-0 top-0 z-30 w-40 border-b border-border bg-surface"><span className="sr-only">{t('cmp3_row_col')}</span></th>
                  {quotes.map((q) => (
                    <th key={q.id} scope="col" className={`sticky top-0 z-20 min-w-[14rem] max-w-xs border-b border-border bg-surface px-3 py-2 text-left align-bottom font-normal ${statusOf(q) === 'declined' ? 'opacity-60' : ''}`}>
                      <Provider q={q} />
                    </th>
                  ))}
                </tr>
              </thead>
              {v3Groups.map((g) => (
                <tbody key={g.key} data-group={g.key}>
                  <tr>
                    <th colSpan={quotes.length + 1} scope="colgroup" className="bg-muted/60 px-3 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-foreground-secondary"><span className="sticky left-3">{g.label}</span></th>
                  </tr>
                  {g.rows.map((row) => (
                    <tr key={row.key} className="align-top" data-row={row.key}>
                      <th scope="row" className={`sticky left-0 z-10 w-40 border-b border-border bg-surface text-left text-xs font-normal text-foreground-secondary ${pad}`}>{row.label}</th>
                      {quotes.map((q) => (
                        <td key={q.id} className={`min-w-[14rem] max-w-xs border-b border-border ${pad} ${cellTone(q)}`}>{row.cell(q)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              ))}
              <tbody>
                <tr className="align-top">
                  <th scope="row" className={`sticky left-0 z-10 w-40 bg-surface text-left text-[11px] font-semibold uppercase tracking-wide text-foreground-secondary ${pad}`}>{t('compare_actions')}</th>
                  {quotes.map((q) => (
                    <td key={q.id} className={`min-w-[14rem] max-w-xs ${pad} ${cellTone(q)}`}><Actions q={q} /></td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          {/* E7 < md: cards with the same groups. */}
          <ul className="space-y-3 md:hidden" data-testid="compare-v3-cards">
            {quotes.map((q) => (
              <li key={q.id} className={`rounded-card border bg-surface p-4 shadow-card ${statusOf(q) === 'accepted' ? 'border-success' : statusOf(q) === 'declined' ? 'border-border opacity-60' : 'border-border'}`}>
                <Provider q={q} />
                {v3Groups.filter((g) => g.key !== 'flags').map((g) => (
                  <section key={g.key} className="mt-3 border-t border-border pt-2" aria-label={g.label}>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-foreground-secondary">{g.label}</h3>
                    {g.key === 'terms' ? (
                      <div className="mt-1.5 space-y-2">
                        <QuoteTermsRow terms={q} compact />
                        <Scope q={q} />
                      </div>
                    ) : (
                      <dl className="mt-1 space-y-1">
                        {g.rows.map((row) => (
                          <div key={row.key} className="flex items-start justify-between gap-3 text-sm">
                            <dt className="text-xs text-foreground-secondary">{row.label}</dt>
                            <dd className="text-right">{row.cell(q)}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </section>
                ))}
                <div className="mt-3 border-t border-border pt-2"><Chips q={q} /></div>
                <div className="mt-2"><Pointers q={q} /></div>
                <div className="mt-3"><Actions q={q} /></div>
                {threadFor === q.id && <MessageThread quote={q} />}
              </li>
            ))}
          </ul>
        </>
      ) : (
      <>
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
                <p className="flex flex-wrap items-center justify-end gap-1.5 font-display text-lg font-bold text-primary tabular-nums">{price(q)}<RevChip q={q} /></p>
                <p className="text-xs text-foreground-secondary">{t('compare_normalized')}: <span className="font-semibold text-foreground">{formatINRExact(totalOf(q))}</span></p>
                <p className="text-xs text-foreground-secondary">{t('delivery_days', { days: daysOf(q) })}{formatResponseTime(q.provider.medianResponseMinutes) ? ` · ${t('responds_in', { time: formatResponseTime(q.provider.medianResponseMinutes) as string })}` : ''}</p>
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
      </>
      )}

      {/* Thread panel for the table view (cards render it inline). */}
      {threadFor && quotes.some((q) => q.id === threadFor) && (
        <div className="hidden md:block">
          <MessageThread quote={quotes.find((q) => q.id === threadFor)!} />
        </div>
      )}

      <ConfirmSheet
        open={confirming != null}
        title={t('accept_confirm_title')}
        confirmLabel={t('accept_confirm_submit')}
        cancelLabel={t('accept_confirm_cancel')}
        busy={confirming != null && accepting === confirming.id}
        error={confirmErr || null}
        onClose={closeConfirm}
        onConfirm={() => (confirming ? accept(confirming) : undefined)}
      >
        {confirming && (() => {
          const q = confirming
          const others = rfq.quotes.filter((o) => o.id !== q.id && statusOf(o) === 'submitted').length
          return (
            <div className="space-y-3 text-sm">
              <dl className="space-y-1.5 rounded-button border border-border bg-muted/40 p-3">
                <div className="flex justify-between gap-3"><dt className="text-foreground-secondary">{t('accept_confirm_provider')}</dt><dd className="text-right font-medium">{q.provider.displayName}</dd></div>
                {goods && q.goods ? (
                  <div className="flex justify-between gap-3">
                    <dt className="text-foreground-secondary">{t('accept_confirm_total_goods', { qty: q.goods.qty, unit: specUnit })}</dt>
                    <dd className="text-right font-display text-base font-bold text-primary tabular-nums">{formatINRExact(q.goods.totalInclGstPaise)}</dd>
                  </div>
                ) : (
                  <div className="flex justify-between gap-3">
                    <dt className="text-foreground-secondary">{t(q.gstIncluded === true ? 'accept_confirm_price_incl_gst' : 'accept_confirm_price')}</dt>
                    <dd className="text-right font-display text-base font-bold text-primary tabular-nums">{formatINRExact(pricePaiseOf(q))}</dd>
                  </div>
                )}
                {choiceOf(q) && <div className="flex justify-between gap-3"><dt className="text-foreground-secondary">{t('cmp3_options')}</dt><dd className="text-right font-medium">{t(`cmp3_option_${choiceOf(q)!.label}`)}</dd></div>}
                <div className="flex justify-between gap-3"><dt className="text-foreground-secondary">{t('compare_delivery')}</dt><dd className="text-right">{t('delivery_days', { days: daysOf(q) })}</dd></div>
              </dl>
              {!(goods && q.goods) && <p className="text-xs text-foreground-secondary">{t(q.gstIncluded === true ? 'accept_confirm_gst_included_note' : 'accept_confirm_gst_note')}</p>}
              <p className="flex items-start gap-1.5 text-foreground"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-trust" aria-hidden />{t('accept_confirm_escrow')}</p>
              {others > 0 && <p className="text-foreground-secondary">{t('accept_confirm_others', { count: others })}</p>}
            </div>
          )
        })()}
      </ConfirmSheet>

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
