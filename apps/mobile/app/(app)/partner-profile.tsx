import { ActivityIndicator, Linking, ScrollView, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useEffect, useState } from 'react'
import { router } from 'expo-router'
import { API_URL, fetchMyAvailability, saveMyAvailability, type MyAvailability } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { track } from '@/lib/analytics'
import { confirmHaptic } from '@/lib/haptics'
import { ScreenHeader } from '@/components/ScreenHeader'

/** Today + n days as an IST calendar date (YYYY-MM-DD). */
function istDatePlus(n: number): string {
  return new Date(Date.now() + 5.5 * 3600e3 + n * 86_400e3).toISOString().slice(0, 10)
}

/**
 * PRD Experience v3 E13 FR-13.2 — the provider's profile: availability (N11:
 * next available date + capacity, the web's route; display only) and the
 * links to reviews, insights and the full profile editor on the web.
 */
export default function PartnerProfileScreen() {
  const { t } = useI18n()
  const [a, setA] = useState<MyAvailability | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => { void fetchMyAvailability().then(setA) }, [])

  async function save() {
    if (!a) return
    setSaving(true)
    confirmHaptic()
    const ok = await saveMyAvailability({ nextAvailableOn: a.nextAvailableOn, capacitySlots: a.capacitySlots })
    setSaving(false)
    setSaved(ok)
    if (ok) track('availability_saved', { platform: 'android' })
  }
  const pick = (d: string | null) => { setSaved(false); setA((x) => (x ? { ...x, nextAvailableOn: d } : x)) }
  const slots = (n: number) => { setSaved(false); setA((x) => (x ? { ...x, capacitySlots: Math.max(1, Math.min(50, n)) } : x)) }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ScreenHeader title={t('provider_profile_v3.title')} />
      {!a ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator size="large" color="#1B4D3E" /></View>
      ) : (
        <ScrollView contentContainerClassName="gap-5 px-4 py-4" testID="provider-profile-v3">
          <Text className="text-xl font-bold text-foreground">{a.displayName ?? ''}</Text>
          <View className="gap-2 rounded-xl border border-gray-200 bg-surface p-4">
            <Text className="text-sm font-semibold text-foreground">{t('provider_profile_v3.next_available')}</Text>
            <Text className="text-sm text-foreground-secondary">{a.nextAvailableOn ?? t('provider_profile_v3.now')}</Text>
            <View className="flex-row flex-wrap gap-2">
              {[{ k: 'now', d: null }, { k: 'in_3', d: istDatePlus(3) }, { k: 'in_7', d: istDatePlus(7) }, { k: 'in_14', d: istDatePlus(14) }].map((o) => (
                <TouchableOpacity key={o.k} onPress={() => pick(o.d)} accessibilityRole="button" className={`rounded-full border px-3 py-1.5 ${a.nextAvailableOn === o.d ? 'border-primary bg-primary/10' : 'border-gray-200'}`}>
                  <Text className="text-xs text-foreground">{t(`provider_profile_v3.pick_${o.k}`)}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text className="mt-2 text-sm font-semibold text-foreground">{t('provider_profile_v3.capacity')}</Text>
            <View className="flex-row items-center gap-4">
              <TouchableOpacity onPress={() => slots(a.capacitySlots - 1)} accessibilityLabel={t('provider_profile_v3.fewer')} className="h-10 w-10 items-center justify-center rounded-full border border-gray-200"><Text className="text-lg">−</Text></TouchableOpacity>
              <Text className="text-lg font-bold text-foreground">{a.capacitySlots}</Text>
              <TouchableOpacity onPress={() => slots(a.capacitySlots + 1)} accessibilityLabel={t('provider_profile_v3.more')} className="h-10 w-10 items-center justify-center rounded-full border border-gray-200"><Text className="text-lg">+</Text></TouchableOpacity>
            </View>
            <TouchableOpacity onPress={() => void save()} disabled={saving} className="mt-2 items-center rounded-lg bg-primary py-2.5" accessibilityRole="button">
              {saving ? <ActivityIndicator color="#fff" /> : <Text className="text-sm font-semibold text-white">{saved ? t('provider_profile_v3.saved') : t('common.save')}</Text>}
            </TouchableOpacity>
          </View>
          <View className="gap-2">
            <TouchableOpacity onPress={() => router.push('/partner-reviews' as never)} className="rounded-lg border border-gray-200 px-4 py-3" accessibilityRole="button"><Text className="text-sm text-foreground">{t('provider_profile_v3.reviews')}</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/partner-insights' as never)} className="rounded-lg border border-gray-200 px-4 py-3" accessibilityRole="button"><Text className="text-sm text-foreground">{t('provider_profile_v3.insights')}</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => { void Linking.openURL(`${API_URL}/partner/profile`) }} className="rounded-lg border border-gray-200 px-4 py-3" accessibilityRole="link"><Text className="text-sm text-primary">{t('provider_profile_v3.edit_on_web')}</Text></TouchableOpacity>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  )
}
