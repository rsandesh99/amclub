import { TouchableOpacity, Text } from 'react-native'
import { router } from 'expo-router'
import { useI18n } from '@/lib/i18n'

/** E13 — the avatar that opens the profile sheet (role switch, invoices, language, sign out). */
export function AvatarButton({ name }: { name: string | null | undefined }) {
  const { t } = useI18n()
  const initial = (name ?? '').trim().charAt(0).toUpperCase() || '•'
  return (
    <TouchableOpacity
      onPress={() => router.push('/profile' as never)}
      accessibilityRole="button"
      accessibilityLabel={t('profile_v3.open')}
      testID="avatar-button"
      className="h-9 w-9 items-center justify-center rounded-full bg-primary"
    >
      <Text className="text-sm font-bold text-white">{initial}</Text>
    </TouchableOpacity>
  )
}
