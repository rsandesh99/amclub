import { ScrollView, Text, TextInput, View, ActivityIndicator, TouchableOpacity } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect, useCallback } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { INDIAN_STATES } from '@amclub/shared'
import { useI18n } from '@/lib/i18n'
import { searchCatalog, type CatalogResult, type SearchParams } from '@/lib/api'
import { ResultCard } from '@/components/ResultCard'
import { ErrorState } from '@/components/ErrorState'
import { Select } from '@/components/ui/Select'
import { colors } from '@/lib/theme'

export default function SearchScreen() {
  const { t } = useI18n()
  const params = useLocalSearchParams<{ query?: string }>()
  const [q, setQ] = useState(params.query ?? '')
  const [sort, setSort] = useState<SearchParams['sort']>('rating')
  const [verifiedOnly, setVerifiedOnly] = useState(false)
  const [state, setState] = useState('')
  const [results, setResults] = useState<CatalogResult[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const run = useCallback(async (query: string, s: SearchParams['sort'], v: boolean, st: string) => {
    setLoading(true)
    const r = await searchCatalog({ query, sort: s, verifiedOnly: v, ...(st ? { state: st } : {}), limit: 24 })
    setFailed(!r.ok)
    setResults(r.results)
    setTotal(r.total)
    setLoading(false)
  }, [])

  // Deferred so run()'s setState stays off the effect's synchronous path
  // (react-hooks/set-state-in-effect); run is also the submit handler.
  useEffect(() => {
    void Promise.resolve().then(() => run(params.query ?? '', 'rating', false, ''))
  }, [params.query, run])

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="border-b border-gray-200 bg-surface px-4 py-3 gap-3">
        <View className="flex-row items-center gap-2 rounded-xl border border-gray-200 px-3 py-1.5">
          <Ionicons name="search-outline" size={18} color={colors.foregroundSecondary} />
          <TextInput
            className="flex-1 text-sm text-foreground"
            placeholder={t('catalog.search_placeholder')}
            placeholderTextColor="#9CA3AF"
            value={q}
            onChangeText={setQ}
            onSubmitEditing={() => run(q.trim(), sort, verifiedOnly, state)}
            returnKeyType="search"
            autoFocus={!params.query}
          />
        </View>
        <View className="flex-row gap-2">
          {(['rating', 'price_asc', 'price_desc'] as const).map((s) => (
            <TouchableOpacity
              key={s}
              onPress={() => { setSort(s); run(q.trim(), s, verifiedOnly, state) }}
              className={`rounded-full border px-3 py-1 ${sort === s ? 'border-primary bg-primary/10' : 'border-gray-200'}`}
            >
              <Text className={`text-xs ${sort === s ? 'text-primary' : 'text-foreground-secondary'}`}>
                {t(`catalog.sort_${s}` as 'catalog.sort_rating')}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            onPress={() => { const v = !verifiedOnly; setVerifiedOnly(v); run(q.trim(), sort, v, state) }}
            className={`rounded-full border px-3 py-1 ${verifiedOnly ? 'border-trust bg-trust/10' : 'border-gray-200'}`}
          >
            <Text className={`text-xs ${verifiedOnly ? 'text-trust' : 'text-foreground-secondary'}`}>
              {t('catalog.verified_only')}
            </Text>
          </TouchableOpacity>
        </View>
        {/* State filter — brand Select (MOBILE_PARITY §2), same filter web's listing controls offer. */}
        <Select
          value={state}
          placeholder={t('catalog.state_filter')}
          accessibilityLabel={t('catalog.state_filter')}
          options={[{ value: '', label: t('catalog.all_states') }, ...INDIAN_STATES.map((s) => ({ value: s.value, label: s.label }))]}
          onChange={(st) => { setState(st); run(q.trim(), sort, verifiedOnly, st) }}
        />
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : failed ? (
        <ErrorState onRetry={() => run(q.trim(), sort, verifiedOnly, state)} />
      ) : results.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-sm text-foreground-secondary">{t('catalog.no_results')}</Text>
        </View>
      ) : (
        <ScrollView contentContainerClassName="px-4 py-4 gap-3">
          <Text className="text-xs text-foreground-secondary">{total} {t('catalog.results_count')}</Text>
          {results.map((r) => (
            <ResultCard key={r.packageId} result={r} />
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}
