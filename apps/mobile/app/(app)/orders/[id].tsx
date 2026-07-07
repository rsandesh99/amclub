import { ScrollView, Text, View, ActivityIndicator, TouchableOpacity, Alert, TextInput } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect, useCallback } from 'react'
import { useLocalSearchParams, router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { fetchOrder, transitionOrder, fetchOrderReview, submitReview, replyReview } from '@/lib/api'
import { formatINR } from '@/lib/format'

 
// Returns action keys; labels come from t(`order_actions.${action}`).
function actionsFor(role: string, status: string): string[] {
  if (role === 'provider') {
    if (status === 'placed') return ['accept']
    if (status === 'requirements_submitted') return ['start']
    if (status === 'in_progress') return ['deliver']
    if (status === 'revision_requested') return ['resume']
  } else {
    if (status === 'accepted') return ['submit_requirements']
    if (status === 'delivered') return ['accept_delivery', 'request_revision']
    if (status === 'placed' || status === 'accepted') return ['cancel']
  }
  return []
}

export default function OrderScreen() {
  const { t } = useI18n()
  const { id } = useLocalSearchParams<{ id: string }>()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const d = await fetchOrder(id)
    setData(d)
    setLoading(false)
  }, [id])

  // Deferred so load()'s setState stays off the effect's synchronous path
  // (react-hooks/set-state-in-effect); load also refreshes after actions.
  useEffect(() => { void Promise.resolve().then(load) }, [load])

  async function act(action: string) {
    setBusy(true)
    const { ok, data: res } = await transitionOrder(id, action)
    setBusy(false)
    if (!ok) { Alert.alert(t('common.error'), res.error ?? t('order_actions.failed')); return }
    load()
  }

  if (loading) return <SafeAreaView className="flex-1 items-center justify-center bg-background"><ActivityIndicator size="large" color="#1B4D3E" /></SafeAreaView>
  if (!data?.order) return <SafeAreaView className="flex-1 items-center justify-center bg-background"><Text className="text-foreground-secondary">{t('common.not_found')}</Text></SafeAreaView>

  const o = data.order
  const actions = actionsFor(data.viewerRole, o.status)

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 border-b border-gray-200 bg-surface px-4 py-3">
        <TouchableOpacity onPress={() => router.back()}><Ionicons name="arrow-back" size={22} color="#1A1D1A" /></TouchableOpacity>
        <Text className="flex-1 text-lg font-bold text-foreground" numberOfLines={1}>{o.title}</Text>
      </View>

      <ScrollView contentContainerClassName="px-4 py-4 gap-4">
        <View className="rounded-xl border border-gray-200 bg-surface p-4">
          <Text className="text-xs text-foreground-secondary">{o.order_number}</Text>
          <View className="mt-1 flex-row items-center justify-between">
            <Text className="text-base font-bold text-foreground">{formatINR(Number(o.total_paise))}</Text>
            <View className="rounded-full bg-primary/10 px-3 py-1"><Text className="text-xs font-semibold text-primary">{t(`orders.status_${o.status}` as 'orders.status_placed')}</Text></View>
          </View>
        </View>

        {actions.length > 0 && (
          <View className="rounded-xl border border-gray-200 bg-surface p-4 gap-2">
            <Text className="text-sm font-semibold text-foreground">{t('orders.actions')}</Text>
            {actions.map((action) => (
              <TouchableOpacity key={action} onPress={() => act(action)} disabled={busy} className={`items-center rounded-lg py-3 ${busy ? 'bg-primary/60' : 'bg-primary'}`}>
                <Text className="text-sm font-semibold text-white">{t(`order_actions.${action}` as 'order_actions.accept')}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {(o.status === 'completed' || o.status === 'reviewed') && <ReviewBlock orderId={id} />}

        <View className="rounded-xl border border-gray-200 bg-surface p-4">
          <Text className="mb-2 text-sm font-semibold text-foreground">{t('orders.timeline')}</Text>
          {(data.events ?? []).map((e: any) => (
            <View key={e.id} className="mb-2 flex-row gap-2">
              <View className="mt-1.5 h-2 w-2 rounded-full bg-primary" />
              <View>
                <Text className="text-sm capitalize text-foreground">{String(e.event).replace(/_/g, ' ')}</Text>
                <Text className="text-xs text-foreground-secondary">{new Date(e.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

function Stars({ value, onSelect }: { value: number; onSelect?: (n: number) => void }) {
  return (
    <View className="flex-row gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <TouchableOpacity key={n} disabled={!onSelect} onPress={() => onSelect?.(n)}>
          <Text className={`text-2xl ${n <= value ? 'text-amber-500' : 'text-gray-300'}`}>★</Text>
        </TouchableOpacity>
      ))}
    </View>
  )
}

/** Review prompt/form for the buyer; posted review + provider reply for both. */
function ReviewBlock({ orderId }: { orderId: string }) {
  const { t } = useI18n()
  const [review, setReview] = useState<any>(null)
  const [canReview, setCanReview] = useState(false)
  const [isProvider, setIsProvider] = useState(false)
  const [rating, setRating] = useState(0)
  const [text, setText] = useState('')
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const d = await fetchOrderReview(orderId)
    setReview(d.review); setCanReview(!!d.canReview); setIsProvider(!!d.isProvider)
  }, [orderId])
  // Deferred: keeps setState off the effect's synchronous path.
  useEffect(() => { void Promise.resolve().then(load) }, [load])

  async function send() {
    if (rating < 1) { Alert.alert(t('reviews.pick_rating')); return }
    setBusy(true)
    const { ok, data } = await submitReview(orderId, rating, text.trim() || undefined)
    setBusy(false)
    if (!ok) { Alert.alert(t('common.error'), data.error ?? t('reviews.failed')); return }
    load()
  }

  async function sendReply() {
    if (!reply.trim()) return
    setBusy(true)
    const { ok, data } = await replyReview(review.id, reply.trim())
    setBusy(false)
    if (!ok) { Alert.alert(t('common.error'), data.error ?? t('reviews.failed')); return }
    load()
  }

  if (!review && !canReview) return null

  return (
    <View className="rounded-xl border border-gray-200 bg-surface p-4 gap-2">
      <Text className="text-sm font-semibold text-foreground">{t('reviews.heading')}</Text>

      {!review && canReview && (
        <View className="gap-2">
          <Text className="text-sm text-foreground-secondary">{t('reviews.prompt')}</Text>
          <Stars value={rating} onSelect={setRating} />
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={t('reviews.text_placeholder')}
            placeholderTextColor="#9CA3AF"
            className="min-h-[64px] rounded-lg border border-gray-200 bg-background p-3 text-sm text-foreground"
          />
          <TouchableOpacity onPress={send} disabled={busy} className={`items-center rounded-lg py-3 ${busy ? 'bg-primary/60' : 'bg-primary'}`}>
            <Text className="text-sm font-semibold text-white">{t('reviews.submit')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {review && (
        <View className="gap-2">
          {review.status !== 'published' && <Text className="text-xs text-yellow-700">{t('reviews.status_flagged')}</Text>}
          <Stars value={review.rating} />
          {review.text ? <Text className="text-sm text-foreground">{review.text}</Text> : null}
          {review.provider_reply ? (
            <View className="rounded-lg border-l-2 border-primary/40 bg-primary/5 px-3 py-2">
              <Text className="text-xs font-medium text-primary">{t('reviews.provider_reply')}</Text>
              <Text className="text-sm text-foreground">{review.provider_reply}</Text>
            </View>
          ) : isProvider ? (
            <View className="gap-2">
              <TextInput
                value={reply}
                onChangeText={setReply}
                multiline
                placeholder={t('reviews.reply_placeholder')}
                placeholderTextColor="#9CA3AF"
                className="min-h-[48px] rounded-lg border border-gray-200 bg-background p-3 text-sm text-foreground"
              />
              <TouchableOpacity onPress={sendReply} disabled={busy} className="items-center rounded-lg border border-primary py-2.5">
                <Text className="text-sm font-semibold text-primary">{t('reviews.reply_submit')}</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      )}
    </View>
  )
}
 
