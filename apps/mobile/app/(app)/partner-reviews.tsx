import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useI18n } from '@/lib/i18n'
import { fetchMyReviews, replyReview, type MyReview } from '@/lib/api'
import { track } from '@/lib/analytics'
import { ErrorState } from '@/components/ErrorState'
import { ScreenHeader } from '@/components/ScreenHeader'

/**
 * PRD Experience v3 E13 FR-13.2 — the provider's reviews with one public
 * reply each (the web's reply route; the server enforces "one reply").
 */
export default function PartnerReviewsScreen() {
  const { t } = useI18n()
  const [data, setData] = useState<{ reviews: MyReview[]; avgRating: number; reviewCount: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await fetchMyReviews()
    setFailed(!r.ok)
    setData(r.ok ? r : null)
  }, [])
  useFocusEffect(useCallback(() => { void load() }, [load]))

  async function reply(id: string) {
    const text = (drafts[id] ?? '').trim()
    if (!text) return
    setBusy(id)
    const r = await replyReview(id, text)
    setBusy(null)
    if (r.ok) {
      track('review_replied', { platform: 'android' })
      setData((d) => (d ? { ...d, reviews: d.reviews.map((x) => (x.id === id ? { ...x, provider_reply: text } : x)) } : d))
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ScreenHeader title={t('reviews_v3.title')} />
      {failed ? (
        <ErrorState onRetry={() => void load()} />
      ) : !data ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator size="large" color="#1B4D3E" /></View>
      ) : (
        <ScrollView contentContainerClassName="gap-3 px-4 py-4" testID="reviews-v3">
          <Text className="text-sm text-foreground-secondary">{data.reviewCount > 0 ? t('reviews_v3.summary', { rating: data.avgRating.toFixed(1), n: data.reviewCount }) : t('reviews_v3.empty')}</Text>
          {data.reviews.map((r) => (
            <View key={r.id} className="gap-1.5 rounded-xl border border-gray-200 bg-surface p-4">
              <Text className="text-sm font-semibold text-foreground">{'★'.repeat(r.rating)}{'☆'.repeat(Math.max(0, 5 - r.rating))}</Text>
              {r.order ? <Text className="text-xs text-foreground-secondary">{r.order.title} · {r.order.order_number}</Text> : null}
              {r.text ? <Text className="text-sm text-foreground">{r.text}</Text> : null}
              {r.provider_reply ? (
                <View className="mt-1 rounded-lg bg-muted p-2">
                  <Text className="text-xs font-medium text-primary">{t('reviews.provider_reply')}</Text>
                  <Text className="text-sm text-foreground">{r.provider_reply}</Text>
                </View>
              ) : (
                <View className="mt-1 gap-2">
                  <TextInput
                    value={drafts[r.id] ?? ''}
                    onChangeText={(v) => setDrafts((d) => ({ ...d, [r.id]: v.slice(0, 1000) }))}
                    placeholder={t('reviews_v3.reply_placeholder')}
                    multiline
                    className="min-h-16 rounded-lg border border-gray-200 bg-background p-2 text-sm text-foreground"
                    accessibilityLabel={t('reviews_v3.reply_placeholder')}
                  />
                  <TouchableOpacity onPress={() => void reply(r.id)} disabled={busy === r.id || !(drafts[r.id] ?? '').trim()} className="items-center self-end rounded-lg bg-primary px-4 py-2" accessibilityRole="button">
                    {busy === r.id ? <ActivityIndicator color="#fff" /> : <Text className="text-sm font-semibold text-white">{t('reviews_v3.reply')}</Text>}
                  </TouchableOpacity>
                </View>
              )}
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}
