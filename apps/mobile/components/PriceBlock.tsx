import { View, Text } from 'react-native'
import { useI18n } from '@/lib/i18n'
import { computePricing, formatINR } from '@/lib/format'

// E0 / U2 — memberships don't exist and checkout never applies the member
// discount, so the member line stays hidden until this is switched on.
const MEMBER_PRICING_ENABLED = process.env['EXPO_PUBLIC_MEMBER_PRICING_ENABLED'] === 'true'

/** Mobile price block — mirrors the web PriceBlock (§4.3 price transparency). */
export function PriceBlock({
  pricePaise,
  discountBps,
  memberExtraDiscountBps,
  large = false,
}: {
  pricePaise: number
  discountBps: number
  memberExtraDiscountBps: number
  large?: boolean
}) {
  const { t } = useI18n()
  const p = computePricing({ pricePaise, discountBps, memberExtraDiscountBps })

  return (
    <View className="gap-0.5">
      <View className="flex-row flex-wrap items-baseline gap-x-2">
        <Text className={`font-bold text-foreground ${large ? 'text-2xl' : 'text-lg'}`}>
          {formatINR(p.discountedPaise)}
        </Text>
        {p.hasDiscount && (
          <>
            <Text className={`text-foreground-secondary line-through ${large ? 'text-base' : 'text-sm'}`}>
              {formatINR(p.listPaise)}
            </Text>
            <View className="rounded-full bg-accent px-1.5 py-0.5">
              <Text className="text-xs font-bold text-foreground">
                {p.discountPct}% {t('catalog.off')}
              </Text>
            </View>
          </>
        )}
      </View>
      {MEMBER_PRICING_ENABLED && p.hasMemberExtra && (
        <Text className="text-xs font-medium text-primary">
          {formatINR(p.memberPaise)} · {t('catalog.members')} (+{p.memberExtraPct}%)
        </Text>
      )}
    </View>
  )
}
