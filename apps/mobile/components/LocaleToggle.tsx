import { Text, TouchableOpacity, View } from 'react-native'
import { useI18n, type Locale } from '@/lib/i18n'

/** EN / हिं / తె pill toggle (STATUS_AUDIT H2; S3.4 adds te). Choice persists
 *  via SecureStore. te renders English for untranslated keys (deep fallback). */
const OPTIONS: { value: Locale; label: string }[] = [
  { value: 'en', label: 'EN' },
  { value: 'hi', label: 'हिं' },
  { value: 'te', label: 'తె' },
]

export function LocaleToggle() {
  const { locale, setLocale } = useI18n()
  return (
    <View className="flex-row overflow-hidden rounded-lg border border-gray-200">
      {OPTIONS.map(({ value, label }) => (
        <TouchableOpacity
          key={value}
          onPress={() => setLocale(value)}
          accessibilityRole="button"
          accessibilityState={{ selected: locale === value }}
          className={`px-2.5 py-2 ${locale === value ? 'bg-primary' : 'bg-surface'}`}
        >
          <Text className={`text-xs font-semibold ${locale === value ? 'text-white' : 'text-foreground-secondary'}`}>
            {label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  )
}
