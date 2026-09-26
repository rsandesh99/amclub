import { Text, TouchableOpacity, View } from 'react-native'
import { useI18n, type Locale } from '@/lib/i18n'
import { savePreferredLocale } from '@/lib/api'

/** EN / हिं / తె pill toggle (STATUS_AUDIT H2; S3.4 adds te). Choice persists
 *  via SecureStore, and — when signed in — to the account (audit §5 item 10:
 *  email, SMS and WhatsApp follow the language the person reads). te renders
 *  English for untranslated keys (deep fallback). ta is not offered: the app
 *  has no Tamil messages yet (lib/i18n.tsx). */
const OPTIONS: { value: Locale; label: string }[] = [
  { value: 'en', label: 'EN' },
  { value: 'hi', label: 'हिं' },
  { value: 'te', label: 'తె' },
]

export function LocaleToggle() {
  const { locale, setLocale } = useI18n()
  const choose = (value: Locale) => {
    if (value === locale) return
    setLocale(value)
    void savePreferredLocale(value).catch(() => false)
  }
  return (
    <View className="flex-row overflow-hidden rounded-lg border border-gray-200">
      {OPTIONS.map(({ value, label }) => (
        <TouchableOpacity
          key={value}
          onPress={() => choose(value)}
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
