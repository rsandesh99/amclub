import { View, Text, TouchableOpacity } from 'react-native'
import { router } from 'expo-router'
import { useI18n } from '@/lib/i18n'
import { pickI18n, initials } from '@/lib/format'
import { PriceBlock } from './PriceBlock'
import type { CatalogResult } from '@/lib/api'

/** Mobile listing card — provider identity + trust + package title + price. */
export function ResultCard({ result }: { result: CatalogResult }) {
  const { t, locale } = useI18n()
  const title = pickI18n(result.titleI18n, locale)

  return (
    <TouchableOpacity
      onPress={() => router.push(`/package/${result.providerSlug}/${result.packageSlug}` as never)}
      activeOpacity={0.85}
      className="gap-3 rounded-xl border border-gray-200 bg-surface p-4"
    >
      <View className="flex-row items-center gap-3">
        <View className="h-9 w-9 items-center justify-center rounded-full bg-primary/10">
          <Text className="text-xs font-bold text-primary">{initials(result.displayName)}</Text>
        </View>
        <View className="flex-1">
          <View className="flex-row items-center gap-1">
            <Text className="flex-1 text-sm font-semibold text-foreground" numberOfLines={1}>
              {result.displayName}
            </Text>
            {result.verified && <Text className="text-trust">✓</Text>}
          </View>
          <Text className="text-xs text-foreground-secondary">
            {result.avgRating > 0 ? `★ ${result.avgRating.toFixed(1)} (${result.reviewCount})` : t('catalog.new')}
          </Text>
        </View>
        {result.topRated && (
          <View className="rounded-full bg-accent/15 px-2 py-0.5">
            <Text className="text-xs font-semibold text-foreground">{t('catalog.top_rated')}</Text>
          </View>
        )}
      </View>

      <Text className="text-sm font-medium leading-snug text-foreground" numberOfLines={2}>
        {title}
      </Text>

      <View className="flex-row flex-wrap items-center gap-1.5">
        <View className="rounded-full bg-gray-100 px-2 py-0.5">
          <Text className="text-xs text-foreground-secondary">
            {result.deliveryDays} {t('catalog.days')}
          </Text>
        </View>
        <View className="rounded-full bg-gray-100 px-2 py-0.5">
          <Text className="text-xs text-foreground-secondary">{result.state}</Text>
        </View>
      </View>

      <View className="border-t border-gray-100 pt-3">
        <PriceBlock
          pricePaise={result.pricePaise}
          discountBps={result.discountBps}
          memberExtraDiscountBps={result.memberExtraDiscountBps}
        />
      </View>
    </TouchableOpacity>
  )
}
