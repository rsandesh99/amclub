/**
 * Network-failure state with a retry affordance (STATUS_AUDIT H5 — the api.ts
 * silent-[] pattern used to render failures as empty states). Shown whenever
 * a list fetch reports !ok.
 */
import { Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { colors } from '@/lib/theme'

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n()
  return (
    <View className="flex-1 items-center justify-center gap-3 px-8">
      <Ionicons name="cloud-offline-outline" size={40} color={colors.foregroundSecondary} />
      <Text className="text-center text-sm font-medium text-foreground">{t('common.error')}</Text>
      <Text className="text-center text-xs text-foreground-secondary">{t('errors.network')}</Text>
      <TouchableOpacity onPress={onRetry} className="mt-1 rounded-xl bg-primary px-5 py-2.5">
        <Text className="text-sm font-semibold text-white">{t('common.retry')}</Text>
      </TouchableOpacity>
    </View>
  )
}
