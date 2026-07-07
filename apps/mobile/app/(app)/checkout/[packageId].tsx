import { ScrollView, Text, View, ActivityIndicator, TouchableOpacity, Alert } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect } from 'react'
import { useLocalSearchParams, router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { fetchPackage, createCheckout, simulatePay } from '@/lib/api'
import { pickI18n, computePricing, formatINR } from '@/lib/format'

 
export default function CheckoutScreen() {
  const { t, locale } = useI18n()
  const { packageId, providerSlug, packageSlug } = useLocalSearchParams<{ packageId: string; providerSlug?: string; packageSlug?: string }>()
  const [pkg, setPkg] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [paying, setPaying] = useState(false)

  useEffect(() => {
    // Resolve the package: prefer provider/slug fetch, else nothing to show.
    if (providerSlug && packageSlug) {
      fetchPackage(providerSlug, packageSlug).then((d) => { setPkg(d?.pkg ? { ...d.pkg, id: packageId } : null); setLoading(false) })
    } else {
      // Deferred: keeps setState off the effect's synchronous path.
      void Promise.resolve().then(() => setLoading(false))
    }
  }, [providerSlug, packageSlug, packageId])

  async function pay() {
    setPaying(true)
    try {
      const { ok, data } = await createCheckout(packageId)
      if (!ok) throw new Error(data.error ?? 'Checkout failed')
      if (data.simulated) {
        const sim = await simulatePay(data.checkoutSessionId)
        if (!sim.ok) throw new Error(sim.data.error ?? 'Payment failed')
        router.replace(`/orders/${sim.data.orderId}` as never)
        return
      }
      // Real Razorpay on mobile is wired when keys are provisioned (WebView/native sheet).
      Alert.alert(t('checkout.title'), t('checkout.real_pay_note'))
    } catch (e: any) {
      Alert.alert(t('common.error'), e.message)
    } finally {
      setPaying(false)
    }
  }

  if (loading) {
    return <SafeAreaView className="flex-1 items-center justify-center bg-background"><ActivityIndicator size="large" color="#1B4D3E" /></SafeAreaView>
  }

  const pricing = pkg ? computePricing(pkg) : null

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 border-b border-gray-200 bg-surface px-4 py-3">
        <TouchableOpacity onPress={() => router.back()}><Ionicons name="arrow-back" size={22} color="#1A1D1A" /></TouchableOpacity>
        <Text className="text-lg font-bold text-foreground">{t('checkout.title')}</Text>
      </View>

      <ScrollView contentContainerClassName="px-4 py-4 gap-4">
        {pkg && pricing && (
          <View className="rounded-xl border border-gray-200 bg-surface p-4">
            <Text className="font-medium text-foreground">{pickI18n(pkg.titleI18n, locale)}</Text>
            <View className="mt-3 gap-1 border-t border-gray-100 pt-3">
              <Row label={t('checkout.price')} value={formatINR(pricing.listPaise)} />
              {pricing.hasDiscount && <Row label={t('checkout.discount')} value={'- ' + formatINR(pricing.listPaise - pricing.discountedPaise)} />}
              <Row label={t('checkout.gst')} value={t('checkout.included') /* approx */} />
              <View className="mt-1 flex-row justify-between border-t border-gray-100 pt-2">
                <Text className="text-base font-bold text-foreground">{t('checkout.total')}</Text>
                <Text className="text-base font-bold text-primary">~{formatINR(Math.round(pricing.discountedPaise * 1.18))}</Text>
              </View>
            </View>
          </View>
        )}

        <Text className="text-xs text-foreground-secondary">{t('checkout.secure_note')}</Text>

        <TouchableOpacity onPress={pay} disabled={paying} className={`items-center rounded-xl py-4 ${paying ? 'bg-primary/60' : 'bg-primary'}`}>
          <Text className="text-base font-semibold text-white">{paying ? t('common.loading') : t('catalog.buy_now')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between">
      <Text className="text-sm text-foreground-secondary">{label}</Text>
      <Text className="text-sm text-foreground">{value}</Text>
    </View>
  )
}
 
