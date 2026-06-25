import { ScrollView, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useI18n } from '@/lib/i18n'
import { ORDER_STATUSES, CATEGORY_LIST } from '@amclub/shared'

export default function HelloWorldScreen() {
  const { t, locale, setLocale } = useI18n()

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="items-center gap-6 p-6 pb-12">
        {/* AMClub brand */}
        <View className="items-center gap-2 pt-4">
          <Text className="text-3xl font-bold text-primary">{t('hello.title')}</Text>
          <Text className="text-sm text-foreground-secondary text-center max-w-xs">
            {t('hello.subtitle')}
          </Text>
        </View>

        {/* Locale switcher — proves i18n works */}
        <View className="flex-row items-center gap-3 rounded-full border border-gray-200 bg-surface px-5 py-3 shadow-sm">
          <Text className="text-xs text-foreground-secondary">{t('locale.switch')}:</Text>
          <TouchableOpacity
            onPress={() => setLocale('en')}
            className={`rounded-full px-4 py-2 ${locale === 'en' ? 'bg-primary' : 'bg-transparent'}`}
          >
            <Text
              className={`text-sm font-medium ${locale === 'en' ? 'text-white' : 'text-primary'}`}
            >
              {t('locale.en')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setLocale('hi')}
            className={`rounded-full px-4 py-2 ${locale === 'hi' ? 'bg-primary' : 'bg-transparent'}`}
          >
            <Text
              className={`text-sm font-medium ${locale === 'hi' ? 'text-white' : 'text-primary'}`}
            >
              {t('locale.hi')}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Proves @amclub/shared ORDER_STATUSES import works */}
        <View className="w-full rounded-xl border border-gray-200 bg-surface p-5 shadow-sm">
          <Text className="mb-3 text-xs font-semibold uppercase tracking-wide text-foreground-secondary">
            {t('hello.shared_proof')}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {ORDER_STATUSES.map((status) => (
              <View key={status} className="rounded-full bg-primary/10 px-3 py-1">
                <Text className="text-xs font-medium text-primary">{status}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Proves CATEGORY_LIST import works */}
        <View className="w-full rounded-xl border border-gray-200 bg-surface p-5 shadow-sm">
          <Text className="mb-3 text-xs font-semibold uppercase tracking-wide text-foreground-secondary">
            {CATEGORY_LIST.length} categories (from @amclub/shared):
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {CATEGORY_LIST.map((cat) => (
              <View key={cat.slug} className="rounded-full border border-yellow-300 bg-yellow-50 px-3 py-1">
                <Text className="text-xs font-medium text-foreground">
                  {cat.name_i18n[locale]}
                </Text>
              </View>
            ))}
          </View>
        </View>

        <Text className="text-xs text-foreground-secondary">{t('hello.mobile_note')}</Text>
      </ScrollView>
    </SafeAreaView>
  )
}
