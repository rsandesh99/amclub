import { ScrollView, Text, View, ActivityIndicator, TouchableOpacity } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useCallback } from 'react'
import { useFocusEffect, router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { fetchMyOrders, type OrderListItem } from '@/lib/api'
import { formatINR } from '@/lib/format'
import { ErrorState } from '@/components/ErrorState'

export default function OrdersScreen() {
  const { t } = useI18n()
  const [orders, setOrders] = useState<OrderListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await fetchMyOrders('msme')
    setFailed(!r.ok)
    setOrders(r.orders)
    setLoading(false)
  }, [])

  useFocusEffect(
    useCallback(() => {
      load()
    }, [load]),
  )

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="border-b border-gray-200 bg-surface px-4 py-3">
        <Text className="text-lg font-bold text-foreground">{t('orders.my_orders')}</Text>
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#1B4D3E" />
        </View>
      ) : failed ? (
        <ErrorState onRetry={() => void load()} />
      ) : orders.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <Ionicons name="cube-outline" size={40} color="#9CA3AF" />
          <Text className="text-center text-sm font-medium text-foreground">{t('orders.empty')}</Text>
          <Text className="text-center text-xs text-foreground-secondary">{t('orders.empty_subtitle')}</Text>
          <TouchableOpacity
            onPress={() => router.push('/search' as never)}
            className="mt-2 rounded-lg bg-primary px-4 py-2.5"
          >
            <Text className="text-sm font-semibold text-white">{t('orders.explore')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerClassName="px-4 py-4 gap-3">
          {orders.map((o) => (
            <TouchableOpacity
              key={o.id}
              onPress={() => router.push(`/orders/${o.id}` as never)}
              className="flex-row items-center justify-between gap-3 rounded-xl border border-gray-200 bg-surface p-4"
              activeOpacity={0.85}
            >
              <View className="flex-1">
                <Text className="text-[11px] text-foreground-secondary">{o.order_number}</Text>
                <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>{o.title}</Text>
                <Text className="text-xs text-foreground-secondary">{formatINR(Number(o.total_paise))}</Text>
              </View>
              <View className="rounded-full bg-primary/10 px-2.5 py-1">
                <Text className="text-[11px] font-medium text-primary">{t(`orders.status_${o.status}`)}</Text>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}
