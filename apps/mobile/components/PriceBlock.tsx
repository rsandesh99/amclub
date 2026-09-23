import { View, Text } from 'react-native'
import type { PriceDisplay } from '@amclub/shared'
import { useI18n } from '@/lib/i18n'
import { formatINR } from '@/lib/format'

// E0 / U2 — memberships don't exist and checkout never applies the member
// discount, so the member line stays hidden until this is switched on.
const MEMBER_PRICING_ENABLED = process.env['EXPO_PUBLIC_MEMBER_PRICING_ENABLED'] === 'true'

/**
 * Mobile price block — mirrors the web PriceBlock (§4.3 price transparency).
 * Experience v3 N16: renders ONLY the server's `display` from /api/v1 (the
 * same computeOrderAmounts checkout charges with); no money math here.
 */
export function PriceBlock({ display, large = false }: { display: PriceDisplay; large?: boolean }) {
  const { t } = useI18n()

  return (
    <View className="gap-0.5">
      <View className="flex-row flex-wrap items-baseline gap-x-2">
        <Text className={`font-bold text-foreground ${large ? 'text-2xl' : 'text-lg'}`}>
          {formatINR(display.taxablePaise)}
        </Text>
        {display.discountPct > 0 && (
          <>
            <Text className={`text-foreground-secondary line-through ${large ? 'text-base' : 'text-sm'}`}>
              {formatINR(display.listPaise)}
            </Text>
            <View className="rounded-full bg-accent px-1.5 py-0.5">
              <Text className="text-xs font-bold text-foreground">
                {display.discountPct}% {t('catalog.off')}
              </Text>
            </View>
          </>
        )}
      </View>
      {MEMBER_PRICING_ENABLED && display.memberPaise !== null && (
        <Text className="text-xs font-medium text-primary">
          {formatINR(display.memberPaise)} · {t('catalog.members')} (+{display.memberExtraPct}%)
        </Text>
      )}
    </View>
  )
}
