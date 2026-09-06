/**
 * AMC Mart product card — "Emerald & Brass": ivory surface with a thin brass
 * top rule, dark body text, and the price as a bold ≥20px numeral (the only
 * place a metallic tone appears on the card). Every rupee figure is the
 * server's own paise — rendered, never derived.
 */
import { Image, Text, View } from 'react-native'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { formatINRExact } from '@/lib/format'
import { colors } from '@/lib/theme'
import type { MartProduct } from '@/lib/api'
import { PressableCard } from '@/components/ui/PressableCard'

export function MartProductCard({ product }: { product: MartProduct }) {
  const { t } = useI18n()
  const thumb = product.imageUrls[0]
  const place = [product.seller.city, product.seller.state].filter(Boolean).join(', ')

  return (
    <PressableCard
      onPress={() => router.push(`/mart/${product.id}` as never)}
      accessibilityRole="button"
      accessibilityLabel={product.name}
      className="flex-row gap-3 overflow-hidden rounded-card border border-border border-t-2 border-t-brass bg-ivory p-3"
    >
      <View className="h-20 w-20 items-center justify-center overflow-hidden rounded-lg bg-muted">
        {thumb ? (
          <Image source={{ uri: thumb }} className="h-20 w-20" resizeMode="cover" accessibilityIgnoresInvertColors />
        ) : (
          <Ionicons name="cube-outline" size={28} color={colors.emerald} />
        )}
      </View>
      <View className="flex-1 gap-0.5">
        <Text className="text-sm font-semibold text-ink" numberOfLines={2}>{product.name}</Text>
        <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
          {product.seller.displayName}{place ? ` · ${place}` : ''}
        </Text>
        {product.list ? (
          <View className="mt-1">
            <View className="flex-row items-baseline gap-1">
              <Text className="text-xs text-foreground-secondary">{t('mart.from_price')}</Text>
              <Text className="text-lg font-bold text-emerald-ink">{formatINRExact(product.list.unit_price_paise)}</Text>
              <Text className="text-xs text-foreground-secondary">{t('mart.per_unit', { unit: product.unit })}</Text>
            </View>
            <Text className="text-xs font-medium text-emerald">
              {t('mart.itc_line', { amount: formatINRExact(product.list.unit_after_itc_paise) })}
            </Text>
          </View>
        ) : (
          <Text className="mt-1 text-xs text-foreground-secondary">{t('mart.unpriced')}</Text>
        )}
      </View>
    </PressableCard>
  )
}
