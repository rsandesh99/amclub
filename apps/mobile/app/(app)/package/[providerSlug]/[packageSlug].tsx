import { ScrollView, Text, View, ActivityIndicator, TouchableOpacity, Alert } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect } from 'react'
import { useLocalSearchParams, router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { fetchPackage } from '@/lib/api'
import { pickI18n } from '@/lib/format'
import { PriceBlock } from '@/components/PriceBlock'

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function PackageScreen() {
  const { t, locale } = useI18n()
  const { providerSlug, packageSlug } = useLocalSearchParams<{ providerSlug: string; packageSlug: string }>()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchPackage(providerSlug, packageSlug).then((d) => { setData(d); setLoading(false) })
  }, [providerSlug, packageSlug])

  if (loading) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" color="#1B4D3E" />
      </SafeAreaView>
    )
  }
  if (!data?.pkg) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background">
        <Text className="text-foreground-secondary">Not found</Text>
      </SafeAreaView>
    )
  }

  const pkg = data.pkg
  const provider = data.provider
  const title = pickI18n(pkg.titleI18n, locale)

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 border-b border-gray-200 bg-surface px-4 py-3">
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color="#1A1D1A" />
        </TouchableOpacity>
        <Text className="flex-1 text-base font-bold text-foreground" numberOfLines={1}>{title}</Text>
      </View>

      <ScrollView contentContainerClassName="px-4 py-4 gap-5 pb-28">
        <Text className="text-xl font-bold text-foreground">{title}</Text>
        <TouchableOpacity
          onPress={() => router.push(`/provider/${provider.slug}` as never)}
          className="flex-row items-center gap-2"
        >
          <Text className="text-sm font-medium text-primary">{provider.displayName}</Text>
          {provider.badges?.length > 0 && <Text className="text-trust">✓</Text>}
          <Text className="text-xs text-foreground-secondary">
            {provider.avgRating > 0 ? `★ ${provider.avgRating.toFixed(1)}` : ''}
          </Text>
        </TouchableOpacity>

        <View className="rounded-xl border border-gray-200 bg-surface p-4">
          <PriceBlock
            pricePaise={pkg.pricePaise}
            discountBps={pkg.discountBps}
            memberExtraDiscountBps={pkg.memberExtraDiscountBps}
            large
          />
          <Text className="mt-2 text-xs text-foreground-secondary">
            {pkg.deliveryDays} {t('catalog.days')}
          </Text>
        </View>

        {/* Scope included */}
        <View>
          <Text className="mb-2 text-base font-bold text-foreground">{t('catalog.whats_included')}</Text>
          {(pkg.scopeIncluded ?? []).map((item: string, i: number) => (
            <View key={i} className="mb-1 flex-row gap-2">
              <Text className="text-success">✓</Text>
              <Text className="flex-1 text-sm text-foreground">{item}</Text>
            </View>
          ))}
        </View>

        {/* Deliverables */}
        {(pkg.deliverables ?? []).length > 0 && (
          <View>
            <Text className="mb-2 text-base font-bold text-foreground">{t('catalog.deliverables')}</Text>
            {pkg.deliverables.map((item: string, i: number) => (
              <View key={i} className="mb-1 flex-row gap-2">
                <Text className="text-primary">•</Text>
                <Text className="flex-1 text-sm text-foreground">{item}</Text>
              </View>
            ))}
          </View>
        )}

        {/* FAQs */}
        {(pkg.faqs ?? []).length > 0 && (
          <View>
            <Text className="mb-2 text-base font-bold text-foreground">FAQs</Text>
            {pkg.faqs.map((f: any, i: number) => (
              <View key={i} className="mb-2">
                <Text className="text-sm font-medium text-foreground">{f.q}</Text>
                <Text className="text-sm text-foreground-secondary">{f.a}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Sticky Buy Now (auth wall handled by web login on the deep link) */}
      <View className="absolute inset-x-0 bottom-0 border-t border-gray-200 bg-surface px-4 py-3">
        <TouchableOpacity
          onPress={() => router.push(`/checkout/${pkg.id}?providerSlug=${providerSlug}&packageSlug=${packageSlug}` as never)}
          className="items-center rounded-xl bg-primary py-3"
        >
          <Text className="text-base font-semibold text-white">{t('catalog.buy_now')}</Text>
        </TouchableOpacity>
        <Text className="mt-1 text-center text-xs text-foreground-secondary">{t('catalog.buy_now_note')}</Text>
      </View>
    </SafeAreaView>
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */
