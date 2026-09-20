import { ScrollView, Text, View, TouchableOpacity, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useCallback } from 'react'
import { useFocusEffect, router } from 'expo-router'
import { useI18n } from '@/lib/i18n'
import { fetchMatchedRfqs } from '@/lib/api'

 
export default function PartnerRfqsScreen() {
  const { t } = useI18n()
  const [rfqs, setRfqs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useFocusEffect(useCallback(() => {
    setLoading(true)
    fetchMatchedRfqs().then((r) => { setRfqs(r); setLoading(false) })
  }, []))

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="border-b border-border bg-surface px-4 py-3">
        <Text className="text-lg font-bold text-foreground">{t('rfq.inbox_title')}</Text>
      </View>
      {loading ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator size="large" color="#1B4D3E" /></View>
      ) : rfqs.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8"><Text className="text-center text-sm text-foreground-secondary">{t('rfq.no_matched')}</Text></View>
      ) : (
        <ScrollView contentContainerClassName="px-4 py-4 gap-3">
          {rfqs.map((r) => (
            <TouchableOpacity key={r.rfqId} onPress={() => router.push(`/partner-rfq/${r.rfqId}` as never)} className="flex-row items-center justify-between rounded-xl border border-border bg-surface p-4">
              <View className="flex-1">
                <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>{r.title}</Text>
                <Text className="mt-1 text-xs text-foreground-secondary">{t('rfq.quotes_n', { n: r.quoteCount, max: r.maxQuotes })}</Text>
              </View>
              {/* S1.3 — my unanswered question on this RFQ (derived, never a status). */}
              {r.hasUnansweredMine ? <View className="mr-2 rounded-full bg-[#f5ebdd] px-2 py-1"><Text className="text-[11px] font-medium text-[#b45309]">{t('rfq.clarify_mine_open_chip')}</Text></View> : null}
              {r.quoted ? <View className="rounded-full bg-success/10 px-2 py-1"><Text className="text-[11px] font-medium text-success">{t('rfq.quoted_badge')}</Text></View> : null}
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}
 
