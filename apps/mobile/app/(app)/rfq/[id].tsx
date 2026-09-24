import { ScrollView, Text, View, TouchableOpacity, ActivityIndicator, TextInput, Dimensions, Alert, Modal, Linking } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect, useCallback } from 'react'
import { useLocalSearchParams, router } from 'expo-router'
import { useI18n } from '@/lib/i18n'
import { fetchRfq, acceptQuote, fetchQuoteMessages, sendQuoteMessage, fetchCompare, declineQuote, fetchMe } from '@/lib/api'
import { ClarificationsBlock } from '@/components/ClarificationsBlock'
import { QualityQuestionsBlock } from '@/components/QualityQuestionsBlock'
import { formatINR } from '@/lib/format'
import { GoodsSpecBlock } from '@/components/GoodsSpecBlock'
import { BenchmarkBlock } from '@/components/BenchmarkBlock'
import { track } from '@/lib/analytics'
import { confirmHaptic } from '@/lib/haptics'


const CARD_W = Math.min(Dimensions.get('window').width - 48, 340)
const ATTENTION = new Set(['gst_not_included', 'transport_not_included', 'validity_short', 'validity_expired', 'advance_high'])
const FACT = new Set(['cheapest_after_normalization', 'fastest'])
const BUYER_REASONS = ['price_high', 'delivery_slow', 'details_unclear', 'terms_unacceptable', 'other'] as const

