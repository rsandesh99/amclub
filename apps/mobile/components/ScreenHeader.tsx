import { Text, TouchableOpacity, View } from 'react-native'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'

/** E13 — the plain back-arrow header the pushed provider / profile screens share. */
export function ScreenHeader({ title }: { title: string }) {
  const { t } = useI18n()
  return (
    <View className="flex-row items-center gap-2 border-b border-gray-200 bg-surface px-4 py-3">
      <TouchableOpacity onPress={() => router.back()} accessibilityLabel={t('common.back')} className="p-1"><Ionicons name="arrow-back" size={22} color="#1B4D3E" /></TouchableOpacity>
      <Text className="text-lg font-bold text-foreground">{title}</Text>
    </View>
  )
}
