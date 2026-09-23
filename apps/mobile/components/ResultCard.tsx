import { View, Text } from 'react-native'
import { router } from 'expo-router'
import { useI18n } from '@/lib/i18n'
import { pickI18n, initials } from '@/lib/format'
import { PriceBlock } from './PriceBlock'
import { PressableCard } from './ui/PressableCard'
import type { CatalogResult } from '@/lib/api'

// Professional credential kind → display label (acronyms; locale-agnostic).
const CREDENTIAL_LABEL: Record<string, string> = {
  icai: 'ICAI', icsi: 'ICSI', bar_council: 'Bar Council', ca: 'CA', credential: 'Credential',
}

/** Mobile listing card — credential-first (§4.3): credential leads, rating secondary. */
export function ResultCard({ result }: { result: CatalogResult }) {
  const { t, locale } = useI18n()
  const title = pickI18n(result.titleI18n, locale)
  const credentialLabel = result.headlineCredential ? CREDENTIAL_LABEL[result.headlineCredential] : null

  return (
    <PressableCard
      onPress={() => router.push(`/package/${result.providerSlug}/${result.packageSlug}` as never)}
      className="gap-3 rounded-xl border border-border bg-surface p-4"
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
            {result.verified && <Text className="text-verified">✓</Text>}
          </View>
          {credentialLabel ? (
            <Text className="text-xs font-medium text-verified">
              {credentialLabel} · {t('catalog.verified')}
            </Text>
          ) : result.verified ? (
            <Text className="text-xs font-medium text-verified">{t('catalog.verified')}</Text>
          ) : null}
          <Text className="text-xs text-foreground-secondary">
            {result.avgRating > 0 ? `★ ${result.avgRating.toFixed(1)} (${result.reviewCount})` : t('catalog.new')}
          </Text>
        </View>
      </View>

      <Text className="text-sm font-medium leading-snug text-foreground" numberOfLines={2}>
        {title}
      </Text>

      <View className="flex-row flex-wrap items-center gap-1.5">
        <View className="rounded-full bg-muted px-2 py-0.5">
          <Text className="text-xs text-foreground-secondary">
            {result.deliveryDays} {t('catalog.days')}
          </Text>
        </View>
        <View className="rounded-full bg-muted px-2 py-0.5">
          <Text className="text-xs text-foreground-secondary">{result.state}</Text>
        </View>
      </View>

      <View className="border-t border-border pt-3">
        <PriceBlock
          pricePaise={result.pricePaise}
          discountBps={result.discountBps}
          memberExtraDiscountBps={result.memberExtraDiscountBps}
        />
      </View>
    </PressableCard>
  )
}
