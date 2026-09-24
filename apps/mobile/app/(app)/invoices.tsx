import { ActivityIndicator, Linking, ScrollView, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useCallback, useState } from 'react'
import { router, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { fetchMyInvoices, type MyInvoice } from '@/lib/api'
import { formatINR } from '@/lib/format'
import { track } from '@/lib/analytics'
import { ErrorState } from '@/components/ErrorState'

/**
 * PRD Experience v3 E13 FR-13.3 — the buyer's GST invoices: the web list's
 * rows, each opening its PDF through a 15-minute signed link fetched fresh
 * on every visit (never stored on the phone).
 */
export default function InvoicesScreen() {
  const { t } = useI18n()
  const [items, setItems] = useState<MyInvoice[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await fetchMyInvoices()
    setFailed(!r.ok)
    setItems(r.invoices)
    setLoading(false)
  }, [])
  useFocusEffect(useCallback(() => { void load() }, [load]))

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 border-b border-gray-200 bg-surface px-4 py-3">
        <TouchableOpacity onPress={() => router.back()} accessibilityLabel={t('common.back')} className="p-1"><Ionicons name="arrow-back" size={22} color="#1B4D3E" /></TouchableOpacity>
        <Text className="text-lg font-bold text-foreground">{t('invoices_v3.title')}</Text>
      </View>
      {loading ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator size="large" color="#1B4D3E" /></View>
      ) : failed ? (
        <ErrorState onRetry={() => void load()} />
      ) : items.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <Ionicons name="receipt-outline" size={40} color="#9CA3AF" />
          <Text className="text-center text-sm text-foreground-secondary">{t('invoices_v3.empty')}</Text>
        </View>
      ) : (
        <ScrollView contentContainerClassName="gap-3 px-4 py-4" testID="invoices-v3">
          {items.map((inv) => (
            <View key={inv.id} className="flex-row items-center justify-between gap-3 rounded-xl border border-gray-200 bg-surface p-4">
              <TouchableOpacity className="flex-1" onPress={() => router.push(`/orders/${inv.orderId}` as never)} accessibilityRole="link">
                <Text className="text-sm font-semibold text-foreground">{inv.number}</Text>
                <Text className="text-xs text-primary" numberOfLines={1}>{inv.orderTitle ?? inv.orderNumber ?? ''}</Text>
                <Text className="text-xs text-foreground-secondary">{formatINR(inv.totalPaise)} · {new Date(inv.createdAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })}</Text>
              </TouchableOpacity>
              {inv.downloadUrl ? (
                <TouchableOpacity onPress={() => { track('invoice_opened', { platform: 'android' }); void Linking.openURL(inv.downloadUrl!) }} className="flex-row items-center gap-1 rounded-lg border border-gray-200 px-3 py-2" accessibilityRole="button">
                  <Ionicons name="download-outline" size={16} color="#1B4D3E" />
                  <Text className="text-sm font-medium text-primary">{t('invoices_v3.download')}</Text>
                </TouchableOpacity>
              ) : (
                <Text className="text-xs text-foreground-secondary">{t('invoices_v3.pending')}</Text>
              )}
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}
