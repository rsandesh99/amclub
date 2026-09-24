import { ActivityIndicator, Linking, ScrollView, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { listingToggleTarget } from '@amclub/shared'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { API_URL, fetchMyListings, setListingStatus, type MyListing } from '@/lib/api'
import { formatINR } from '@/lib/format'
import { track } from '@/lib/analytics'
import { ErrorState } from '@/components/ErrorState'

/**
 * PRD Experience v3 E13 FR-13.2 — the provider's Listings tab: every listing
 * with its status, pause / resume in one tap (the web's status route; the
 * provider's own RLS decides), and "Edit on web" for everything else (tiers
 * and add-ons stay web-first in v3). Prices are the stored server paise.
 */
export default function PartnerListingsScreen() {
  const { t, locale } = useI18n() as { t: (k: string, p?: Record<string, string | number>) => string; locale?: string }
  const [items, setItems] = useState<MyListing[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await fetchMyListings(locale ?? 'en')
    setFailed(!r.ok)
    setItems(r.listings)
    setLoading(false)
  }, [locale])
  useFocusEffect(useCallback(() => { void load() }, [load]))

  async function toggle(l: MyListing) {
    const next = listingToggleTarget(l.status)
    if (!next) return
    setBusy(l.id)
    const ok = await setListingStatus(l.id, next)
    setBusy(null)
    if (ok) {
      track('listing_status_changed', { status: next, platform: 'android' })
      setItems((prev) => prev.map((x) => (x.id === l.id ? { ...x, status: next } : x)))
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="border-b border-gray-200 bg-surface px-4 py-3">
        <Text className="text-lg font-bold text-foreground">{t('listings_v3.title')}</Text>
      </View>
      {loading ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator size="large" color="#1B4D3E" /></View>
      ) : failed ? (
        <ErrorState onRetry={() => void load()} />
      ) : items.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <Ionicons name="pricetags-outline" size={40} color="#9CA3AF" />
          <Text className="text-center text-sm text-foreground-secondary">{t('listings_v3.empty')}</Text>
          <TouchableOpacity onPress={() => { void Linking.openURL(`${API_URL}/partner/listings/new`) }} className="rounded-lg bg-primary px-4 py-2.5">
            <Text className="text-sm font-semibold text-white">{t('listings_v3.create_on_web')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerClassName="gap-3 px-4 py-4" testID="listings-v3">
          {items.map((l) => (
            <View key={l.id} className="rounded-xl border border-gray-200 bg-surface p-4">
              <View className="flex-row items-start justify-between gap-3">
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">{l.title}</Text>
                  {l.categoryName ? <Text className="text-xs text-foreground-secondary">{l.categoryName}</Text> : null}
                </View>
                <Text className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${l.status === 'active' ? 'bg-success/10 text-success' : 'bg-muted text-foreground-secondary'}`}>
                  {t(`listings_v3.status_${l.status}`)}
                </Text>
              </View>
              <Text className="mt-2 text-base font-bold text-primary">
                {formatINR(l.pricePaise)}
                {l.discountBps > 0 ? <Text className="text-xs font-normal text-foreground-secondary">{'  '}{t('listings_v3.discount', { pct: l.discountBps / 100 })}</Text> : null}
              </Text>
              {l.deliveryDays ? <Text className="text-xs text-foreground-secondary">{t('rfq.delivery_days', { days: l.deliveryDays })}</Text> : null}
              <View className="mt-3 flex-row gap-2">
                {listingToggleTarget(l.status) && (
                  <TouchableOpacity onPress={() => void toggle(l)} disabled={busy === l.id} className="flex-1 items-center rounded-lg border border-gray-200 py-2" accessibilityRole="button">
                    {busy === l.id ? <ActivityIndicator color="#1B4D3E" /> : <Text className="text-sm font-medium text-foreground">{l.status === 'active' ? t('listings_v3.pause') : t('listings_v3.resume')}</Text>}
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={() => { void Linking.openURL(`${API_URL}/partner/listings/${l.id}/edit`) }} className="flex-1 items-center rounded-lg border border-gray-200 py-2" accessibilityRole="link">
                  <Text className="text-sm font-medium text-primary">{t('listings_v3.edit_on_web')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}
