import { ScrollView, Text, View, TouchableOpacity, ActivityIndicator, TextInput, Dimensions, Alert } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect, useCallback } from 'react'
import { useLocalSearchParams, router } from 'expo-router'
import { useI18n } from '@/lib/i18n'
import { fetchRfq, acceptQuote, fetchQuoteMessages, sendQuoteMessage } from '@/lib/api'
import { formatINR } from '@/lib/format'

 
const CARD_W = Math.min(Dimensions.get('window').width - 48, 340)

export default function BuyerRfqScreen() {
  const { t } = useI18n()
  const { id } = useLocalSearchParams<{ id: string }>()
  const [rfq, setRfq] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [accepting, setAccepting] = useState<string | null>(null)
  const [thread, setThread] = useState<string | null>(null)

  const load = useCallback(async () => { const d = await fetchRfq(id); setRfq(d?.rfq ?? null); setLoading(false) }, [id])
  // Deferred: keeps setState off the effect's synchronous path.
  useEffect(() => { void Promise.resolve().then(load) }, [load])

  async function accept(quoteId: string) {
    setAccepting(quoteId)
    const res = await acceptQuote(quoteId)
    setAccepting(null)
    if (res.ok && res.data?.orderId) router.replace(`/orders/${res.data.orderId}` as never)
    else Alert.alert('Error', 'Could not complete checkout.')
  }

  if (loading) return <View className="flex-1 items-center justify-center bg-background"><ActivityIndicator size="large" color="#1B4D3E" /></View>
  if (!rfq) return null

  const quotes: any[] = rfq.quotes ?? []
  const decided = rfq.status === 'accepted'

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="border-b border-border bg-surface px-4 py-3">
        <Text className="text-base font-bold text-foreground" numberOfLines={1}>{rfq.title}</Text>
        <Text className="text-xs text-foreground-secondary">{t(`rfq.status_${rfq.status}`)} · {t('rfq.quotes_n', { n: rfq.quoteCount, max: rfq.maxQuotes })}</Text>
      </View>

      {rfq.status === 'expired' ? (
        <View className="m-4 rounded-xl border border-border bg-surface p-5">
          <Text className="text-base font-semibold text-foreground">{t('rfq.expired_title')}</Text>
          <Text className="mt-1 text-sm text-foreground-secondary">{t('rfq.rescue')}</Text>
          <TouchableOpacity onPress={() => router.push('/rfq/new' as never)} className="mt-3 self-start rounded-lg bg-primary px-4 py-2">
            <Text className="text-sm font-semibold text-white">{t('rfq.post_cta')}</Text>
          </TouchableOpacity>
        </View>
      ) : quotes.length === 0 ? (
        <View className="m-4 rounded-xl border border-dashed border-border bg-surface p-8">
          <Text className="text-center text-sm text-foreground-secondary">{t('rfq.no_quotes_yet')}</Text>
        </View>
      ) : (
        <ScrollView>
          <Text className="px-4 pt-4 text-xs text-foreground-secondary">{t('rfq.swipe_hint')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} snapToInterval={CARD_W + 12} decelerationRate="fast" contentContainerClassName="gap-3 p-4">
            {quotes.map((q) => (
              <View key={q.id} style={{ width: CARD_W }} className={`rounded-xl border bg-surface p-4 ${q.status === 'accepted' ? 'border-success' : q.status === 'declined' ? 'border-border opacity-60' : 'border-border'}`}>
                <Text className="text-sm font-semibold text-foreground">{q.provider.displayName}</Text>
                <Text className="text-xs text-foreground-secondary">{q.provider.avgRating > 0 ? `★ ${q.provider.avgRating.toFixed(1)} (${q.provider.reviewCount})` : t('rfq.status_open')} · {t('rfq.delivery_days', { days: q.deliveryDays })}</Text>
                <Text className="mt-2 font-bold text-primary" style={{ fontSize: 20 }}>{formatINR(q.pricePaise)}</Text>
                <Text className="mt-2 text-sm text-foreground" numberOfLines={6}>{q.scope}</Text>
                {!decided && q.status === 'submitted' && (
                  <TouchableOpacity onPress={() => accept(q.id)} disabled={!!accepting} className="mt-3 items-center rounded-lg bg-primary py-2.5">
                    {accepting === q.id ? <ActivityIndicator color="#fff" /> : <Text className="font-semibold text-white">{t('rfq.accept_quote')}</Text>}
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={() => setThread(thread === q.id ? null : q.id)} className="mt-2 items-center rounded-lg border border-border py-2">
                  <Text className="text-xs font-medium text-primary">{t('rfq.send')}</Text>
                </TouchableOpacity>
                {thread === q.id && <Thread quoteId={q.id} />}
              </View>
            ))}
          </ScrollView>
        </ScrollView>
      )}
    </SafeAreaView>
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
 
