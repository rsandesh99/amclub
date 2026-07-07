import { ScrollView, Text, View, TouchableOpacity, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useCallback } from 'react'
import { useFocusEffect, router } from 'expo-router'
import { useI18n } from '@/lib/i18n'
import { fetchMyRfqs } from '@/lib/api'

 
export default function MyRfqsScreen() {
  const { t } = useI18n()
  const [rfqs, setRfqs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useFocusEffect(useCallback(() => {
    setLoading(true)
    fetchMyRfqs().then((r) => { setRfqs(r); setLoading(false) })
  }, []))

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center justify-between border-b border-border bg-surface px-4 py-3">
        <Text className="text-lg font-bold text-foreground">{t('rfq.list_title')}</Text>
        <TouchableOpacity onPress={() => router.push('/rfq/new' as never)} className="rounded-lg bg-primary px-3 py-1.5">
          <Text className="text-xs font-semibold text-white">{t('rfq.post_cta')}</Text>
        </TouchableOpacity>
      </View>
      {loading ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator size="large" color="#1B4D3E" /></View>
      ) : rfqs.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <Text className="text-center text-sm text-foreground-secondary">{t('rfq.no_rfqs')}</Text>
          <TouchableOpacity onPress={() => router.push('/rfq/new' as never)} className="rounded-lg bg-primary px-4 py-2.5">
            <Text className="text-sm font-semibold text-white">{t('rfq.post_cta')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerClassName="px-4 py-4 gap-3">
          {rfqs.map((r) => (
            <TouchableOpacity key={r.id} onPress={() => router.push(`/rfq/${r.id}` as never)} className="rounded-xl border border-border bg-surface p-4">
              <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>{r.title}</Text>
              <Text className="mt-1 text-xs text-foreground-secondary">{t('rfq.quotes_n', { n: r.quoteCount, max: r.maxQuotes })} · {t(`rfq.status_${r.status}`)}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}
 
