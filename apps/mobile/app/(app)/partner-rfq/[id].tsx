import { ScrollView, Text, View, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect, useCallback } from 'react'
import { useLocalSearchParams, router } from 'expo-router'
import { useI18n } from '@/lib/i18n'
import { fetchRfq, submitQuote, fetchMe, extractQuote, reviseQuote } from '@/lib/api'
import { ClarificationsBlock } from '@/components/ClarificationsBlock'
import { formatINR } from '@/lib/format'
import { GST_RATE_BPS_OPTIONS } from '@amclub/shared'
import { GoodsSpecBlock } from '@/components/GoodsSpecBlock'
import { BenchmarkBlock } from '@/components/BenchmarkBlock'
import { VoiceRfqRecorder } from '@/components/VoiceRfqRecorder'
import { confirmHaptic } from '@/lib/haptics'


type ExtractField = 'price' | 'unit_price' | 'delivery_days' | 'gst_included' | 'transport_included' | 'valid_until' | 'advance_percent' | 'gst_rate_bps' | 'hsn_code'
const AMBER = 'border-[#b45309]'

export default function ProviderRfqScreen() {
  const { t, locale } = useI18n()
  const { id } = useLocalSearchParams<{ id: string }>()
  const [rfq, setRfq] = useState<any>(null)
  // S3.2 — the fair price range (present only when the API sends one)
  const [benchmark, setBenchmark] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [price, setPrice] = useState('')
  const [days, setDays] = useState('')
  const [scope, setScope] = useState('')
  // Phase 4b — optional terms (null = not stated → not sent)
  const [gst, setGst] = useState<boolean | null>(null)
  const [transport, setTransport] = useState<boolean | null>(null)
  const [validUntil, setValidUntil] = useState('')
  const [advance, setAdvance] = useState('')
  // AMC Mart M2 — goods terms (unit price excl. GST; the server computes the total).
  const [unitPrice, setUnitPrice] = useState('')
  const [gstBps, setGstBps] = useState<number | null>(null)
  const [hsn, setHsn] = useState('')
  const [gQty, setGQty] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // S1.1 — "Type or speak your quote" (server-authoritative flag via /profile/me).
  const [extractEnabled, setExtractEnabled] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftSource, setDraftSource] = useState<'typed' | 'voice'>('typed')
  const [extracting, setExtracting] = useState(false)
  const [extractionId, setExtractionId] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState<Set<ExtractField>>(new Set())
  const [stubPreview, setStubPreview] = useState(false)
  const [extractMsg, setExtractMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // S1.3 — revising the submitted quote in place: the same form, prefilled; PATCH on submit.
  const [revising, setRevising] = useState(false)

  // S1.3 — computed at load time (not in render): active RFQ = open|quoted and inside its window.
  const [active, setActive] = useState(false)

  const load = useCallback(async () => {
    const [d, me] = await Promise.all([fetchRfq(id, locale), fetchMe()])
    setRfq(d?.rfq ?? null)
    setBenchmark(d?.benchmark ?? null)
    setActive(!!d?.rfq && (d.rfq.status === 'open' || d.rfq.status === 'quoted') && new Date(d.rfq.expiresAt).getTime() > Date.now())
    if (d?.rfq?.kind === 'goods' && d.rfq.goodsSpec?.qty) setGQty(String(d.rfq.goodsSpec.qty))
    setExtractEnabled(me?.quoteExtractEnabled === true)
    setLoading(false)
  }, [id, locale])
  // Deferred: keeps setState off the effect's synchronous path.
  useEffect(() => { void Promise.resolve().then(load) }, [load])

  const settle = (f: ExtractField) => setUncertain((prev) => { if (!prev.has(f)) return prev; const n = new Set(prev); n.delete(f); return n })
  const appendDictation = (text: string) => { const clean = text.trim(); if (!clean) return; setDraft((d) => (d.trim() ? `${d.trim()} ${clean}` : clean)); setDraftSource('voice') }

  async function fill() {
    setExtractMsg(null)
    const text = draft.trim()
    if (text.length < 5) { setExtractMsg({ ok: false, text: t('rfq.quote_extract_err_short') }); return }
    setExtracting(true)
    const res = await extractQuote(id, { text, source: draftSource })
    setExtracting(false)
    if (!res.ok) {
      const e = res.data?.error
      setExtractMsg({ ok: false, text: e === 'budget_exceeded' ? t('rfq.quote_extract_err_budget') : res.status === 429 ? t('rfq.quote_extract_err_rate') : t('rfq.quote_extract_err_unavailable') })
      return
    }
    const f = res.data.fields
    const isGoods = rfq?.kind === 'goods' && !!rfq.goodsSpec
    if (isGoods) {
      if (f.unit_price_paise != null) setUnitPrice(String(f.unit_price_paise / 100))
      if (f.gst_rate_bps != null) setGstBps(f.gst_rate_bps)
      if (f.hsn_code != null) setHsn(f.hsn_code)
    } else if (f.price_paise != null) setPrice(String(f.price_paise / 100))
    if (f.delivery_days != null) setDays(String(f.delivery_days))
    if (f.gst_included != null) setGst(f.gst_included)
    if (f.transport_included != null) setTransport(f.transport_included)
    if (f.valid_until != null) setValidUntil(f.valid_until)
    if (f.advance_percent != null) setAdvance(String(f.advance_percent))
    if (!scope.trim() && f.scope_summary?.trim()) setScope(f.scope_summary.trim())
    setUncertain(new Set(f.uncertain_fields as ExtractField[]))
    setExtractionId(res.data.extraction_id)
    setStubPreview(!!res.data.stub)
    setExtractMsg({ ok: true, text: t('rfq.quote_extract_filled') })
  }
  function clearSuggestion() { setExtractionId(null); setUncertain(new Set()); setStubPreview(false); setExtractMsg(null) }

  // S1.3 — prefill every field from the current quote (goods included), drop any extraction, open the form.
  function startRevise() {
    const q = rfq?.myQuote
    if (!q) return
    clearSuggestion()
    setError('')
    setPrice(String(q.pricePaise / 100))
    setDays(String(q.deliveryDays))
    setScope(q.scope ?? '')
    setGst(q.gstIncluded ?? null)
    setTransport(q.transportIncluded ?? null)
    setValidUntil(q.validUntil ?? '')
    setAdvance(q.advancePercent == null ? '' : String(q.advancePercent))
    if (q.goods) { setUnitPrice(String(q.goods.unitPricePaise / 100)); setGstBps(q.goods.gstRateBps); setHsn(q.goods.hsnCode ?? ''); setGQty(String(q.goods.qty)) }
    setRevising(true)
  }

  async function submit() {
    setError('')
    const dd = Number(days)
    let p = Math.round(Number(price) * 100)
    let goodsTerms: { unit_price_paise: number; gst_rate_bps: number; hsn_code: string; qty?: number } | undefined
    if (rfq?.kind === 'goods' && rfq.goodsSpec) {
      const unitPaise = Math.round(Number(unitPrice) * 100)
      const qtyNum = Number(gQty)
      if (!unitPaise || unitPaise <= 0 || gstBps === null || !/^\d{4}(?:\d{2})?(?:\d{2})?$/.test(hsn.trim()) || !Number.isInteger(qtyNum) || qtyNum <= 0) { setError(t('rfq.goods_err_terms')); return }
      goodsTerms = { unit_price_paise: unitPaise, gst_rate_bps: gstBps, hsn_code: hsn.trim(), ...(qtyNum !== Number(rfq.goodsSpec?.qty) ? { qty: qtyNum } : {}) }
      p = unitPaise * qtyNum // placeholder; the server recomputes price_paise for goods
    }
    if (!p || p <= 0 || !dd || dd <= 0 || scope.trim().length < 20) { setError(t('rfq.required')); return }
    const adv = advance.trim() === '' ? undefined : Number(advance)
    if (adv !== undefined && (!Number.isInteger(adv) || adv < 0 || adv > 100)) { setError(t('rfq.term_advance') + ': 0–100'); return }
    if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) { setError(t('rfq.term_valid_until') + ': YYYY-MM-DD'); return }
    setBusy(true)
    const body = {
      price_paise: p, delivery_days: dd, scope: scope.trim(),
      ...(gst !== null ? { gst_included: gst } : {}),
      ...(transport !== null ? { transport_included: transport } : {}),
      ...(validUntil ? { valid_until: validUntil } : {}),
      ...(adv !== undefined ? { advance_percent: adv } : {}),
      ...(goodsTerms ? { goods: goodsTerms } : {}),
    }
    // S1.3 — revise = PATCH in place (never an extraction_id); submit = POST.
    confirmHaptic()
    const res = revising ? await reviseQuote(id, body) : await submitQuote(id, { ...body, ...(extractionId ? { extraction_id: extractionId } : {}) })
    setBusy(false)
    if (!res.ok) {
      const e = res.data?.error
      setError(
        e === 'already_quoted' ? t('rfq.already_quoted')
        : e === 'rfq_closed' ? t('rfq.rfq_closed')
        : e === 'revision_cap' ? t('rfq.revise_err_cap')
        : e === 'revision_conflict' ? t('rfq.revise_err_conflict')
        : e === 'quote_not_revisable' || e === 'quote_not_found' ? t('rfq.revise_err_not_revisable')
        : revising ? t('rfq.revise_err_generic') : t('rfq.err_quote'),
      )
      return
    }
    if (revising) { setRevising(false); setLoading(true); await load(); return }
    router.back()
  }

  if (loading) return <View className="flex-1 items-center justify-center bg-background"><ActivityIndicator size="large" color="#1B4D3E" /></View>
  if (!rfq) return null
  const isGoods = rfq.kind === 'goods' && !!rfq.goodsSpec
  const details: [string, any][] = Object.entries(rfq.details ?? {}).filter(([, v]) => v != null && String(v).trim() !== '')
  const box = (f: ExtractField) => `rounded-lg border bg-background px-3 py-2 text-sm text-foreground ${uncertain.has(f) ? AMBER : 'border-border'}`
  const hint = (f: ExtractField) => (uncertain.has(f) ? <Text className="text-[11px] text-[#b45309]">{t('rfq.quote_extract_uncertain_hint')}</Text> : null)

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="border-b border-border bg-surface px-4 py-3">
        <Text className="text-base font-bold text-foreground" numberOfLines={1}>{rfq.title}</Text>
      </View>
      <ScrollView contentContainerClassName="px-4 py-4 gap-4">
        {isGoods && <View className="-mx-4 -mt-4"><GoodsSpecBlock spec={rfq.goodsSpec} t={t} /></View>}
        <View className="rounded-xl border border-border bg-surface p-4 gap-1">
          {/* S3.2 — the same fair price line the buyer sees, in the summary card; nothing when there is none */}
          {benchmark ? <BenchmarkBlock raw={benchmark} role="provider" locale={locale} t={t} /> : null}
          {details.map(([k, v]) => (
            <Text key={k} className="text-sm text-foreground"><Text className="text-foreground-secondary capitalize">{k.replace(/_/g, ' ')}: </Text>{String(v)}</Text>
          ))}
        </View>

        {/* S1.3 — ask before quoting + the whole thread ("you asked" on mine); read-only once closed. */}
        <ClarificationsBlock
          rfqId={id}
          role="provider"
          initial={rfq.clarifications ?? []}
          canWrite={active && !rfq.declinedAt}
          closed={!active}
        />

        {rfq.myQuote && !revising ? (
          <View className="rounded-xl border border-success/40 bg-success/5 p-4">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-semibold text-success">{t('rfq.your_quote')}</Text>
              {rfq.myQuote.revision > 1 ? <Text className="rounded-full border border-[#b45309]/40 bg-[#f5ebdd] px-2 py-0.5 text-[11px] font-medium text-[#b45309]">{t('rfq.revise_count', { n: rfq.myQuote.revision - 1 })}</Text> : null}
            </View>
            {rfq.myQuote.goods ? (
              <Text className="mt-1 text-sm text-foreground">{formatINR(rfq.myQuote.goods.unitPricePaise)} / {rfq.goodsSpec?.unit} × {rfq.myQuote.goods.qty} · {t('rfq.goods_col_incl')} {formatINR(rfq.myQuote.goods.totalInclGstPaise)} · {t('rfq.delivery_days', { days: rfq.myQuote.deliveryDays })}</Text>
            ) : (
              <Text className="mt-1 text-sm text-foreground">{formatINR(rfq.myQuote.pricePaise)} · {t('rfq.delivery_days', { days: rfq.myQuote.deliveryDays })}</Text>
            )}
            <Text className="mt-1 text-sm text-foreground-secondary">{rfq.myQuote.scope}</Text>
            {/* S1.3 — revise in place while submitted, RFQ active and under the cap (server re-checks). */}
            {rfq.myQuote.status === 'submitted' && active && (rfq.myQuote.revision ?? 1) < 3 ? (
              <TouchableOpacity onPress={startRevise} className="mt-3 self-start rounded-lg border border-border px-3 py-1.5">
                <Text className="text-sm font-medium text-foreground">{t('rfq.revise_button')}</Text>
              </TouchableOpacity>
            ) : null}
            {/* S1.2 — buyer declined: reason label + the courteous message (never the buyer's note). */}
            {rfq.myQuote.status === 'declined' && (
              <View className="mt-2 rounded-lg border border-border bg-background p-2">
                <Text className="text-sm font-medium text-foreground">{t('rfq.quote_declined_title')}</Text>
                {rfq.myQuote.declineReason ? <Text className="text-xs text-foreground-secondary">{t('rfq.quote_declined_reason')}: {t(`rfq.declined_reason_label_${rfq.myQuote.declineReason}`)}</Text> : null}
                {rfq.myQuote.declineMessage ? <Text className="mt-1 text-sm text-foreground">{rfq.myQuote.declineMessage}</Text> : null}
              </View>
            )}
          </View>
        ) : rfq.canQuote || revising ? (
          <View className="rounded-xl border border-border bg-surface p-4 gap-3">
            <Text className="text-sm font-semibold text-foreground">{revising ? t('rfq.revise_title') : t('rfq.quote_title')}</Text>
            {revising ? <Text className="text-xs text-foreground-secondary">{t('rfq.revise_intro')}</Text> : null}

            {/* S1.1 — Type or speak your quote (only when the server says this provider is enabled). */}
            {extractEnabled && !revising && (
              <View className="rounded-xl border border-primary/30 bg-primary/5 p-3 gap-2">
                <View className="flex-row items-start justify-between gap-2">
                  <View className="flex-1">
                    <Text className="text-sm font-semibold text-foreground">{t('rfq.quote_extract_title')}</Text>
                    <Text className="text-xs text-foreground-secondary">{t('rfq.quote_extract_subtitle')}</Text>
                  </View>
                  {stubPreview && <Text className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground-secondary">{t('rfq.quote_extract_stub_pill')}</Text>}
                </View>
                <TextInput
                  value={draft}
                  onChangeText={(v) => { setDraft(v); setDraftSource('typed') }}
                  placeholder={t('rfq.quote_extract_placeholder')}
                  placeholderTextColor="#9CA3AF"
                  multiline
                  maxLength={4000}
                  style={{ minHeight: 72 }}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                />
                {/* Same STT path as the RFQ recorder: a parse result or a transcript both land in the box. */}
                <VoiceRfqRecorder
                  onParsed={(data) => appendDictation(data?.transcript_english ?? data?.parse?.description_english ?? '')}
                  onTranscriptOnly={(transcript) => appendDictation(transcript)}
                />
                <View className="flex-row items-center gap-3">
                  <TouchableOpacity onPress={fill} disabled={extracting || draft.trim().length < 5} className={`items-center rounded-lg px-4 py-2 ${extracting || draft.trim().length < 5 ? 'bg-primary/40' : 'bg-primary'}`}>
                    {extracting ? <ActivityIndicator color="#fff" /> : <Text className="font-semibold text-white">{t('rfq.quote_extract_fill')}</Text>}
                  </TouchableOpacity>
                  {extractionId && (
                    <TouchableOpacity onPress={clearSuggestion}><Text className="text-xs text-foreground-secondary underline">{t('rfq.quote_extract_clear')}</Text></TouchableOpacity>
                  )}
                </View>
                {extractMsg && <Text className={`text-xs ${extractMsg.ok ? 'text-success' : 'text-danger'}`}>{extractMsg.text}</Text>}
              </View>
            )}

            {isGoods ? (
              <>
                {/* AMC Mart M2 — goods terms; unit price excl. GST, total computed server-side. */}
                <Text className="text-xs text-foreground-secondary">{t('rfq.goods_quote_intro', { qty: rfq.goodsSpec.qty, unit: rfq.goodsSpec.unit })}</Text>
                <View className="flex-row gap-3">
                  <View className="flex-1 gap-1"><Text className="text-xs text-foreground-secondary">{t('rfq.goods_quote_unit_price', { unit: rfq.goodsSpec.unit })}</Text><TextInput value={unitPrice} onChangeText={(v) => { setUnitPrice(v); settle('unit_price') }} keyboardType="decimal-pad" className={box('unit_price')} />{hint('unit_price')}</View>
                  <View className="flex-1 gap-1"><Text className="text-xs text-foreground-secondary">{t('rfq.goods_quote_qty')}</Text><TextInput value={gQty} onChangeText={setGQty} keyboardType="numeric" className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" /></View>
                </View>
                <View className="gap-1">
                  <Text className="text-xs text-foreground-secondary">{t('rfq.goods_quote_gst')}</Text>
                  <View className="flex-row flex-wrap gap-2">
                    {GST_RATE_BPS_OPTIONS.map((b) => (
                      <TouchableOpacity key={b} onPress={() => { setGstBps(b); settle('gst_rate_bps') }} className={`rounded-lg border px-3 py-1.5 ${gstBps === b ? 'border-primary bg-primary/10' : uncertain.has('gst_rate_bps') ? `${AMBER} bg-background` : 'border-border bg-background'}`}>
                        <Text className={`text-xs ${gstBps === b ? 'font-semibold text-primary' : 'text-foreground'}`}>{b / 100}%</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  {hint('gst_rate_bps')}
                </View>
                <View className="flex-row gap-3">
                  <View className="flex-1 gap-1"><Text className="text-xs text-foreground-secondary">{t('rfq.goods_quote_hsn')}</Text><TextInput value={hsn} onChangeText={(v) => { setHsn(v.replace(/\D/g, '')); settle('hsn_code') }} keyboardType="numeric" maxLength={8} className={box('hsn_code')} />{hint('hsn_code')}</View>
                  <View className="flex-1 gap-1"><Text className="text-xs text-foreground-secondary">{t('rfq.quote_days')}</Text><TextInput value={days} onChangeText={(v) => { setDays(v); settle('delivery_days') }} keyboardType="numeric" className={box('delivery_days')} />{hint('delivery_days')}</View>
                </View>
              </>
            ) : (
              <View className="flex-row gap-3">
                <View className="flex-1 gap-1"><Text className="text-xs text-foreground-secondary">{t('rfq.quote_price')}</Text><TextInput value={price} onChangeText={(v) => { setPrice(v); settle('price') }} keyboardType="numeric" className={box('price')} />{hint('price')}</View>
                <View className="flex-1 gap-1"><Text className="text-xs text-foreground-secondary">{t('rfq.quote_days')}</Text><TextInput value={days} onChangeText={(v) => { setDays(v); settle('delivery_days') }} keyboardType="numeric" className={box('delivery_days')} />{hint('delivery_days')}</View>
              </View>
            )}
            <View className="gap-1"><Text className="text-xs text-foreground-secondary">{t('rfq.quote_scope')}</Text><TextInput value={scope} onChangeText={setScope} multiline style={{ minHeight: 80 }} className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" /></View>
            {/* Phase 4b — optional terms; leaving them untouched submits exactly as before. */}
            <Text className="text-xs font-medium text-foreground">{t('rfq.terms_section')} <Text className="font-normal text-foreground-secondary">· {t('rfq.terms_optional_note')}</Text></Text>
            <TriRow label={t('rfq.term_gst_q')} value={gst} onChange={(v) => { setGst(v); settle('gst_included') }} yes={t('rfq.term_yes')} no={t('rfq.term_no')} unset={t('rfq.term_not_stated_option')} attention={uncertain.has('gst_included')} />
            {hint('gst_included')}
            <TriRow label={t('rfq.term_transport_q')} value={transport} onChange={(v) => { setTransport(v); settle('transport_included') }} yes={t('rfq.term_yes')} no={t('rfq.term_no')} unset={t('rfq.term_not_stated_option')} attention={uncertain.has('transport_included')} />
            {hint('transport_included')}
            <View className="flex-row gap-3">
              <View className="flex-1 gap-1"><Text className="text-xs text-foreground-secondary">{t('rfq.term_valid_until')}</Text><TextInput value={validUntil} onChangeText={(v) => { setValidUntil(v); settle('valid_until') }} placeholder="YYYY-MM-DD" placeholderTextColor="#9CA3AF" className={box('valid_until')} />{hint('valid_until')}</View>
              <View className="flex-1 gap-1"><Text className="text-xs text-foreground-secondary">{t('rfq.term_advance')}</Text><TextInput value={advance} onChangeText={(v) => { setAdvance(v); settle('advance_percent') }} keyboardType="numeric" placeholder="0–100" placeholderTextColor="#9CA3AF" className={box('advance_percent')} />{hint('advance_percent')}</View>
            </View>
            {error ? <Text className="text-sm text-danger">{error}</Text> : null}
            <View className="flex-row gap-2">
              <TouchableOpacity onPress={submit} disabled={busy} className="flex-1 items-center rounded-lg bg-primary py-2.5">
                {busy ? <ActivityIndicator color="#fff" /> : <Text className="font-semibold text-white">{revising ? t('rfq.revise_submit') : t('rfq.submit_quote')}</Text>}
              </TouchableOpacity>
              {revising ? (
                <TouchableOpacity onPress={() => { setRevising(false); setError('') }} disabled={busy} className="items-center justify-center rounded-lg border border-border px-4">
                  <Text className="text-sm font-medium text-foreground">{t('rfq.revise_cancel')}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        ) : (
          <View className="rounded-xl border border-border bg-surface p-4"><Text className="text-center text-sm text-foreground-secondary">{t('rfq.rfq_closed')}</Text></View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

/** Three-state chooser for an optional yes/no term: unset (not stated) / yes / no. */
function TriRow({ label, value, onChange, yes, no, unset, attention = false }: { label: string; value: boolean | null; onChange: (v: boolean | null) => void; yes: string; no: string; unset: string; attention?: boolean }) {
  const opts: { v: boolean | null; l: string }[] = [{ v: null, l: unset }, { v: true, l: yes }, { v: false, l: no }]
  return (
    <View className="gap-1">
      <Text className="text-xs text-foreground-secondary">{label}</Text>
      <View className="flex-row gap-2">
        {opts.map((o) => (
          <TouchableOpacity key={String(o.v)} onPress={() => onChange(o.v)} className={`rounded-lg border px-3 py-1.5 ${value === o.v ? 'border-primary bg-primary/10' : attention ? `${AMBER} bg-background` : 'border-border bg-background'}`}>
            <Text className={`text-xs ${value === o.v ? 'font-semibold text-primary' : 'text-foreground'}`}>{o.l}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  )
}
