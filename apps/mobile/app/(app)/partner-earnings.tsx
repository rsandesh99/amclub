import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useCallback, useState } from 'react'
import { router, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { groupPayoutsForEarnings, PAYOUT_STATUS } from '@amclub/shared'
import { useI18n } from '@/lib/i18n'
import { fetchMyPayouts, type MyPayout } from '@/lib/api'
import { formatINR } from '@/lib/format'
import { ErrorState } from '@/components/ErrorState'

function istDate(iso: string): string {
  return new Date(iso.length === 10 ? `${iso}T00:00:00+05:30` : iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })
}

/**
 * PRD Experience v3 E13 FR-13.2 — the provider's Earnings tab: the payout
 * ledger grouped as scheduled (incl. processing), on hold (with the existing
 * hold reasons) and paid. Server paise and dates only — no sums computed on
 * the phone beyond what each row says.
 */
export default function PartnerEarningsScreen() {
  const { t } = useI18n() as { t: (k: string, p?: Record<string, string | number>) => string }
  const [payouts, setPayouts] = useState<MyPayout[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await fetchMyPayouts()
    setFailed(!r.ok)
    setPayouts(r.payouts)
    setLoading(false)
  }, [])
  useFocusEffect(useCallback(() => { void load() }, [load]))

  const groups = groupPayoutsForEarnings(payouts)
  const reason = (r: string) => {
    const k = `earnings_v3.hold_reason_${r}`
    const s = t(k)
    return s === k ? t('earnings_v3.hold_reason_unknown') : s
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="border-b border-gray-200 bg-surface px-4 py-3">
        <Text className="text-lg font-bold text-foreground">{t('earnings_v3.title')}</Text>
      </View>
      {loading ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator size="large" color="#1B4D3E" /></View>
      ) : failed ? (
        <ErrorState onRetry={() => void load()} />
      ) : payouts.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <Ionicons name="wallet-outline" size={40} color="#9CA3AF" />
          <Text className="text-center text-sm text-foreground-secondary">{t('earnings_v3.empty')}</Text>
        </View>
      ) : (
        <ScrollView contentContainerClassName="gap-5 px-4 py-4" testID="earnings-v3">
          {groups.map((g) => (
            <View key={g.group} className="gap-2">
              <Text className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{t(`earnings_v3.group_${g.group}`)} · {g.rows.length}</Text>
              {g.rows.map((p) => (
                <TouchableOpacity key={p.id} onPress={() => router.push(`/orders/${p.orderId}` as never)} className="rounded-xl border border-gray-200 bg-surface p-4" accessibilityRole="button">
                  <View className="flex-row items-start justify-between gap-3">
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>{p.orderTitle ?? p.orderNumber ?? ''}</Text>
                      {p.orderNumber ? <Text className="text-xs text-foreground-secondary">{p.orderNumber}</Text> : null}
                    </View>
                    <Text className="text-base font-bold text-foreground">{formatINR(p.amountPaise)}</Text>
                  </View>
                  <Text className={`mt-1 text-xs ${p.status === PAYOUT_STATUS.held || p.status === PAYOUT_STATUS.failed ? 'text-[#b45309]' : 'text-foreground-secondary'}`}>
                    {p.status === PAYOUT_STATUS.paid
                      ? (p.paidAt ? t('earnings_v3.paid_on', { date: istDate(p.paidAt) }) : t('earnings_v3.paid'))
                      : p.status === PAYOUT_STATUS.held
                        ? `${t('earnings_v3.on_hold')}: ${(p.holdReasons.length ? [...new Set(p.holdReasons)] : ['unknown']).map(reason).join(' · ')}`
                        : p.status === PAYOUT_STATUS.failed
                          ? t('earnings_v3.failed')
                          : p.status === PAYOUT_STATUS.processing
                            ? t('earnings_v3.processing')
                            : p.scheduledFor ? t('earnings_v3.scheduled_for', { date: istDate(p.scheduledFor) }) : t('earnings_v3.scheduled')}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}
