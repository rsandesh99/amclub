import { Alert, ScrollView, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import Constants from 'expo-constants'
import * as WebBrowser from 'expo-web-browser'
import { useI18n } from '@/lib/i18n'

/** The web app is served from the same origin as /api/v1 (see lib/api.ts). */
const WEB_URL =
  (Constants.expoConfig?.extra?.['apiUrl'] as string | undefined) ??
  process.env['EXPO_PUBLIC_API_URL'] ??
  'http://localhost:3000'

/**
 * "Become a provider" (UX audit C6). Provider onboarding (GST, KYC, bank
 * verification) is web-only for now, so this screen explains that and opens
 * the web provider signup in the locale the app is using. Web routing uses
 * `localePrefix: 'as-needed'` — en has no prefix.
 */
export default function PartnerSignupScreen() {
  const { t, locale } = useI18n()
  const url = `${WEB_URL.replace(/\/$/, '')}${locale === 'en' ? '' : `/${locale}`}/partner/signup`

  async function openWeb() {
    try {
      await WebBrowser.openBrowserAsync(url)
    } catch {
      Alert.alert(t('common.error'), t('auth.partner_signup_open_failed', { url }))
    }
  }

  function goBack() {
    if (router.canGoBack()) router.back()
    else router.replace('/(app)/home' as never)
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="flex-grow justify-center px-6 py-10">
        <View className="mb-8 items-center">
          <Text className="text-3xl font-bold text-primary">AMClub</Text>
          <Text accessibilityRole="header" className="mt-3 text-center text-2xl font-bold text-foreground">
            {t('auth.partner_signup_title')}
          </Text>
        </View>

        <View className="gap-3 rounded-xl border border-gray-200 bg-surface p-5">
          <Text className="text-base leading-6 text-foreground">{t('auth.partner_signup_body')}</Text>
          <Text className="text-base leading-6 text-foreground-secondary">{t('auth.partner_signup_same_number')}</Text>
        </View>

        <View className="mt-6 gap-3">
          <TouchableOpacity
            onPress={() => void openWeb()}
            accessibilityRole="link"
            className="min-h-[48px] items-center justify-center rounded-xl bg-primary py-4"
          >
            <Text className="text-base font-semibold text-white">{t('auth.partner_signup_open_web')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={goBack}
            accessibilityRole="button"
            className="min-h-[48px] items-center justify-center rounded-xl border border-gray-200 bg-surface py-4"
          >
            <Text className="text-base font-semibold text-foreground">{t('common.back')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}