export default function BuyerRfqScreen() {
  const { t, locale } = useI18n() as { t: (k: string, p?: Record<string, string | number>) => string; locale?: string }
  const { id } = useLocalSearchParams<{ id: string }>()
  const [rfq, setRfq] = useState<any>(null)
  // S3.2 — the fair price range (present only when the API sends one)
  const [benchmark, setBenchmark] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [accepting, setAccepting] = useState<string | null>(null)
  const [thread, setThread] = useState<string | null>(null)
  // S1.2 — deterministic flags/totals from the compare endpoint; pointers only when the server says the agent is on.
  const [compare, setCompare] = useState<Record<string, { normalizedTotalPaise: number; flags: string[] }>>({})
  const [pointers, setPointers] = useState<Record<string, string[]>>({})
  const [pointersEnabled, setPointersEnabled] = useState(false)
  // PRD Experience v3 E7 (flag `compare`, delivered as /profile/me.compareV3Enabled): the cards carry the web's groups.
  const [v3, setV3] = useState(false)
  // S2.4 — the server's order (mode + ids; never a score). 'price' keeps the old order exactly.
  const [ordering, setOrdering] = useState<{ mode: 'price' | 'reliability'; ids: string[] } | null>(null)
  const [byPrice, setByPrice] = useState(false)
  const [shortlist, setShortlist] = useState<Set<string>>(new Set())
  const [shortlistOnly, setShortlistOnly] = useState(false)
  const [declining, setDeclining] = useState<any | null>(null)
  const [localDeclined, setLocalDeclined] = useState<Record<string, string>>({})
  // S1.3 — computed at load time (not in render): active RFQ = open|quoted and inside its window.
  const [active, setActive] = useState(false)

  const load = useCallback(async () => {
    const [d, me] = await Promise.all([fetchRfq(id, locale ?? 'en'), fetchMe()])
    setRfq(d?.rfq ?? null)
    setBenchmark(d?.benchmark ?? null)
    setActive(!!d?.rfq && (d.rfq.status === 'open' || d.rfq.status === 'quoted') && new Date(d.rfq.expiresAt).getTime() > Date.now())
    setPointersEnabled(me?.comparePointersEnabled === true)
    const cmpV3 = me?.compareV3Enabled === true
    setV3(cmpV3)
    if (cmpV3 && d?.rfq?.quotes?.length) track('compare_viewed', { quotes: d.rfq.quotes.length })
    setLoading(false)
    if (d?.rfq?.quotes?.length) {
      const c = await fetchCompare(id, locale ?? 'en')
      if (c) {
        setCompare(Object.fromEntries((c.results ?? []).map((r: any) => [r.id, { normalizedTotalPaise: r.normalizedTotalPaise, flags: r.flags }])))
        setPointers(Object.fromEntries((c.pointers?.pointers ?? []).map((p) => [p.quote_id, p.lines])))
        setOrdering(c.ordering ?? null)
      }
    }
  }, [id, locale])
  // Deferred: keeps setState off the effect's synchronous path.
  useEffect(() => { void Promise.resolve().then(load) }, [load])

  async function accept(quoteId: string) {
    setAccepting(quoteId)
    confirmHaptic()
    const res = await acceptQuote(quoteId)
    setAccepting(null)
    if (res.ok && res.data?.orderId) router.replace(`/orders/${res.data.orderId}` as never)
    else Alert.alert('Error', 'Could not complete checkout.')
  }
  const toggleShortlist = (qid: string) => setShortlist((prev) => { const n = new Set(prev); if (n.has(qid)) n.delete(qid); else n.add(qid); return n })

  if (loading) return <View className="flex-1 items-center justify-center bg-background"><ActivityIndicator size="large" color="#1B4D3E" /></View>
  if (!rfq) return null

  const allQuotes: any[] = rfq.quotes ?? []
  const reliability = ordering?.mode === 'reliability' && !byPrice
  const rank = new Map((ordering?.ids ?? []).map((qid, i) => [qid, i]))
  const ordered = reliability ? [...allQuotes].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)) : allQuotes
  const quotes = shortlistOnly ? ordered.filter((q) => shortlist.has(q.id)) : ordered
  const decided = rfq.status === 'accepted'
  const goods = rfq.kind === 'goods' && rfq.goodsSpec ? rfq.goodsSpec : null
  const statusOf = (q: any) => (localDeclined[q.id] ? 'declined' : q.status)
  const reasonOf = (q: any) => localDeclined[q.id] ?? q.declineReason
  // S1.3 — derived, never a status: active RFQ (computed at load) + unanswered provider questions.
  const openQ =((rfq.clarifications ?? []) as any[]).filter((c) => c.answeredAt === null).length
  const clar = <View className="px-4 pt-4"><ClarificationsBlock rfqId={id} role="buyer" initial={rfq.clarifications ?? []} canWrite={active} closed={!active} /></View>

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="border-b border-border bg-surface px-4 py-3">
        <Text className="text-base font-bold text-foreground" numberOfLines={1}>{rfq.title}</Text>
        <Text className="text-xs text-foreground-secondary">{t(`rfq.status_${rfq.status}`)} · {t('rfq.quotes_n', { n: rfq.quoteCount, max: rfq.maxQuotes })}</Text>
        {/* S1.3 — "awaiting your answer" chip: derived state, no status text change. */}
        {active && openQ > 0 ? <Text className="mt-1 self-start rounded-full border border-[#b45309]/40 bg-[#f5ebdd] px-2 py-0.5 text-[11px] font-medium text-[#b45309]">{t('rfq.clarify_awaiting_chip')}</Text> : null}
        {/* S1.5 — derived "deferred" chip (open + fanout_at NULL); never a status text change. */}
        {rfq.quality?.deferred ? <Text className="mt-1 self-start rounded-full border border-[#b45309]/40 bg-[#f5ebdd] px-2 py-0.5 text-[11px] font-medium text-[#b45309]">{t('rfq.quality_chip_deferred')}</Text> : null}
        {/* S1.8 — attachments (signed URLs from the API). */}
        {Array.isArray(rfq.attachments) && rfq.attachments.length > 0 ? (
          <View className="mt-2 flex-row flex-wrap gap-2">
            {rfq.attachments.map((a: { url: string; name: string }) => (
              <TouchableOpacity key={a.url} onPress={() => { void Linking.openURL(a.url) }} className="rounded-full border border-border px-3 py-1">
                <Text className="text-xs font-medium text-primary underline">{a.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
      </View>

      {/* S3.2 — the same fair price line the matched providers see; nothing when there is none */}
      {benchmark ? <View className="px-4"><BenchmarkBlock raw={benchmark} role="buyer" locale={locale ?? 'en'} t={t} /></View> : null}

      {goods && <GoodsSpecBlock spec={goods} t={t} />}

      {rfq.status === 'expired' ? (
        <ScrollView>
          <View className="m-4 rounded-xl border border-border bg-surface p-5">
            <Text className="text-base font-semibold text-foreground">{t('rfq.expired_title')}</Text>
            <Text className="mt-1 text-sm text-foreground-secondary">{t('rfq.rescue')}</Text>
            <TouchableOpacity onPress={() => router.push('/rfq/new' as never)} className="mt-3 self-start rounded-lg bg-primary px-4 py-2">
              <Text className="text-sm font-semibold text-white">{t('rfq.post_cta')}</Text>
            </TouchableOpacity>
          </View>
          {/* Closed → the thread is read-only. */}
          {clar}
        </ScrollView>
      ) : allQuotes.length === 0 ? (
        <ScrollView>
          {/* S1.5 — held for the buyer's answers (nobody matched yet): the questions card first. */}
          {rfq.quality?.deferred && rfq.quality.report ? (
            <View className="px-4 pt-4">
              <QualityQuestionsBlock rfqId={id} report={rfq.quality.report} deadlineAt={rfq.quality.deadlineAt ?? null} onSent={() => { setLoading(true); void load() }} />
            </View>
          ) : null}
          {clar}
          <View className="m-4 rounded-xl border border-dashed border-border bg-surface p-8">
            <Text className="text-center text-sm text-foreground-secondary">{t('rfq.no_quotes_yet')}</Text>
          </View>
        </ScrollView>
      ) : (
        <ScrollView>
          {clar}
          <View className="flex-row items-center justify-between px-4 pt-4">
            <Text className="text-xs text-foreground-secondary">{t('rfq.swipe_hint')}</Text>
            {ordering?.mode === 'reliability' && (
              <TouchableOpacity onPress={() => setByPrice((v) => !v)} className="rounded-full border border-border px-2 py-0.5" testID="reliability-toggle">
                <Text className="text-[11px] text-primary">{byPrice ? t('rfq.sort_reliability') : t('rfq.reliability_switch')}</Text>
              </TouchableOpacity>
            )}
            {shortlist.size > 0 && (
              <TouchableOpacity onPress={() => setShortlistOnly((v) => !v)} className={`rounded-full border px-2 py-0.5 ${shortlistOnly ? 'border-primary bg-primary/10' : 'border-border'}`}>
                <Text className="text-[11px] text-foreground">★ {t('rfq.compare_shortlisted_only')} ({shortlist.size})</Text>
              </TouchableOpacity>
            )}
          </View>
          {reliability && <Text className="px-4 pt-1 text-[11px] text-foreground-secondary" testID="reliability-line">{t('rfq.reliability_line')}</Text>}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} snapToInterval={CARD_W + 12} decelerationRate="fast" contentContainerClassName="gap-3 p-4">
            {quotes.map((q) => {
              const st = statusOf(q)
              const c = compare[q.id]
              const lines = pointers[q.id] ?? []
              return (
                <View key={q.id} style={{ width: CARD_W }} className={`rounded-xl border bg-surface p-4 ${st === 'accepted' ? 'border-success' : st === 'declined' ? 'border-border opacity-60' : 'border-border'}`}>
                  <View className="flex-row items-start justify-between">
                    <Text className="flex-1 text-sm font-semibold text-foreground">{q.provider.displayName}</Text>
                    <TouchableOpacity onPress={() => toggleShortlist(q.id)} hitSlop={8}><Text className={`text-base ${shortlist.has(q.id) ? 'text-accent' : 'text-foreground-secondary'}`}>{shortlist.has(q.id) ? '★' : '☆'}</Text></TouchableOpacity>
                  </View>
                  {v3 ? (
                    <Text className="text-xs text-foreground-secondary">{q.provider.avgRating > 0 ? `★ ${q.provider.avgRating.toFixed(1)} (${q.provider.reviewCount})` : t('rfq.new_label')} · {t('rfq.compare_completed_orders')} {q.provider.completedOrders ?? 0}</Text>
                  ) : (
                    <Text className="text-xs text-foreground-secondary">{q.provider.avgRating > 0 ? `★ ${q.provider.avgRating.toFixed(1)} (${q.provider.reviewCount})` : t('rfq.status_open')} · {t('rfq.delivery_days', { days: q.deliveryDays })}</Text>
                  )}
                  {v3 && <GroupLabel title={t('rfq.cmp3_group_price')} />}
                  {goods && q.goods ? (
                    <>
                      <Text className="mt-2 font-bold text-primary" style={{ fontSize: 20 }}>{formatINR(q.goods.unitPricePaise)} <Text className="text-xs font-normal text-foreground-secondary">/ {goods.unit}</Text></Text>
                      <Text className="text-xs text-foreground-secondary">{t('rfq.goods_col_qty')} {q.goods.qty} {goods.unit} · {t('rfq.goods_col_gst')} {q.goods.gstRateBps / 100}% ({formatINR(q.goods.gstPaise)})</Text>
                      <Text className="text-xs text-foreground">{t('rfq.goods_col_incl')}: <Text className="font-semibold">{formatINR(q.goods.totalInclGstPaise)}</Text> · {t('rfq.goods_col_after_itc')}: <Text className="font-semibold text-success">{formatINR(q.goods.afterItcPaise)}</Text></Text>
                    </>
                  ) : (
                    <Text className="mt-2 font-bold text-primary" style={{ fontSize: 20 }}>{formatINR(q.pricePaise)}</Text>
                  )}
                  {/* S1.2 — server-computed normalised total + deterministic flags (never a model). */}
                  {c && (
                    <>
                      <Text className="text-xs text-foreground-secondary">{t('rfq.compare_normalized')}: <Text className="font-semibold text-foreground">{formatINR(c.normalizedTotalPaise)}</Text></Text>
                      <View className="mt-1 flex-row flex-wrap gap-1">
                        {c.flags.length === 0 ? <Text className="text-[11px] text-foreground-secondary">{t('rfq.compare_no_flags')}</Text> : c.flags.map((f) => (
                          <View key={f} className={`rounded-full border px-2 py-0.5 ${FACT.has(f) ? 'border-success/40 bg-success/10' : ATTENTION.has(f) ? 'border-[#b45309]/40 bg-[#f5ebdd]' : 'border-border bg-muted'}`}>
                            <Text className={`text-[11px] ${FACT.has(f) ? 'text-success' : ATTENTION.has(f) ? 'text-[#b45309]' : 'text-foreground-secondary'}`}>{t(`rfq.flag_${f}_label`)}</Text>
                          </View>
                        ))}
                      </View>
                    </>
                  )}
                  {pointersEnabled && lines.length > 0 && (
                    <View className="mt-1">{lines.map((l, i) => <Text key={i} className="text-xs text-foreground">· {l}</Text>)}</View>
                  )}
                  {v3 && (
                    <>
                      <GroupLabel title={t('rfq.cmp3_group_time')} />
                      <Text className="text-xs text-foreground">{t('rfq.delivery_days', { days: q.deliveryDays })}</Text>
                      <GroupLabel title={t('rfq.cmp3_group_terms')} />
                    </>
                  )}
                  <Text className="mt-2 text-sm text-foreground" numberOfLines={6}>{q.scope}</Text>
                  <TermsBlock q={q} t={t} />
                  {!decided && st === 'submitted' && (
                    <View className="mt-3 flex-row gap-2">
                      <TouchableOpacity onPress={() => accept(q.id)} disabled={!!accepting} className="flex-1 items-center rounded-lg bg-primary py-2.5">
                        {accepting === q.id ? <ActivityIndicator color="#fff" /> : <Text className="font-semibold text-white">{t('rfq.accept_quote')}</Text>}
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => setDeclining(q)} className="items-center justify-center rounded-lg border border-border px-3">
                        <Text className="text-sm font-medium text-foreground">{t('rfq.decline_quote_button')}</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                  {st === 'declined' && (
                    <Text className="mt-2 self-start rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-foreground-secondary">{reasonOf(q) ? t(`rfq.declined_reason_label_${reasonOf(q)}`) : t('rfq.status_declined')}</Text>
                  )}
                  <TouchableOpacity onPress={() => setThread(thread === q.id ? null : q.id)} className="mt-2 items-center rounded-lg border border-border py-2">
                    <Text className="text-xs font-medium text-primary">{t('rfq.send')}</Text>
                  </TouchableOpacity>
                  {thread === q.id && <Thread quoteId={q.id} />}
                </View>
              )
            })}
          </ScrollView>
        </ScrollView>
      )}

      {declining && (
        <DeclineSheet
          t={t}
          quote={declining}
          rfqId={id}
          onClose={() => setDeclining(null)}
          onDeclined={(reason) => { setLocalDeclined((m) => ({ ...m, [declining.id]: reason })); setDeclining(null) }}
        />
      )}
    </SafeAreaView>
  )
}

function DeclineSheet({ t, quote, rfqId, onClose, onDeclined }: { t: (k: string, p?: Record<string, string | number>) => string; quote: any; rfqId: string; onClose: () => void; onDeclined: (reason: string) => void }) {
  const [reason, setReason] = useState<string>('price_high')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function submit() {
    setBusy(true)
    setErr('')
    const res = await declineQuote(rfqId, quote.id, { reason, ...(note.trim() ? { note: note.trim().slice(0, 200) } : {}) })
    setBusy(false)
    if (res.ok) onDeclined(reason)
    else setErr(t('rfq.decline_quote_failed'))
  }
  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/40">
        <View className="rounded-t-2xl bg-surface p-5 gap-3">
          <Text className="text-base font-bold text-foreground">{t('rfq.decline_quote_title')}</Text>
          <Text className="text-xs text-foreground-secondary">{quote.provider?.displayName}</Text>
          <Text className="text-xs font-medium text-foreground-secondary">{t('rfq.decline_quote_reason_label')}</Text>
          <View className="flex-row flex-wrap gap-2">
            {BUYER_REASONS.map((r) => (
              <TouchableOpacity key={r} onPress={() => setReason(r)} className={`rounded-lg border px-3 py-1.5 ${reason === r ? 'border-primary bg-primary/10' : 'border-border bg-background'}`}>
                <Text className={`text-xs ${reason === r ? 'font-semibold text-primary' : 'text-foreground'}`}>{t(`rfq.decline_quote_reason_${r}`)}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text className="text-xs font-medium text-foreground-secondary">{t('rfq.decline_quote_note_label')}</Text>
          <TextInput value={note} onChangeText={(v) => setNote(v.slice(0, 200))} multiline maxLength={200} style={{ minHeight: 56 }} className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
          <Text className="text-[11px] text-foreground-secondary">{t('rfq.decline_quote_note_hint')} · {note.length}/200</Text>
          <Text className="text-[11px] text-foreground-secondary">{t('rfq.decline_quote_no_undo')}</Text>
          {err ? <Text className="text-sm text-danger">{err}</Text> : null}
          <View className="flex-row justify-end gap-2">
            <TouchableOpacity onPress={onClose} disabled={busy} className="rounded-lg px-4 py-2"><Text className="text-sm text-foreground-secondary">{t('rfq.decline_quote_cancel')}</Text></TouchableOpacity>
            <TouchableOpacity onPress={submit} disabled={busy} className="rounded-lg bg-primary px-4 py-2">{busy ? <ActivityIndicator color="#fff" /> : <Text className="text-sm font-semibold text-white">{t('rfq.decline_quote_submit')}</Text>}</TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  )
}

function GroupLabel({ title }: { title: string }) {
  return <Text className="mt-3 border-t border-border pt-2 text-[10px] font-semibold uppercase tracking-wide text-foreground-secondary">{title}</Text>
}

function TermsBlock({ q, t }: { q: any; t: (k: string, p?: Record<string, string | number>) => string }) {
  const yn = (v: boolean) => (v ? t('rfq.term_yes') : t('rfq.term_no'))
  const rows: [string, string | null][] = [
    [t('rfq.term_gst'), q.gstIncluded == null ? null : yn(q.gstIncluded)],
    [t('rfq.term_transport'), q.transportIncluded == null ? null : yn(q.transportIncluded)],
    [t('rfq.term_valid_until'), q.validUntil ?? null],
    [t('rfq.term_advance'), q.advancePercent == null ? null : t('rfq.term_advance_value', { pct: q.advancePercent })],
  ]
  const anyMissing = rows.some(([, v]) => v == null)
  return (
    <View className="mt-2 rounded-lg border border-border bg-background p-2">
      {rows.map(([label, value]) => (
        <Text key={label} className="text-xs text-foreground">
          <Text className="text-foreground-secondary">{label}: </Text>
          {value ?? <Text className="italic text-foreground-secondary">{t('rfq.term_not_stated')}</Text>}
        </Text>
      ))}
      {anyMissing && <Text className="mt-1 text-[11px] text-foreground-secondary">{t('rfq.term_not_stated_hint')}</Text>}
    </View>
  )
}

function Thread({ quoteId }: { quoteId: string }) {
  const { t } = useI18n()
  const [messages, setMessages] = useState<any[]>([])
  const [body, setBody] = useState('')
  useEffect(() => { fetchQuoteMessages(quoteId).then(setMessages) }, [quoteId])
  async function send() {
    if (!body.trim()) return
    const m = await sendQuoteMessage(quoteId, body.trim())
    if (m) { setMessages((p) => [...p, m]); setBody('') }
  }
  return (
    <View className="mt-2 rounded-lg border border-border bg-background p-2">
      <Text className="mb-1 text-[10px] text-foreground-secondary">{t('rfq.masked_note')}</Text>
      {messages.map((m) => (
        <View key={m.id} className={`my-0.5 max-w-[85%] rounded-lg px-2 py-1 ${m.mine ? 'self-end bg-primary' : 'self-start bg-surface'}`}>
          <Text className={`text-xs ${m.mine ? 'text-white' : 'text-foreground'}`}>{m.body}</Text>
        </View>
      ))}
      <View className="mt-1 flex-row gap-2">
        <TextInput value={body} onChangeText={setBody} placeholder={t('rfq.message_placeholder')} className="flex-1 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-foreground" />
        <TouchableOpacity onPress={send} className="rounded-lg bg-primary px-3 justify-center"><Text className="text-xs font-semibold text-white">{t('rfq.send')}</Text></TouchableOpacity>
      </View>
    </View>
  )
}
