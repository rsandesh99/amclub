import { Linking, ScrollView, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useEffect, useState, type ComponentProps } from 'react'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { fetchMe } from '@/lib/api'
import { track } from '@/lib/analytics'
import { ScreenHeader } from '@/components/ScreenHeader'
import { GRIEVANCE_OFFICER, GRIEVANCE_SLA, OFFICIAL_WHATSAPP, OFFICIAL_WHATSAPP_HREF, SUPPORT_EMAIL, webPageUrl } from '@/lib/official'

type IconName = ComponentProps<typeof Ionicons>['name']

function Row({ icon, label, sub, onPress, testID }: { icon: IconName; label: string; sub?: string; onPress: () => void; testID?: string }) {
  return (
    <TouchableOpacity onPress={onPress} className="min-h-[48px] flex-row items-center gap-3 border-b border-gray-100 px-4 py-3" accessibilityRole="button" testID={testID}>
      <Ionicons name={icon} size={20} color="#1B4D3E" />
      <View className="flex-1">
        <Text className="text-sm font-medium text-foreground">{label}</Text>
        {sub ? <Text className="text-xs text-foreground-secondary">{sub}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color="#9CA3AF" />
    </TouchableOpacity>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="px-4 text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{title}</Text>
      <View className="border-t border-gray-100 bg-surface">{children}</View>
    </View>
  )
}

/**
 * Help for everyone (audit §7: mobile showed Help only to the agent cohort, so
 * everyone else had no contact or grievance path in the app). Contact on the
 * ONE official WhatsApp number and email, the FAQ, the safety page, settings,
 * and the Grievance Officer. The assistant chat stays cohort-only.
 */
export default function HelpScreen() {
  const { t, locale } = useI18n()
  const [supportEnabled, setSupportEnabled] = useState(false)

  useEffect(() => {
    void fetchMe().then((m) => setSupportEnabled(m?.supportEnabled === true))
  }, [])

  const open = (target: string, url: string) => {
    track('help_link_opened', { target, platform: 'android' })
    void Linking.openURL(url).catch(() => {})
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ScreenHeader title={t('help_center.title')} />
      <ScrollView contentContainerClassName="gap-5 py-4" testID="help-screen">
        <Text className="px-4 text-sm text-foreground-secondary">{t('help_center.subtitle')}</Text>

        {supportEnabled && (
          <Section title={t('help_center.assistant_section')}>
            <Row icon="chatbubbles-outline" label={t('help_center.assistant_chat')} sub={t('support.tile_sub')} onPress={() => router.push('/support' as never)} testID="help-assistant" />
          </Section>
        )}

        <Section title={t('help_center.contact_section')}>
          <Row icon="logo-whatsapp" label={t('help_center.whatsapp_us')} sub={OFFICIAL_WHATSAPP.display} onPress={() => open('whatsapp', OFFICIAL_WHATSAPP_HREF)} testID="help-whatsapp" />
          <Row icon="mail-outline" label={t('help_center.email_us')} sub={SUPPORT_EMAIL} onPress={() => open('email', `mailto:${SUPPORT_EMAIL}`)} testID="help-email" />
          <View className="flex-row items-center gap-3 px-4 py-3">
            <Ionicons name="time-outline" size={20} color="#5C645C" />
            <Text className="flex-1 text-xs text-foreground-secondary">{t('help_center.hours')}</Text>
          </View>
        </Section>

        <Section title={t('help_center.more_section')}>
          <Row icon="help-circle-outline" label={t('help_center.faq')} onPress={() => open('faq', webPageUrl('/help', locale))} testID="help-faq" />
          <Row icon="shield-checkmark-outline" label={t('help_center.safety')} sub={t('help_center.safety_sub')} onPress={() => open('safety', webPageUrl('/help/whatsapp-safety', locale))} testID="help-safety" />
          <Row icon="logo-whatsapp" label={t('profile_v3.whatsapp')} onPress={() => router.push('/whatsapp-settings' as never)} testID="help-whatsapp-settings" />
          <Row icon="notifications-outline" label={t('profile_v3.notification_settings')} onPress={() => router.push('/notification-settings' as never)} />
          <Row icon="lock-closed-outline" label={t('profile_v3.privacy')} onPress={() => router.push('/privacy' as never)} testID="help-privacy" />
        </Section>

        <Section title={t('help_center.grievance_section')}>
          <View className="gap-1 px-4 py-3" testID="help-grievance">
            <Text className="text-sm font-semibold text-foreground">{GRIEVANCE_OFFICER.name}</Text>
            <Text className="text-xs text-foreground-secondary">{GRIEVANCE_OFFICER.designation} · {GRIEVANCE_OFFICER.organisation}</Text>
            <Text className="mt-1 text-xs text-foreground-secondary">
              {t('help_center.grievance_commitments', { hours: GRIEVANCE_SLA.acknowledgeHours, days: GRIEVANCE_SLA.resolveDays })}
            </Text>
          </View>
          <Row icon="mail-outline" label={GRIEVANCE_OFFICER.email} onPress={() => open('grievance_email', `mailto:${GRIEVANCE_OFFICER.email}`)} />
          <Row icon="call-outline" label={GRIEVANCE_OFFICER.phone} onPress={() => open('grievance_phone', `tel:${GRIEVANCE_OFFICER.phoneE164}`)} />
          <Row icon="document-text-outline" label={t('help_center.grievance_page')} onPress={() => open('grievance_page', webPageUrl('/grievance', locale))} />
        </Section>
      </ScrollView>
    </SafeAreaView>
  )
}
