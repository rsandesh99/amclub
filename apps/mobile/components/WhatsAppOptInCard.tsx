import { Text, TouchableOpacity, View } from 'react-native'
import { useEffect, useState } from 'react'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as SecureStore from 'expo-secure-store'
import { useI18n } from '@/lib/i18n'
import { fetchWhatsAppConsent } from '@/lib/api'
import { track } from '@/lib/analytics'

const KEY = 'amc_wa_optin_card_dismissed'

/**
 * "Get order updates on WhatsApp" — the one-time card on the buyer home and
 * the provider Today screen (the web card's twin). Shown only when the account
 * has a phone, WhatsApp is ready, the phone is not suppressed and no choice was
 * made yet; dismissing hides it on this phone for good.
 */
export function WhatsAppOptInCard({ persona }: { persona: 'buyer' | 'provider' }) {
  const { t } = useI18n()
  const [show, setShow] = useState(false)

  useEffect(() => {
    let live = true
    void (async () => {
      try { if ((await SecureStore.getItemAsync(KEY)) === '1') return } catch { /* no store: still ask */ }
      const r = await fetchWhatsAppConsent()
      if (!live || r.kind !== 'ready') return
      if (r.data.phoneMasked && !r.data.suppressed && r.data.purposes.transactional === 'none') {
        setShow(true)
        track('whatsapp_optin_card_shown', { persona, platform: 'android' })
      }
    })()
    return () => { live = false }
  }, [persona])

  if (!show) return null

  const dismiss = () => {
    setShow(false)
    SecureStore.setItemAsync(KEY, '1').catch(() => {})
    track('whatsapp_optin_card_dismissed', { persona, platform: 'android' })
  }

  return (
    <View className="gap-2 rounded-xl border border-primary/30 bg-primary/5 p-4" testID="wa-optin-card">
      <View className="flex-row items-start gap-3">
        <Ionicons name="logo-whatsapp" size={22} color="#1B4D3E" />
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground">{t('whatsapp.card_title')}</Text>
          <Text className="mt-0.5 text-xs text-foreground-secondary">{t('whatsapp.card_body')}</Text>
        </View>
      </View>
      <View className="flex-row items-center gap-3">
        <TouchableOpacity
          onPress={() => { track('whatsapp_optin_card_clicked', { persona, platform: 'android' }); router.push('/whatsapp-settings' as never) }}
          className="min-h-[44px] justify-center rounded-lg bg-primary px-4"
          accessibilityRole="button"
          testID="wa-optin-card-cta"
        >
          <Text className="text-sm font-semibold text-white">{t('whatsapp.card_cta')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={dismiss} className="min-h-[44px] justify-center px-2" accessibilityRole="button" testID="wa-optin-card-dismiss">
          <Text className="text-sm font-medium text-foreground-secondary">{t('whatsapp.card_dismiss')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}
