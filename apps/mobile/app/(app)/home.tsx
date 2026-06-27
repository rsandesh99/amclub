import { ScrollView, Text, TouchableOpacity, View, TextInput } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect } from 'react'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '@/lib/supabase'
import { useI18n } from '@/lib/i18n'
import { fetchUnreadCount } from '@/lib/api'
import { CATEGORY_LIST } from '@amclub/shared'

export default function HomeScreen() {
  const { t, locale } = useI18n()
  const [userName, setUserName] = useState('')
  const [q, setQ] = useState('')
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setUserName((user?.user_metadata?.['full_name'] as string | undefined) ?? '')
    })
    fetchUnreadCount().then(setUnread)
  }, [])

  function submitSearch() {
    router.push(`/search?query=${encodeURIComponent(q.trim())}` as never)
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ScrollView contentContainerClassName="px-4 py-4 gap-6">
        <View className="flex-row items-center justify-between">
          <View>
            <Text className="text-xl font-bold text-foreground">
              {t('msme_home.greeting')}{userName ? `, ${userName}` : ''}
            </Text>
            <Text className="text-sm text-foreground-secondary">{t('msme_home.subtitle')}</Text>
          </View>
          <View className="flex-row items-center gap-2">
            <TouchableOpacity onPress={() => router.push('/notifications' as never)} className="relative rounded-lg border border-gray-200 p-2">
              <Ionicons name="notifications-outline" size={18} color="#5C645C" />
              {unread > 0 && (
                <View className="absolute -right-1 -top-1 h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1">
                  <Text className="text-[10px] font-bold text-white">{unread > 9 ? '9+' : unread}</Text>
                </View>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={async () => { await supabase.auth.signOut(); router.replace('/(auth)/login') }}
              className="rounded-lg border border-gray-200 px-3 py-2"
            >
              <Text className="text-xs text-foreground-secondary">{t('common.sign_out')}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Search */}
        <View className="flex-row items-center gap-2 rounded-xl border border-gray-200 bg-surface px-3 py-1.5">
          <Ionicons name="search-outline" size={18} color="#5C645C" />
          <TextInput
            className="flex-1 text-sm text-foreground"
            placeholder={t('catalog.search_placeholder')}
            placeholderTextColor="#9CA3AF"
            value={q}
            onChangeText={setQ}
            onSubmitEditing={submitSearch}
            returnKeyType="search"
          />
          <TouchableOpacity onPress={submitSearch} className="rounded-lg bg-primary px-3 py-2">
            <Text className="text-xs font-semibold text-white">{t('catalog.search_btn')}</Text>
          </TouchableOpacity>
        </View>

        {/* Category grid */}
        <View className="gap-3">
          <Text className="text-base font-semibold text-foreground">{t('msme_home.explore_categories')}</Text>
          <View className="flex-row flex-wrap gap-3">
            {CATEGORY_LIST.map((c) => (
              <TouchableOpacity
                key={c.slug}
                onPress={() => router.push(`/category/${c.slug}` as never)}
                className="w-[47%] gap-2 rounded-xl border border-gray-200 bg-surface p-4"
                activeOpacity={0.85}
              >
                <View className="h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <Ionicons name="cube-outline" size={20} color="#1B4D3E" />
                </View>
                <Text className="text-sm font-semibold text-foreground">{c.name_i18n[locale]}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* RFQ entry */}
        <TouchableOpacity onPress={() => router.push('/rfq' as never)} className="flex-row items-center justify-between rounded-xl border border-accent/30 bg-accent/5 p-5">
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">{t('rfq.new_title')}</Text>
            <Text className="mt-0.5 text-xs text-foreground-secondary">{t('rfq.list_title')}</Text>
          </View>
          <Text className="text-2xl">📋</Text>
        </TouchableOpacity>

        {/* Provider CTA */}
        <View className="rounded-xl border border-primary/20 bg-primary/5 p-5">
          <Text className="text-sm font-semibold text-primary">{t('msme_home.provider_cta_title')}</Text>
          <Text className="mt-1 text-xs text-foreground-secondary">{t('msme_home.provider_cta_desc')}</Text>
          <TouchableOpacity
            onPress={() => router.push('/(auth)/partner-signup' as never)}
            className="mt-3 self-start rounded-lg bg-primary px-4 py-2"
          >
            <Text className="text-sm font-semibold text-white">{t('msme_home.provider_cta_btn')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}
