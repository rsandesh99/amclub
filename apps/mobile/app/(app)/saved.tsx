import { ScrollView, Text, View, ActivityIndicator, TouchableOpacity } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useCallback } from 'react'
import { useFocusEffect, router } from 'expo-router'
import { useI18n } from '@/lib/i18n'
import { getSavedProviderIds } from '@/lib/api'
import { supabase } from '@/lib/supabase'
import { initials } from '@/lib/format'

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function SavedScreen() {
  const { t } = useI18n()
  const [providers, setProviders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const ids = await getSavedProviderIds()
    if (ids.length === 0) {
      setProviders([])
      setLoading(false)
      return
    }
    // Resolve provider summaries via the anon Supabase client (public-read).
    const { data } = await supabase
      .from('provider_profiles')
      .select('id, display_name, slug, state, avg_rating, review_count, completed_orders')
      .in('id', ids)
      .eq('status', 'active')
    setProviders(data ?? [])
    setLoading(false)
  }, [])

  useFocusEffect(
    useCallback(() => {
      load()
    }, [load]),
  )

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="border-b border-gray-200 bg-surface px-4 py-3">
        <Text className="text-lg font-bold text-foreground">{t('catalog.saved')}</Text>
      </View>
      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#1B4D3E" />
        </View>
      ) : providers.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-sm text-foreground-secondary">{t('catalog.saved_empty')}</Text>
        </View>
      ) : (
        <ScrollView contentContainerClassName="px-4 py-4 gap-3">
          {providers.map((p) => (
            <TouchableOpacity
              key={p.id}
              onPress={() => router.push(`/provider/${p.slug}` as never)}
              className="flex-row items-center gap-3 rounded-xl border border-gray-200 bg-surface p-4"
              activeOpacity={0.85}
            >
              <View className="h-11 w-11 items-center justify-center rounded-full bg-primary/10">
                <Text className="text-sm font-bold text-primary">{initials(p.display_name)}</Text>
              </View>
              <View className="flex-1">
                <Text className="text-sm font-semibold text-foreground">{p.display_name}</Text>
                <Text className="text-xs text-foreground-secondary">
                  {Number(p.avg_rating) > 0 ? `★ ${Number(p.avg_rating).toFixed(1)} (${p.review_count})` : t('catalog.new')} · {p.state}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */
