import { ScrollView, Text, TouchableOpacity, View, TextInput } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect } from 'react'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '@/lib/supabase'
import { useI18n } from '@/lib/i18n'
import { fetchUnreadCount, fetchMe } from '@/lib/api'
import { AvatarButton } from '@/components/AvatarButton'
import { LocaleToggle } from '@/components/LocaleToggle'
import { HeroBanner } from '@/components/HeroBanner'
import { HomeV3Block } from '@/components/HomeV3Block'
import { CATEGORY_LIST, pickLocale } from '@amclub/shared'

export default function HomeScreen() {
  const { t, locale } = useI18n()
  const [userName, setUserName] = useState('')
  const [q, setQ] = useState('')
  const [unread, setUnread] = useState(0)
  const [supportEnabled, setSupportEnabled] = useState(false)
  const [assistantEnabled, setAssistantEnabled] = useState(false)
  const [homeV3, setHomeV3] = useState(false)
  // E13 — the avatar opens the profile sheet (role switch, invoices, sign out) while `mobile` is on.
  const [mobileV3, setMobileV3] = useState(false)

  useEffect(() => {
    void (async () => {
      // S2.3 — the Help chat exists only for an enabled, cohorted user (the server decides).
      const me = await fetchMe()
      setSupportEnabled(me?.supportEnabled === true)
      // S3.1 — the buying assistant for an enabled, cohorted buyer (the server decides; the routes 404 for everyone else)
      setAssistantEnabled(me?.procurementEnabled === true)
      // Experience v3 E9 — the server decides (flag `home`).
      setHomeV3(me?.homeV3Enabled === true)
      setMobileV3(me?.mobileV3Enabled === true)
    })()
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
            <LocaleToggle />
            {assistantEnabled && (
              <TouchableOpacity onPress={() => router.push('/assistant' as never)} className="rounded-lg border border-gray-200 p-2" testID="assistant-entry" accessibilityLabel={t('assistant.title')}>
                <Ionicons name="chatbubbles-outline" size={18} color="#5C645C" />
              </TouchableOpacity>
            )}
            {supportEnabled && (
              <TouchableOpacity onPress={() => router.push('/support' as never)} className="rounded-lg border border-gray-200 p-2" testID="support-entry">
                <Ionicons name="help-circle-outline" size={18} color="#5C645C" />
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => router.push('/notifications' as never)} className="relative rounded-lg border border-gray-200 p-2">
              <Ionicons name="notifications-outline" size={18} color="#5C645C" />
              {unread > 0 && (
                <View className="absolute -right-1 -top-1 h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1">
                  <Text className="text-[10px] font-bold text-white">{unread > 9 ? '9+' : unread}</Text>
                </View>
              )}
            </TouchableOpacity>
            {mobileV3 ? (
              <AvatarButton name={userName} />
            ) : (
              <TouchableOpacity
                onPress={async () => { await supabase.auth.signOut(); router.replace('/(auth)/login') }}
                className="rounded-lg border border-gray-200 px-3 py-2"
              >
                <Text className="text-xs text-foreground-secondary">{t('common.sign_out')}</Text>
              </TouchableOpacity>
            )}
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

        {/* Experience v3 E9 — needs your action + buy again (the same payload as the web home) */}
        {homeV3 && <HomeV3Block />}

        {/* CMS hero (MOBILE_PARITY §3) — same /api/v1/cms/banners content as web */}
        <HeroBanner />

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
                <Text className="text-sm font-semibold text-foreground">{pickLocale(c.name_i18n, locale)}</Text>
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
