import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useEffect, useState, type ComponentProps } from 'react'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { mobileRolesOf, type MobileRole, type ProfileMeResponse } from '@amclub/shared'
import { supabase } from '@/lib/supabase'
import { useI18n } from '@/lib/i18n'
import { fetchMe } from '@/lib/api'
import { setMobileRole, useMobileRole } from '@/lib/role'
import { track } from '@/lib/analytics'
import { LocaleToggle } from '@/components/LocaleToggle'

function Row({ icon, label, onPress, testID }: { icon: ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void; testID?: string }) {
  return (
    <TouchableOpacity onPress={onPress} className="flex-row items-center gap-3 border-b border-gray-100 px-4 py-3.5" accessibilityRole="button" testID={testID}>
      <Ionicons name={icon} size={20} color="#5C645C" />
      <Text className="flex-1 text-sm text-foreground">{label}</Text>
      <Ionicons name="chevron-forward" size={16} color="#9CA3AF" />
    </TouchableOpacity>
  )
}

/**
 * PRD Experience v3 E13 — the profile (avatar) sheet: who is signed in, the
 * buyer / provider switch for an account with both (FR-13.1; remembered on
 * this device), invoices (buyer, FR-13.3), notifications, help, language and
 * sign out. Reads /profile/me only.
 */
export default function ProfileScreen() {
  const { t } = useI18n()
  const role = useMobileRole()
  const [me, setMe] = useState<Partial<ProfileMeResponse> | null>(null)

  useEffect(() => { void fetchMe().then((m) => setMe(m ?? {})) }, [])

  if (!me) return <View className="flex-1 items-center justify-center bg-background"><ActivityIndicator size="large" color="#1B4D3E" /></View>

  const roles = mobileRolesOf({ roles: me.roles ?? [], hasProviderProfile: me.hasProviderProfile === true, hasMsmeProfile: me.hasMsmeProfile === true })
  const switchTo = (r: MobileRole) => {
    if (r === role) return
    track('role_switched', { to: r, platform: 'android' })
    setMobileRole(r)
    router.replace((r === 'provider' ? '/partner' : '/home') as never)
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 border-b border-gray-200 bg-surface px-4 py-3">
        <TouchableOpacity onPress={() => router.back()} accessibilityLabel={t('common.back')} className="p-1"><Ionicons name="arrow-back" size={22} color="#1B4D3E" /></TouchableOpacity>
        <Text className="text-lg font-bold text-foreground">{t('profile_v3.title')}</Text>
      </View>
      <ScrollView contentContainerClassName="gap-5 py-4" testID="profile-v3">
        <View className="px-4">
          <Text className="text-xl font-bold text-foreground">{me.fullName ?? ''}</Text>
        </View>
        {roles.length > 1 && (
          <View className="gap-2 px-4">
            <Text className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{t('profile_v3.switch_label')}</Text>
            <View className="flex-row rounded-lg bg-muted p-1" accessibilityRole="radiogroup">
              {roles.map((r) => (
                <TouchableOpacity key={r} onPress={() => switchTo(r)} accessibilityRole="radio" accessibilityState={{ selected: role === r }} className={`flex-1 items-center rounded-md py-2 ${role === r ? 'bg-surface' : ''}`} testID={`role-${r}`}>
                  <Text className={`text-sm font-medium ${role === r ? 'text-foreground' : 'text-foreground-secondary'}`}>{t(`profile_v3.role_${r}`)}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
        <View className="border-t border-gray-100 bg-surface">
          {role !== 'provider' && me.hasMsmeProfile && <Row icon="receipt-outline" label={t('profile_v3.invoices')} onPress={() => router.push('/invoices' as never)} testID="profile-invoices" />}
          {role === 'provider' && <Row icon="calendar-outline" label={t('profile_v3.provider_profile')} onPress={() => router.push('/partner-profile' as never)} testID="profile-provider" />}
          {role === 'provider' && <Row icon="star-outline" label={t('profile_v3.reviews')} onPress={() => router.push('/partner-reviews' as never)} />}
          {role === 'provider' && <Row icon="stats-chart-outline" label={t('profile_v3.insights')} onPress={() => router.push('/partner-insights' as never)} />}
          <Row icon="notifications-outline" label={t('profile_v3.notifications')} onPress={() => router.push('/notifications' as never)} />
          {me.supportEnabled && <Row icon="help-circle-outline" label={t('profile_v3.help')} onPress={() => router.push('/support' as never)} />}
        </View>
        <View className="flex-row items-center justify-between px-4">
          <Text className="text-sm text-foreground">{t('profile_v3.language')}</Text>
          <LocaleToggle />
        </View>
        <View className="px-4">
          <TouchableOpacity onPress={async () => { await supabase.auth.signOut(); router.replace('/(auth)/login') }} className="items-center rounded-lg border border-gray-200 py-3" accessibilityRole="button">
            <Text className="text-sm font-medium text-foreground-secondary">{t('common.sign_out')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}
