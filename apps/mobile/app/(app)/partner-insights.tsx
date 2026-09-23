import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useI18n } from '@/lib/i18n'
import { fetchPartnerInsights, type PartnerInsightsView } from '@/lib/api'
import { ErrorState } from '@/components/ErrorState'
import { ScreenHeader } from '@/components/ScreenHeader'

/**
 * PRD Experience v3 E13 FR-13.2 (N29) — insights, read-only: the 8-week
 * funnel, why quotes were lost (counts; a median only when the server sends
 * one, n ≥ 5), decline reasons (n ≥ 3) and listing performance. The same
 * payload as the web page — the privacy gates are the server's.
 */
export default function PartnerInsightsScreen() {
  const { t } = useI18n()
  const [range, setRange] = useState<'7d' | '30d'>('30d')
  const [data, setData] = useState<PartnerInsightsView | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')

  const load = useCallback(async () => {
    setState('loading')
    const d = await fetchPartnerInsights(range)
    setData(d)
    setState(d ? 'ready' : 'failed')
  }, [range])
  useFocusEffect(useCallback(() => { void load() }, [load]))

  const max = Math.max(1, ...(data?.weeks ?? []).map((w) => w.matched))
  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ScreenHeader title={t('insights_v3.title')} />
      <View className="flex-row gap-2 px-4 pt-3" accessibilityRole="radiogroup">
        {(['7d', '30d'] as const).map((r) => (
          <TouchableOpacity key={r} onPress={() => setRange(r)} accessibilityRole="radio" accessibilityState={{ selected: range === r }} className={`rounded-full border px-3 py-1 ${range === r ? 'border-primary bg-primary/10' : 'border-gray-200'}`}>
            <Text className="text-xs text-foreground">{t(`insights_v3.range_${r}`)}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {state === 'failed' ? (
        <ErrorState onRetry={() => void load()} />
      ) : state === 'loading' || !data ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator size="large" color="#1B4D3E" /></View>
      ) : (
        <ScrollView contentContainerClassName="gap-5 px-4 py-4" testID="insights-v3">
          <View className="gap-2">
            <Text className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{t('insights_v3.weeks')}</Text>
            {data.weeks.map((w) => (
              <View key={w.week} className="gap-0.5">
                <Text className="text-[11px] text-foreground-secondary">{w.week} · {t('insights_v3.week_line', { matched: w.matched, quoted: w.quoted, won: w.won })}</Text>
                <View className="h-2 rounded-full bg-muted"><View className="h-2 rounded-full bg-primary" style={{ width: `${Math.round((w.matched / max) * 100)}%` }} /></View>
              </View>
            ))}
          </View>
          <View className="gap-1 rounded-xl border border-gray-200 bg-surface p-4">
            <Text className="text-sm font-semibold text-foreground">{t('insights_v3.lost_title')}</Text>
            <Text className="text-sm text-foreground">{data.loss.price.medianPct != null ? t('insights_v3.lost_price_median', { n: data.loss.price.n, of: data.loss.price.of, pct: data.loss.price.medianPct }) : t('insights_v3.lost_price', { n: data.loss.price.n, of: data.loss.price.of })}</Text>
            <Text className="text-sm text-foreground">{data.loss.delivery.medianDays != null ? t('insights_v3.lost_days_median', { n: data.loss.delivery.n, of: data.loss.delivery.of, days: data.loss.delivery.medianDays }) : t('insights_v3.lost_days', { n: data.loss.delivery.n, of: data.loss.delivery.of })}</Text>
          </View>
          {data.declineReasons.length > 0 && (
            <View className="gap-1">
              <Text className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{t('insights_v3.decline_reasons')}</Text>
              {data.declineReasons.map((d) => <Text key={d.reason} className="text-sm text-foreground">{t(`insights_v3.reason_${d.reason}`)} · {d.n}</Text>)}
            </View>
          )}
          {data.listings.length > 0 && (
            <View className="gap-1">
              <Text className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{t('insights_v3.listings')}</Text>
              {data.listings.map((l) => <Text key={l.packageId} className="text-sm text-foreground">{l.title} · {t('insights_v3.listing_line', { views: l.views, checkouts: l.checkouts, orders: l.orders })}</Text>)}
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}
