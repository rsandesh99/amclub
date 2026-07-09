import { ScrollView, Text, View, ActivityIndicator, TouchableOpacity } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect, useCallback } from 'react'
import { useLocalSearchParams, router, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { searchCatalog, type CatalogResult, type SearchParams } from '@/lib/api'
import { ResultCard } from '@/components/ResultCard'
import { ErrorState } from '@/components/ErrorState'
import { CATEGORY_LIST } from '@amclub/shared'

export default function CategoryScreen() {
  const { t, locale } = useI18n()
  const { slug } = useLocalSearchParams<{ slug: string }>()
  const category = CATEGORY_LIST.find((c) => c.slug === slug)
  const [sort, setSort] = useState<SearchParams['sort']>('rating')
  const [verifiedOnly, setVerifiedOnly] = useState(false)
  const [results, setResults] = useState<CatalogResult[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const run = useCallback(
    async (s: SearchParams['sort'], v: boolean) => {
      setLoading(true)
      const r = await searchCatalog({ category: slug, sort: s, verifiedOnly: v, limit: 24 })
      setFailed(!r.ok)
      setResults(r.results)
      setLoading(false)
    },
    [slug],
  )

  // Deferred so run()'s setState stays off the effect's synchronous path
  // (react-hooks/set-state-in-effect); run is also the filter-chip handler.
  useEffect(() => { void Promise.resolve().then(() => run('rating', false)) }, [run])

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <Stack.Screen options={{ title: category?.name_i18n[locale] ?? '' }} />
      <View className="flex-row items-center gap-2 border-b border-gray-200 bg-surface px-4 py-3">
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color="#1A1D1A" />
        </TouchableOpacity>
        <Text className="flex-1 text-lg font-bold text-foreground" numberOfLines={1}>
          {category?.name_i18n[locale] ?? ''}
        </Text>
      </View>

      <View className="flex-row gap-2 border-b border-gray-100 bg-surface px-4 py-2">
        {(['rating', 'price_asc', 'price_desc'] as const).map((s) => (
          <TouchableOpacity
            key={s}
            onPress={() => { setSort(s); run(s, verifiedOnly) }}
            className={`rounded-full border px-3 py-1 ${sort === s ? 'border-primary bg-primary/10' : 'border-gray-200'}`}
          >
            <Text className={`text-xs ${sort === s ? 'text-primary' : 'text-foreground-secondary'}`}>
              {t(`catalog.sort_${s}` as 'catalog.sort_rating')}
            </Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          onPress={() => { const v = !verifiedOnly; setVerifiedOnly(v); run(sort, v) }}
          className={`rounded-full border px-3 py-1 ${verifiedOnly ? 'border-trust bg-trust/10' : 'border-gray-200'}`}
        >
          <Text className={`text-xs ${verifiedOnly ? 'text-trust' : 'text-foreground-secondary'}`}>
            {t('catalog.verified_only')}
          </Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#1B4D3E" />
        </View>
      ) : failed ? (
        <ErrorState onRetry={() => run(sort, verifiedOnly)} />
      ) : results.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-sm text-foreground-secondary">{t('catalog.no_results')}</Text>
        </View>
      ) : (
        <ScrollView contentContainerClassName="px-4 py-4 gap-3">
          {results.map((r) => (
            <ResultCard key={r.packageId} result={r} />
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}
