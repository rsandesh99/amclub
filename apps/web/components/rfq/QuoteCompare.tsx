'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { Link } from '@/i18n/navigation'
import { MessageSquare, Star, ShieldCheck } from 'lucide-react'
import type { RfqDetailForBuyer, QuoteForBuyer } from '@/lib/rfq/queries'
import { formatINR, formatINRExact } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { QuoteTermsRow } from './QuoteTermsRow'

type Sort = 'price' | 'delivery' | 'rating'

export function QuoteCompare({ rfq }: { rfq: RfqDetailForBuyer }) {
  const t = useTranslations('rfq')
  const router = useRouter()
  const [sort, setSort] = useState<Sort>('price')
  const [threadFor, setThreadFor] = useState<string | null>(null)
  const [accepting, setAccepting] = useState<string | null>(null)
  const [error, setError] = useState('')

  const goods = rfq.kind === 'goods'
  const specUnit = String(rfq.goodsSpec?.['unit'] ?? '')
  const specQty = Number(rfq.goodsSpec?.['qty'] ?? 0)
  const quotes = [...rfq.quotes].sort((a, b) => {
    // Goods: compare the unit price the seller quoted (qty may differ by MOQ).
    if (sort === 'price') return goods && a.goods && b.goods ? a.goods.unitPricePaise - b.goods.unitPricePaise : a.pricePaise - b.pricePaise
    if (sort === 'delivery') return a.deliveryDays - b.deliveryDays
    return b.provider.avgRating - a.provider.avgRating
  })

  // Expired with no accepted quote → rescue UI (§3.8).
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

  // No quotes yet → waiting state.
  if (quotes.length === 0) {
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
      const res = await fetch('/api/v1/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteId, idempotencyKey: crypto.randomUUID() }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : 'failed')
      if (d.simulated) {
        const sim = await fetch('/api/v1/checkout/simulate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ checkoutSessionId: d.checkoutSessionId }),
        })
        const sd = await sim.json()
        if (!sim.ok) throw new Error(sd.error ?? 'failed')
        router.push(`/app/orders/${sd.orderId}?first=1`)
        return
      }
      // Real Razorpay handled on the package checkout page; quotes use the same rail.
      router.push('/app/orders?processing=1')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'failed')
      setAccepting(null)
    }
  }

  const decided = rfq.status === 'accepted'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t('compare_title')}</h2>
        <label className="flex items-center gap-2 text-xs text-foreground-secondary">
          {t('sort_label')}
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="rounded-button border border-border bg-surface px-2 py-1 text-foreground">
            <option value="price">{t('sort_price')}</option>
            <option value="delivery">{t('sort_delivery')}</option>
            <option value="rating">{t('sort_rating')}</option>
          </select>
        </label>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <ul className="space-y-3">
        {quotes.map((q) => (
          <li key={q.id} className={`rounded-card border bg-surface p-4 shadow-card ${q.status === 'accepted' ? 'border-success' : q.status === 'declined' ? 'border-border opacity-60' : 'border-border'}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <Link href={`/p/${q.provider.slug}`} className="text-sm font-semibold hover:text-primary">{q.provider.displayName}</Link>
                <p className="mt-0.5 flex items-center gap-2 text-xs text-foreground-secondary">
                  {q.provider.avgRating > 0 ? <span className="inline-flex items-center gap-0.5"><Star className="h-3 w-3 fill-accent text-accent" />{q.provider.avgRating.toFixed(1)} ({q.provider.reviewCount})</span> : <span>{t('new_label')}</span>}
                  <span>· {t('delivery_days', { days: q.deliveryDays })}</span>
                </p>
              </div>
              <div className="text-right">
                {goods && q.goods ? (
                  <>
                    <p className="font-display text-lg font-bold text-primary tabular-nums">{formatINRExact(q.goods.unitPricePaise)} <span className="text-xs font-normal text-foreground-secondary">{t('goods_per_unit', { unit: specUnit })}</span></p>
                    <p className="text-xs text-foreground-secondary">{t('goods_col_after_itc')} {formatINRExact(q.goods.afterItcPaise)}</p>
                  </>
                ) : (
                  <p className="font-display text-lg font-bold text-primary">{formatINR(q.pricePaise)}</p>
                )}
              </div>
            </div>

            {/* AMC Mart M2 — goods quote: server-computed paise, rendered as a row. */}
            {goods && q.goods && (
              <div className="mt-3 overflow-x-auto rounded-button border border-border bg-muted/40">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-foreground-secondary">
                      <th className="px-3 py-1.5 font-medium">{t('goods_col_qty')}</th>
                      <th className="px-3 py-1.5 font-medium">{t('goods_col_unit_price')}</th>
                      <th className="px-3 py-1.5 font-medium">{t('goods_col_gst')}</th>
                      <th className="px-3 py-1.5 font-medium">{t('goods_col_incl')}</th>
                      <th className="px-3 py-1.5 font-medium text-success">{t('goods_col_after_itc')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="tabular-nums text-foreground">
                      <td className="px-3 py-1.5">{q.goods.qty} {specUnit}{specQty && q.goods.qty !== specQty ? ' *' : ''}</td>
                      <td className="px-3 py-1.5">{formatINRExact(q.goods.unitPricePaise)}</td>
                      <td className="px-3 py-1.5">{q.goods.gstRateBps / 100}% · {formatINRExact(q.goods.gstPaise)}</td>
                      <td className="px-3 py-1.5 font-semibold">{formatINRExact(q.goods.totalInclGstPaise)}</td>
                      <td className="px-3 py-1.5 font-semibold text-success">{formatINRExact(q.goods.afterItcPaise)}</td>
                    </tr>
                  </tbody>
                </table>
                <p className="px-3 pb-2 text-[11px] text-foreground-secondary">HSN {q.goods.hsnCode} · {t('goods_itc_hint')}</p>
              </div>
            )}

            <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{q.scope}</p>

            {/* Phase 4c — stated terms, with an explicit hint where the provider said nothing. */}
            <div className="mt-3 rounded-button border border-border bg-muted/40 p-3">
              <QuoteTermsRow terms={q} />
              {(q.gstIncluded == null || q.transportIncluded == null || q.validUntil == null || q.advancePercent == null) && (
                <p className="mt-2 text-xs text-foreground-secondary">{t('term_not_stated_hint')}</p>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {!decided && q.status === 'submitted' && (
                <Button onClick={() => accept(q.id)} loading={accepting === q.id} title={goods && q.goods ? t('goods_accept_note', { qty: q.goods.qty, unit: specUnit, total: formatINRExact(q.goods.totalInclGstPaise) }) : undefined}>
                  {accepting === q.id ? t('accepting') : t('accept_quote')}
                </Button>
              )}
              {q.status === 'accepted' && <span className="inline-flex items-center gap-1 text-xs font-medium text-success"><ShieldCheck className="h-3.5 w-3.5" />{t('status_accepted')}</span>}
              <Button variant="ghost" onClick={() => setThreadFor(threadFor === q.id ? null : q.id)}>
                <MessageSquare className="mr-1 h-4 w-4" />{t('message_label')}
              </Button>
            </div>

            {threadFor === q.id && <MessageThread quote={q} />}
          </li>
        ))}
      </ul>
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
      // Drain the body on every status — an unread response never finishes.
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
      const res = await fetch(`/api/v1/quotes/${quote.id}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: body.trim() }),
      })
      if (res.ok) {
        const m = await res.json()
        setMessages((prev) => [...prev, m])
        setBody('')
      }
    } finally { setSending(false) }
  }

  return (
    <div className="mt-3 rounded-button border border-border bg-muted/40 p-3">
      <p className="mb-2 flex items-center gap-1 text-xs text-foreground-secondary"><ShieldCheck className="h-3 w-3" />{t('masked_note')}</p>
      <div className="max-h-48 space-y-2 overflow-y-auto">
        {loaded && messages.length === 0 && <p className="text-xs text-foreground-secondary">{t('no_messages')}</p>}
        {messages.map((m) => (
          <div key={m.id} className={`max-w-[80%] rounded-card px-3 py-1.5 text-sm ${m.mine ? 'ml-auto bg-primary text-white' : 'bg-surface'}`}>
            {m.body}
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder={t('message_placeholder')} className="flex-1 rounded-button border border-border bg-surface px-3 py-1.5 text-sm focus:border-primary focus:outline-none" />
        <Button onClick={send} loading={sending}>{t('send')}</Button>
      </div>
    </div>
  )
}
