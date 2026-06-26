import { ScrollView, Text, View, ActivityIndicator, TouchableOpacity, Alert } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect } from 'react'
import { useLocalSearchParams, router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { fetchProvider, getSavedProviderIds, toggleSaved } from '@/lib/api'
import { pickI18n, initials, formatINR, computePricing } from '@/lib/format'

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function ProviderScreen() {
  const { t, locale } = useI18n()
  const { slug } = useLocalSearchParams<{ slug: string }>()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true
    fetchProvider(slug).then(async (d) => {
      if (!active) return
      setData(d)
      setLoading(false)
      const pid = d?.provider?.id
      if (pid) {
        const ids = await getSavedProviderIds()
        if (active) setSaved(ids.includes(pid))
      }
    })
    return () => { active = false }
  }, [slug])

  async function onToggleSave() {
    const pid = data?.provider?.id
    if (!pid) return
    const next = !saved
    const ok = await toggleSaved(pid, next ? 'save' : 'unsave')
    if (ok) setSaved(next)
    else Alert.alert(t('errors.title'), t('errors.sign_in_to_save'))
  }

  if (loading) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" color="#1B4D3E" />
      </SafeAreaView>
    )
  }
  if (!data?.provider) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background">
        <Text className="text-foreground-secondary">Not found</Text>
      </SafeAreaView>
    )
  }

  const p = data.provider
  const packages = data.packages ?? []

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 border-b border-gray-200 bg-surface px-4 py-3">
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color="#1A1D1A" />
        </TouchableOpacity>
        <Text className="flex-1 text-lg font-bold text-foreground" numberOfLines={1}>{p.displayName}</Text>
        <TouchableOpacity onPress={onToggleSave}>
          <Ionicons name={saved ? 'heart' : 'heart-outline'} size={22} color={saved ? '#C73E3E' : '#5C645C'} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerClassName="px-4 py-4 gap-5">
        {/* Header */}
        <View className="flex-row items-center gap-3">
          <View className="h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <Text className="text-lg font-bold text-primary">{initials(p.displayName)}</Text>
          </View>
          <View className="flex-1">
            <View className="flex-row items-center gap-1">
              <Text className="text-base font-bold text-foreground">{p.displayName}</Text>
              {p.badges?.length > 0 && <Text className="text-trust">✓</Text>}
            </View>
            <Text className="text-sm text-foreground-secondary">
              {p.avgRating > 0 ? `★ ${p.avgRating.toFixed(1)} (${p.reviewCount})` : t('catalog.new')} · {p.state}
            </Text>
            <Text className="text-xs text-foreground-secondary">
              {p.completedOrders} {t('catalog.orders_done')}
            </Text>
          </View>
        </View>

        {/* Badges */}
        {p.badges?.length > 0 && (
          <View className="flex-row flex-wrap gap-1.5">
            {p.badges.map((b: any) => (
              <View key={b.kind} className="rounded-full border border-trust/30 bg-trust/10 px-2 py-0.5">
                <Text className="text-xs font-medium text-trust">✓ {b.kind}</Text>
              </View>
            ))}
          </View>
        )}

        {/* About */}
        {p.about && (
          <View>
            <Text className="mb-1 text-base font-bold text-foreground">{t('catalog.about')}</Text>
            <Text className="text-sm leading-relaxed text-foreground-secondary">{p.about}</Text>
          </View>
        )}

        {/* Packages */}
        <View>
          <Text className="mb-2 text-base font-bold text-foreground">{t('catalog.packages')}</Text>
          {packages.length === 0 ? (
            <Text className="text-sm text-foreground-secondary">{t('catalog.no_packages')}</Text>
          ) : (
            <View className="gap-3">
              {packages.map((pk: any) => {
                const pricing = computePricing(pk)
                return (
                  <TouchableOpacity
                    key={pk.slug}
                    onPress={() => router.push(`/package/${p.slug}/${pk.slug}` as never)}
                    className="gap-2 rounded-xl border border-gray-200 bg-surface p-4"
                    activeOpacity={0.85}
                  >
                    <Text className="text-sm font-medium text-foreground">{pickI18n(pk.titleI18n, locale)}</Text>
                    <View className="flex-row items-baseline gap-2">
                      <Text className="text-lg font-bold text-foreground">{formatINR(pricing.discountedPaise)}</Text>
                      {pricing.hasDiscount && (
                        <Text className="text-sm text-foreground-secondary line-through">{formatINR(pricing.listPaise)}</Text>
                      )}
                    </View>
                  </TouchableOpacity>
                )
              })}
            </View>
          )}
        </View>

        {/* Reviews */}
        <View>
          <Text className="mb-2 text-base font-bold text-foreground">{t('catalog.reviews')}</Text>
          {(data.reviews ?? []).length === 0 ? (
            <Text className="text-sm text-foreground-secondary">{t('catalog.no_reviews')}</Text>
          ) : (
            <View className="gap-3">
              {data.reviews.map((r: any) => (
                <View key={r.id} className="rounded-xl border border-gray-200 bg-surface p-3">
                  <Text className="text-sm text-foreground">★ {r.rating}</Text>
                  {r.body && <Text className="mt-1 text-sm text-foreground-secondary">{r.body}</Text>}
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */
