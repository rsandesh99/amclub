/**
 * AMC Mart M1 — group buys list. Numbers and progress are the server's.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Image, ScrollView, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { fetchMartPools, type MartPool } from '@/lib/api'
import { formatINRExact } from '@/lib/format'
import { colors } from '@/lib/theme'
import { ErrorState } from '@/components/ErrorState'

const istDate = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

export function PoolProgressBar({ pool }: { pool: MartPool }) {
  const { t } = useI18n()
  return (
    <View className="gap-1">
      <View className="relative h-3 w-full overflow-hidden rounded-full bg-emerald-ink/10">
        <View className="h-full rounded-full bg-gold" style={{ width: `${pool.progress.pct}%` }} />
        <View className="absolute top-0 h-full w-0.5 bg-brass" style={{ left: `${pool.progress.metPct}%` }} />
      </View>
      <View className="flex-row flex-wrap items-baseline justify-between gap-x-2">
        <Text className="text-xs font-semibold text-emerald-ink">{t('mart.pool_committed', { qty: pool.committed_qty, target: pool.target_qty, unit: pool.unit })}</Text>
        <Text className="text-[11px] text-foreground-secondary">{pool.progress.met ? t('mart.pool_met_line') : t('mart.pool_remaining', { qty: pool.progress.remainingToMin, unit: pool.unit })}</Text>
      </View>
    </View>
  )
}

export function PoolCardRow({ pool }: { pool: MartPool }) {
  const { t } = useI18n()
  const saving = pool.list_price_paise && pool.list_price_paise > pool.unit_price_paise ? Math.round(((pool.list_price_paise - pool.unit_price_paise) / pool.list_price_paise) * 100) : 0
  return (
    <TouchableOpacity onPress={() => router.push(`/mart/pool/${pool.id}` as never)} accessibilityRole="button" className="rounded-card border border-border border-t-2 border-t-brass bg-ivory p-3">
      <View className="flex-row gap-3">
        <View className="h-20 w-20 overflow-hidden rounded-lg bg-muted">
          {pool.imageUrl ? <Image source={{ uri: pool.imageUrl }} className="h-20 w-20" resizeMode="cover" accessibilityIgnoresInvertColors /> : null}
        </View>
        <View className="flex-1 gap-0.5">
          <View className="flex-row items-start justify-between gap-2">
            <Text className="flex-1 text-base font-semibold text-emerald-ink" numberOfLines={2}>{pool.title}</Text>
            <Text className="rounded-full bg-emerald/10 px-2 py-0.5 text-[11px] font-semibold text-emerald">{t(`mart.pool_status_${pool.status}`)}</Text>
          </View>
          {pool.seller && <Text className="text-xs text-foreground-secondary" numberOfLines={1}>{pool.seller.displayName}{pool.seller.city ? ` · ${pool.seller.city}` : ''}</Text>}
          <View className="flex-row flex-wrap items-baseline gap-x-2">
            <Text className="text-xl font-bold text-ink">{formatINRExact(pool.unit_price_paise)}</Text>
            <Text className="text-xs text-foreground-secondary">{t('mart.pool_per_unit', { unit: pool.unit })}</Text>
            {saving > 0 && <Text className="text-xs font-semibold text-emerald">{t('mart.pool_save', { pct: saving })}</Text>}
          </View>
        </View>
      </View>
      <View className="mt-3"><PoolProgressBar pool={pool} /></View>
      <Text className="mt-1 text-[11px] text-foreground-secondary">{t('mart.pool_members', { count: pool.member_count })} · {t('mart.pool_closes', { date: istDate(pool.closes_at) })}</Text>
    </TouchableOpacity>
  )
}

export default function MartPoolsScreen() {
  const { t } = useI18n()
  const [pools, setPools] = useState<MartPool[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    const r = await fetchMartPools()
    setFailed(!r.ok)
    setPools(r.pools)
    setLoading(false)
  }, [])
  useEffect(() => { void Promise.resolve().then(load) }, [load])

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 border-b border-border bg-surface px-4 py-3">
        <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('common.back')} className="h-12 w-12 items-center justify-center">
          <Ionicons name="arrow-back" size={22} color={colors.ink} />
        </TouchableOpacity>
        <View className="flex-1">
          <Text className="text-xl font-bold text-emerald-ink">{t('mart.pools_title')}</Text>
          <Text className="text-xs text-foreground-secondary" numberOfLines={2}>{t('mart.pools_subtitle')}</Text>
        </View>
      </View>
      {loading ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator size="large" color={colors.emerald} /></View>
      ) : failed ? (
        <ErrorState onRetry={load} />
      ) : pools.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-2 px-8"><Ionicons name="people-outline" size={40} color={colors.brass} /><Text className="text-center text-base text-ink">{t('mart.pools_empty')}</Text></View>
      ) : (
        <ScrollView contentContainerClassName="px-4 py-4 gap-3">
          {pools.map((p) => <PoolCardRow key={p.id} pool={p} />)}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}
