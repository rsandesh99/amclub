import { ActivityIndicator, Linking, ScrollView, Switch, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useCallback, useEffect, useState } from 'react'
import { Ionicons } from '@expo/vector-icons'
import type { WaConsentPurpose, WaConsentState } from '@amclub/shared'
import { waMeHref } from '@amclub/shared'
import { useI18n } from '@/lib/i18n'
import { fetchWhatsAppConsent, updateWhatsAppConsent } from '@/lib/api'
import { track } from '@/lib/analytics'
import { ScreenHeader } from '@/components/ScreenHeader'
import { OFFICIAL_WHATSAPP, WHATSAPP_MARKETING_ENABLED, webPageUrl } from '@/lib/official'

type View_ = { kind: 'loading' } | { kind: 'not_ready' } | { kind: 'error' } | { kind: 'ready'; state: WaConsentState }

/**
 * Settings → WhatsApp on mobile (audit §5 item 1; the web section's twin): the
 * masked number, one switch per purpose with the notice it records
 * (WA_NOTICE_VERSION, source mobile_settings), opt-out in one tap, the
 * "Offers" switch only when marketing is enabled or already on, the official
 * number and the safety page. Not gated on the assistant.
 */
export default function WhatsAppSettingsScreen() {
  const { t, locale } = useI18n()
  const [view, setView] = useState<View_>({ kind: 'loading' })
  const [busy, setBusy] = useState<WaConsentPurpose | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    setView({ kind: 'loading' })
    const r = await fetchWhatsAppConsent()
    setView(r.kind === 'ready' ? { kind: 'ready', state: r.data } : r)
  }, [])
  useEffect(() => { void Promise.resolve().then(load) }, [load])

  async function toggle(purpose: WaConsentPurpose, on: boolean) {
    if (view.kind !== 'ready' || busy) return
    const before = view.state
    setView({ kind: 'ready', state: { ...before, purposes: { ...before.purposes, [purpose]: on ? 'opted_in' : 'opted_out' } } })
    setBusy(purpose)
    setNote(null)
    const r = await updateWhatsAppConsent(purpose, on)
    setBusy(null)
    if (r.ok) {
      if (r.state) setView({ kind: 'ready', state: r.state })
      track('whatsapp_consent_changed', { purpose, on, source: 'mobile_settings', platform: 'android' })
      setNote({ tone: 'ok', text: on ? t('whatsapp.saved_on') : t('whatsapp.saved_off') })
      return
    }
    setView({ kind: 'ready', state: before })
    if (r.status === 409) { setNote({ tone: 'error', text: t('whatsapp.notice_changed') }); void load() }
    else if (r.status === 422) setNote({ tone: 'error', text: t('whatsapp.phone_required') })
    else if (r.status === 503) setView({ kind: 'not_ready' })
    else setNote({ tone: 'error', text: t('whatsapp.save_failed') })
  }

  const state = view.kind === 'ready' ? view.state : null
  const purposes: WaConsentPurpose[] = ['transactional', 'assistant']
  if (state && (WHATSAPP_MARKETING_ENABLED || state.purposes.marketing === 'opted_in')) purposes.push('marketing')
  const chatHref = state?.businessNumber ? waMeHref(state.businessNumber) : waMeHref(OFFICIAL_WHATSAPP.digits)

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ScreenHeader title={t('whatsapp.title')} />
      <ScrollView contentContainerClassName="gap-4 px-4 py-4" testID="whatsapp-settings" accessibilityLabel={view.kind}>
        <Text className="text-sm text-foreground-secondary">{t('whatsapp.subtitle')}</Text>

        {view.kind === 'loading' && <View className="items-center py-8"><ActivityIndicator size="large" color="#1B4D3E" /></View>}
        {view.kind === 'not_ready' && (
          <View className="rounded-xl bg-primary/10 p-4" testID="wa-not-ready"><Text className="text-sm text-foreground">{t('whatsapp.not_ready')}</Text></View>
        )}
        {view.kind === 'error' && (
          <View className="flex-row items-center gap-3 rounded-xl border border-gray-200 bg-surface p-4">
            <Text className="flex-1 text-sm text-foreground-secondary">{t('whatsapp.load_failed')}</Text>
            <TouchableOpacity onPress={() => void load()} className="rounded-lg border border-primary px-3 py-2" accessibilityRole="button"><Text className="text-sm font-medium text-primary">{t('common.retry')}</Text></TouchableOpacity>
          </View>
        )}

        {state && (
          <>
            {state.phoneMasked ? (
              <Text className="text-sm text-foreground">{t('whatsapp.your_number', { number: state.phoneMasked })}</Text>
            ) : (
              <View className="rounded-xl bg-amber-50 p-3"><Text className="text-sm text-warning">{t('whatsapp.no_phone')}</Text></View>
            )}
            {state.suppressed && (
              <View className="rounded-xl bg-amber-50 p-3">
                <Text className="text-sm text-warning">{state.suppressed === 'not_on_whatsapp' ? t('whatsapp.suppressed_not_on_whatsapp') : t('whatsapp.suppressed_other')}</Text>
              </View>
            )}
            <View className="rounded-xl border border-gray-200 bg-surface">
              {purposes.map((p, i) => {
                const on = state.purposes[p] === 'opted_in'
                return (
                  <View key={p} className={`flex-row items-start gap-3 px-4 py-3 ${i > 0 ? 'border-t border-gray-100' : ''}`} testID={`wa-purpose-${p}`}>
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-foreground">{t(`whatsapp.${p}_title`)}</Text>
                      <Text className="mt-0.5 text-xs leading-5 text-foreground-secondary">{t(`whatsapp.notice_${p}`)}</Text>
                    </View>
                    <Switch
                      value={on}
                      onValueChange={(next) => void toggle(p, next)}
                      disabled={!state.phoneMasked || (busy !== null && busy !== p)}
                      accessibilityLabel={t(`whatsapp.${p}_title`)}
                      accessibilityHint={t(`whatsapp.notice_${p}`)}
                      trackColor={{ true: '#1B4D3E', false: '#D1D5DB' }}
                      testID={`wa-switch-${p}`}
                    />
                  </View>
                )
              })}
            </View>
            {note && <Text className={`text-sm ${note.tone === 'ok' ? 'text-success' : 'text-danger'}`} accessibilityLiveRegion="polite">{note.text}</Text>}
            <Text className="text-xs text-foreground-secondary">{t('whatsapp.stop_hint')}</Text>
          </>
        )}

        <View className="gap-2">
          <TouchableOpacity onPress={() => void Linking.openURL(chatHref).catch(() => {})} className="min-h-[48px] flex-row items-center gap-2 rounded-xl border border-gray-200 bg-surface px-4 py-3" accessibilityRole="link" testID="wa-message-us">
            <Ionicons name="logo-whatsapp" size={20} color="#1B4D3E" />
            <Text className="flex-1 text-sm font-medium text-primary">{t('whatsapp.message_us')}</Text>
            <Text className="text-xs text-foreground-secondary">{OFFICIAL_WHATSAPP.display}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => void Linking.openURL(webPageUrl('/help/whatsapp-safety', locale)).catch(() => {})} className="min-h-[48px] flex-row items-center gap-2 rounded-xl border border-gray-200 bg-surface px-4 py-3" accessibilityRole="link">
            <Ionicons name="shield-checkmark-outline" size={20} color="#1B4D3E" />
            <Text className="flex-1 text-sm font-medium text-primary">{t('whatsapp.safety_link')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}
