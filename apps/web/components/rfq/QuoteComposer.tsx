'use client'

import { useCallback, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { GST_RATE_BPS_OPTIONS, type QuoteExtractField, type QuoteExtractResponse } from '@amclub/shared'
import { VoiceDictation } from '@/components/mart/VoiceDictation'
import { useAnalytics } from '@/components/providers/posthog'

type Tri = '' | 'yes' | 'no'

/** AMC Mart M2 — goods RFQ context for the seller's composer. */
export interface QuoteComposerGoods {
  unit: string
  qty: number
  /** The seller's own active listings in the RFQ's category (prefill HSN/GST; links the order line). */
  listings: { id: string; name: string; hsnCode: string; gstRateBps: number }[]
}

/**
 * Provider quote form. S1.1 adds "Type or speak your quote" above it when
 * `extractEnabled` (AGENT_ENABLED + agents_enabled.quote_extract + cohort,
 * computed server-side): the model prefills the SAME fields, uncertain ones get
 * an amber ring + hint, and the provider's Submit sends `extraction_id` so the
 * confirmation lands in ai_decisions. With the prop false the form renders
 * exactly as before. No client money arithmetic beyond rupees↔paise display.
 */
export function QuoteComposer({ rfqId, goods, extractEnabled = false }: { rfqId: string; goods?: QuoteComposerGoods | undefined; extractEnabled?: boolean }) {
  const t = useTranslations('rfq')
  const router = useRouter()
  const posthog = useAnalytics()
  const [price, setPrice] = useState('')
  // Goods terms: unit price (rupees typed → paise integer), GST slab, HSN, optional listing, qty.
  const [unitPrice, setUnitPrice] = useState('')
  const [gstBps, setGstBps] = useState('')
  const [hsn, setHsn] = useState('')
  const [listingId, setListingId] = useState('')
  const [gQty, setGQty] = useState(goods ? String(goods.qty) : '')
  const [days, setDays] = useState('')
  const [scope, setScope] = useState('')
  const [message, setMessage] = useState('')
  // Phase 4b — optional commercial terms. Untouched = not sent = NULL ("not stated").
  const [gst, setGst] = useState<Tri>('')
  const [transport, setTransport] = useState<Tri>('')
  const [validUntil, setValidUntil] = useState('')
  const [advance, setAdvance] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // S1.1 — extraction state.
  const [draft, setDraft] = useState('')
  const [draftSource, setDraftSource] = useState<'typed' | 'voice'>('typed')
  const [extracting, setExtracting] = useState(false)
  const [extractionId, setExtractionId] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState<Set<QuoteExtractField>>(new Set())
  const [stubPreview, setStubPreview] = useState(false)
  const [extractMsg, setExtractMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  /** A hand edit after a fill clears that field's "please check" ring (the edit itself is captured in edited_fields). */
  const settle = useCallback((field: QuoteExtractField) => {
    setUncertain((prev) => {
      if (!prev.has(field)) return prev
      const next = new Set(prev)
      next.delete(field)
      return next
    })
  }, [])

  const appendDictation = useCallback((text: string) => {
    setDraft((d) => (d.trim() ? `${d.trim()} ${text}` : text))
    setDraftSource('voice')
  }, [])

  async function fill() {
    setExtractMsg(null)
    const text = draft.trim()
    if (text.length < 5) { setExtractMsg({ kind: 'err', text: t('quote_extract_err_short') }); return }
    setExtracting(true)
    try {
      const res = await fetch(`/api/v1/rfq/${rfqId}/quote/extract`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source: draftSource }),
      })
      const d = (await res.json().catch(() => ({}))) as Partial<QuoteExtractResponse> & { error?: string }
      if (!res.ok) {
        const msg = d.error === 'budget_exceeded' ? t('quote_extract_err_budget')
          : d.error === 'extract_unavailable' ? t('quote_extract_err_unavailable')
          : res.status === 429 ? t('quote_extract_err_rate')
          : t('quote_extract_err_unavailable')
        setExtractMsg({ kind: 'err', text: msg })
        return
      }
      const f = d.fields!
      let touched = 0
      if (goods) {
        if (f.unit_price_paise != null) { setUnitPrice(String(f.unit_price_paise / 100)); touched++ }
        if (f.gst_rate_bps != null) { setGstBps(String(f.gst_rate_bps)); touched++ }
        if (f.hsn_code != null) { setHsn(f.hsn_code); touched++ }
      } else if (f.price_paise != null) { setPrice(String(f.price_paise / 100)); touched++ }
      if (f.delivery_days != null) { setDays(String(f.delivery_days)); touched++ }
      if (f.gst_included != null) { setGst(f.gst_included ? 'yes' : 'no'); touched++ }
      if (f.transport_included != null) { setTransport(f.transport_included ? 'yes' : 'no'); touched++ }
      if (f.valid_until != null) { setValidUntil(f.valid_until); touched++ }
      if (f.advance_percent != null) { setAdvance(String(f.advance_percent)); touched++ }
      if (!scope.trim() && f.scope_summary.trim()) { setScope(f.scope_summary.trim()); touched++ }
      setUncertain(new Set(f.uncertain_fields))
      setExtractionId(d.extraction_id ?? null)
      setStubPreview(!!d.stub)
      setExtractMsg({ kind: 'ok', text: touched > 0 ? t('quote_extract_filled') : t('quote_extract_nothing') })
      posthog.capture('quote_extract_filled', { rfq_id: rfqId, uncertain_count: f.uncertain_fields.length, stub: !!d.stub, role: 'provider' })
    } catch {
      setExtractMsg({ kind: 'err', text: t('quote_extract_err_unavailable') })
    } finally {
      setExtracting(false)
    }
  }

  function clearSuggestion() {
    setExtractionId(null)
    setUncertain(new Set())
    setStubPreview(false)
    setExtractMsg(null)
    posthog.capture('quote_extract_cleared', { rfq_id: rfqId, role: 'provider' })
  }

  async function submit() {
    setError('')
    const deliveryDays = Number(days)
    let pricePaise = Math.round(Number(price) * 100)
    let goodsTerms: { unit_price_paise: number; gst_rate_bps: number; hsn_code: string; product_id?: string; qty?: number } | null = null
    if (goods) {
      const unitPaise = Math.round(Number(unitPrice) * 100)
      const qtyNum = Number(gQty)
      if (!unitPaise || unitPaise <= 0 || gstBps === '' || !/^\d{4}(?:\d{2})?(?:\d{2})?$/.test(hsn.trim())) { setError(t('goods_err_terms')); return }
      if (!Number.isInteger(qtyNum) || qtyNum <= 0) { setError(t('goods_quote_qty') + ': ' + t('required_field')); return }
      goodsTerms = { unit_price_paise: unitPaise, gst_rate_bps: Number(gstBps), hsn_code: hsn.trim(), ...(listingId ? { product_id: listingId } : {}), ...(qtyNum !== goods.qty ? { qty: qtyNum } : {}) }
      // Client-side placeholder only — the server recomputes price_paise = qty × unit price.
      pricePaise = unitPaise * qtyNum
    }
    if (!pricePaise || pricePaise <= 0) { setError(t('quote_price_label') + ': ' + t('required_field')); return }
    if (!deliveryDays || deliveryDays <= 0) { setError(t('quote_delivery_label') + ': ' + t('required_field')); return }
    if (scope.trim().length < 20) { setError(t('quote_scope_label') + ': ' + t('required_field')); return }
    const advanceNum = advance.trim() === '' ? undefined : Number(advance)
    if (advanceNum !== undefined && (!Number.isInteger(advanceNum) || advanceNum < 0 || advanceNum > 100)) { setError(t('term_advance') + ': 0–100'); return }
    setLoading(true)
    try {
      const res = await fetch(`/api/v1/rfq/${rfqId}/quote`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          price_paise: pricePaise,
          delivery_days: deliveryDays,
          scope: scope.trim(),
          ...(message.trim() ? { message: message.trim() } : {}),
          ...(gst ? { gst_included: gst === 'yes' } : {}),
          ...(transport ? { transport_included: transport === 'yes' } : {}),
          ...(validUntil ? { valid_until: validUntil } : {}),
          ...(advanceNum !== undefined ? { advance_percent: advanceNum } : {}),
          ...(goodsTerms ? { goods: goodsTerms } : {}),
          ...(extractionId ? { extraction_id: extractionId } : {}),
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (d.error === 'already_quoted') throw new Error(t('already_quoted'))
        if (d.error === 'rfq_closed') throw new Error(t('rfq_closed'))
        throw new Error(t('err_quote'))
      }
      router.refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('err_quote'))
    } finally {
      setLoading(false)
    }
  }

  const ring = (field: QuoteExtractField) => (uncertain.has(field) ? 'ring-2 ring-warning ring-offset-1' : '')
  const hint = (field: QuoteExtractField) =>
    uncertain.has(field) ? <p className="text-[11px] font-medium text-warning" role="status">{t('quote_extract_uncertain_hint')}</p> : null

  const triSelect = (id: string, label: string, value: Tri, onChange: (v: Tri) => void, field: QuoteExtractField) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value}
        onChange={(e) => { onChange(e.target.value as Tri); settle(field) }}
        className={`h-10 rounded-button border border-border bg-surface px-3 text-sm text-foreground ${ring(field)}`}
      >
        <option value="">{t('term_not_stated_option')}</option>
        <option value="yes">{t('term_yes')}</option>
        <option value="no">{t('term_no')}</option>
      </select>
      {hint(field)}
    </div>
  )

  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card space-y-4">
      <h2 className="text-sm font-semibold">{t('quote_title')}</h2>

      {/* S1.1 — Type or speak your quote (only for an enabled, cohorted provider). */}
      {extractEnabled && (
        <div className="space-y-3 rounded-card border border-primary/30 bg-primary/5 p-4" data-testid="quote-extract-card">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">{t('quote_extract_title')}</p>
              <p className="text-xs text-foreground-secondary">{t('quote_extract_subtitle')}</p>
            </div>
            {stubPreview && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground-secondary">{t('quote_extract_stub_pill')}</span>}
          </div>
          <Textarea
            id="q-extract-text"
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setDraftSource('typed') }}
            placeholder={t('quote_extract_placeholder')}
            rows={3}
            maxLength={4000}
            aria-label={t('quote_extract_title')}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={fill} loading={extracting} disabled={extracting || draft.trim().length < 5}>
              {extracting ? t('quote_extract_filling') : t('quote_extract_fill')}
            </Button>
            <span className="text-xs text-foreground-secondary">{t('quote_extract_dictate_hint')}</span>
            <VoiceDictation onText={appendDictation} surface="quote_composer" />
            {extractionId && (
              <button type="button" onClick={clearSuggestion} className="text-xs font-medium text-foreground-secondary underline underline-offset-2">
                {t('quote_extract_clear')}
              </button>
            )}
          </div>
          {extractMsg && (
            <p className={`text-xs ${extractMsg.kind === 'ok' ? 'text-emerald' : 'text-danger'}`} role="status" aria-live="polite">{extractMsg.text}</p>
          )}
        </div>
      )}

      {goods ? (
        <>
          {/* AMC Mart M2 — goods terms. Unit price excl. GST; the server computes the total. */}
          <p className="text-xs text-foreground-secondary">{t('goods_quote_intro', { qty: goods.qty, unit: goods.unit })}</p>
          {goods.listings.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="q-listing">{t('goods_quote_listing')}</Label>
              <select
                id="q-listing"
                value={listingId}
                onChange={(e) => {
                  const id = e.target.value
                  setListingId(id)
                  const l = goods.listings.find((x) => x.id === id)
                  if (l) { setHsn(l.hsnCode); setGstBps(String(l.gstRateBps)); settle('hsn_code'); settle('gst_rate_bps') }
                }}
                className="h-10 rounded-button border border-border bg-surface px-3 text-sm text-foreground"
              >
                <option value="">{t('goods_quote_listing_none')}</option>
                {goods.listings.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="q-unit-price">{t('goods_quote_unit_price', { unit: goods.unit })}</Label>
              <Input id="q-unit-price" type="number" inputMode="decimal" min={0} step="0.01" value={unitPrice} onChange={(e) => { setUnitPrice(e.target.value); settle('unit_price') }} className={ring('unit_price')} />
              {hint('unit_price')}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="q-gqty">{t('goods_quote_qty')}</Label>
              <Input id="q-gqty" type="number" inputMode="numeric" min={1} value={gQty} onChange={(e) => setGQty(e.target.value)} />
              {Number(gQty) !== goods.qty && <p className="text-[11px] text-foreground-secondary">{t('goods_quote_qty_hint', { qty: goods.qty })}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="q-gst-rate">{t('goods_quote_gst')}</Label>
              <select id="q-gst-rate" value={gstBps} onChange={(e) => { setGstBps(e.target.value); settle('gst_rate_bps') }} className={`h-10 rounded-button border border-border bg-surface px-3 text-sm text-foreground ${ring('gst_rate_bps')}`}>
                <option value="">—</option>
                {GST_RATE_BPS_OPTIONS.map((b) => <option key={b} value={b}>{b / 100}%</option>)}
              </select>
              {hint('gst_rate_bps')}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="q-hsn">{t('goods_quote_hsn')}</Label>
              <Input id="q-hsn" inputMode="numeric" maxLength={8} value={hsn} onChange={(e) => { setHsn(e.target.value.replace(/\D/g, '')); settle('hsn_code') }} className={ring('hsn_code')} />
              {hint('hsn_code')}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="q-days">{t('quote_delivery_label')}</Label>
              <Input id="q-days" type="number" inputMode="numeric" value={days} onChange={(e) => { setDays(e.target.value); settle('delivery_days') }} className={ring('delivery_days')} />
              {hint('delivery_days')}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="q-scope">{t('quote_scope_label')}</Label>
            <Textarea id="q-scope" value={scope} onChange={(e) => setScope(e.target.value)} placeholder={t('goods_quote_scope_placeholder')} rows={4} />
          </div>
        </>
      ) : (
        <>
          <div className="flex gap-3">
            <div className="flex-1 flex flex-col gap-1.5">
              <Label htmlFor="q-price">{t('quote_price_label')}</Label>
              <Input id="q-price" type="number" inputMode="numeric" value={price} onChange={(e) => { setPrice(e.target.value); settle('price') }} className={ring('price')} />
              {hint('price')}
            </div>
            <div className="flex-1 flex flex-col gap-1.5">
              <Label htmlFor="q-days">{t('quote_delivery_label')}</Label>
              <Input id="q-days" type="number" inputMode="numeric" value={days} onChange={(e) => { setDays(e.target.value); settle('delivery_days') }} className={ring('delivery_days')} />
              {hint('delivery_days')}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="q-scope">{t('quote_scope_label')}</Label>
            <Textarea id="q-scope" value={scope} onChange={(e) => setScope(e.target.value)} placeholder={t('quote_scope_placeholder')} rows={4} />
          </div>
        </>
      )}

      {/* Phase 4b — optional terms. Skipping them submits exactly as before. */}
      <details className="rounded-button border border-border bg-muted/30 p-3" open={uncertain.has('gst_included') || uncertain.has('transport_included') || uncertain.has('valid_until') || uncertain.has('advance_percent') || undefined}>
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          {t('terms_section')} <span className="text-xs font-normal text-foreground-secondary">· {t('terms_optional_note')}</span>
        </summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {triSelect('q-gst', t('term_gst_q'), gst, setGst, 'gst_included')}
          {triSelect('q-transport', t('term_transport_q'), transport, setTransport, 'transport_included')}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="q-valid">{t('term_valid_until')}</Label>
            <Input id="q-valid" type="date" value={validUntil} onChange={(e) => { setValidUntil(e.target.value); settle('valid_until') }} className={ring('valid_until')} />
            {hint('valid_until')}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="q-advance">{t('term_advance')}</Label>
            <Input id="q-advance" type="number" inputMode="numeric" min={0} max={100} placeholder="0–100" value={advance} onChange={(e) => { setAdvance(e.target.value); settle('advance_percent') }} className={ring('advance_percent')} />
            {hint('advance_percent')}
          </div>
        </div>
        <p className="mt-2 text-xs text-foreground-secondary">{t('terms_help')}</p>
      </details>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="q-msg">{t('quote_message_label')}</Label>
        <Textarea id="q-msg" value={message} onChange={(e) => setMessage(e.target.value)} rows={2} />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button onClick={submit} loading={loading} className="w-full">{loading ? t('submitting_quote') : t('submit_quote')}</Button>
    </div>
  )
}
