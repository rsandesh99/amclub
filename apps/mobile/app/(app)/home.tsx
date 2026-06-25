import { ScrollView, Text, TouchableOpacity, View, Alert } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useEffect, useState } from 'react'
import { router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useI18n } from '@/lib/i18n'

export default function HomeScreen() {
  const { t } = useI18n()
  const [userName, setUserName] = useState('')

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      const name = user.user_metadata?.['full_name'] as string | undefined
      setUserName(name ?? '')
    })
  }, [])

  async function signOut() {
    const { error } = await supabase.auth.signOut()
    if (error) {
      Alert.alert('Error', error.message)
      return
    }
    router.replace('/(auth)/login')
  }

  const greeting = userName
    ? `${t('msme_home.greeting')}, ${userName}!`
    : t('msme_home.greeting') + '!'

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="px-6 py-8 gap-6">
        {/* Header */}
        <View className="flex-row items-center justify-between">
          <View>
            <Text className="text-2xl font-bold text-foreground">{greeting}</Text>
            <Text className="text-sm text-foreground-secondary">{t('msme_home.subtitle')}</Text>
          </View>
          <TouchableOpacity
            onPress={signOut}
            className="rounded-lg border border-gray-200 px-3 py-2"
          >
            <Text className="text-sm text-foreground-secondary">{t('common.sign_out')}</Text>
          </TouchableOpacity>
        </View>

        {/* Quick actions */}
        <View className="gap-3">
          <Text className="text-base font-semibold text-foreground">{t('msme_home.quick_actions')}</Text>
          <View className="flex-row gap-3">
            <TouchableOpacity className="flex-1 rounded-xl bg-primary p-5 items-center">
              <Text className="text-2xl">🔍</Text>
              <Text className="mt-2 text-sm font-medium text-white text-center">
                {t('msme_home.find_services')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity className="flex-1 rounded-xl border border-gray-200 bg-surface p-5 items-center">
              <Text className="text-2xl">📋</Text>
              <Text className="mt-2 text-sm font-medium text-foreground text-center">
                {t('msme_home.post_rfq')}
              </Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity className="rounded-xl border border-gray-200 bg-surface p-5 flex-row items-center gap-4">
            <Text className="text-2xl">📦</Text>
            <View>
              <Text className="text-sm font-medium text-foreground">{t('msme_home.my_orders')}</Text>
              <Text className="text-xs text-foreground-secondary">{t('msme_home.no_orders_yet')}</Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* Become a provider CTA */}
        <View className="rounded-xl border border-primary/20 bg-primary/5 p-5">
          <Text className="text-sm font-semibold text-primary">{t('msme_home.provider_cta_title')}</Text>
          <Text className="mt-1 text-xs text-foreground-secondary">{t('msme_home.provider_cta_desc')}</Text>
          <TouchableOpacity
            onPress={() => router.push('/(auth)/partner-signup')}
            className="mt-3 self-start rounded-lg bg-primary px-4 py-2"
          >
            <Text className="text-sm font-semibold text-white">{t('msme_home.provider_cta_btn')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}
