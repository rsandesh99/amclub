import { ScrollView, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useEffect, useState } from 'react'
import { router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useI18n } from '@/lib/i18n'

interface ProviderStatus {
  status: 'under_review' | 'active' | 'rejected' | 'suspended' | null
}

export default function PartnerScreen() {
  const { t } = useI18n()
  const [providerStatus, setProviderStatus] = useState<ProviderStatus['status']>(null)
  // 'ready' | 'missing_route' | 'bank_unverified' | 'not_ready' | 'no_bank' | null (from /profile/me)
  const [payoutReadiness, setPayoutReadiness] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) { router.replace('/(auth)/login'); return }
      try {
        const res = await fetch(
          `${process.env['EXPO_PUBLIC_API_URL'] ?? ''}/api/v1/profile/me`,
          { headers: { Authorization: `Bearer ${session.access_token}` } },
        )
        const data = await res.json()
        setProviderStatus(data.providerStatus)
        setPayoutReadiness(data.payoutReadiness ?? null)
      } catch {
        // ignore
      } finally {
        setLoading(false)
      }
    })
  }, [])

  async function signOut() {
    await supabase.auth.signOut()
    router.replace('/(auth)/login')
  }

  if (loading) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background">
        <Text className="text-foreground-secondary">{t('common.loading')}</Text>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="px-6 py-8 gap-6">
        {/* Header */}
        <View className="flex-row items-center justify-between">
          <Text className="text-2xl font-bold text-foreground">{t('partner_home.title')}</Text>
          <TouchableOpacity
            onPress={signOut}
            className="rounded-lg border border-gray-200 px-3 py-2"
          >
            <Text className="text-sm text-foreground-secondary">{t('common.sign_out')}</Text>
          </TouchableOpacity>
        </View>

        {/* Status banner */}
        {providerStatus === 'under_review' && (
          <View className="rounded-xl border border-yellow-300 bg-yellow-50 p-5">
            <Text className="text-sm font-semibold text-yellow-800">
              {t('partner_home.under_review_title')}
            </Text>
            <Text className="mt-1 text-xs text-yellow-700">
              {t('partner_home.under_review_desc')}
            </Text>
          </View>
        )}

        {/* Phase 3b (ii) — payouts hold until our team links the Route account / verifies the bank. */}
        {providerStatus === 'active' && payoutReadiness && payoutReadiness !== 'ready' && (
          <View className="rounded-xl border border-yellow-300 bg-yellow-50 p-5">
            <Text className="text-sm font-semibold text-yellow-800">{t('partner_home.payout_hold_title')}</Text>
            <Text className="mt-1 text-xs text-yellow-700">{t('partner_home.payout_hold_desc')}</Text>
          </View>
        )}

        {providerStatus === 'rejected' && (
          <View className="rounded-xl border border-red-300 bg-red-50 p-5">
            <Text className="text-sm font-semibold text-red-800">
              {t('partner_home.rejected_title')}
            </Text>
            <Text className="mt-1 text-xs text-red-700">
              {t('partner_home.rejected_desc')}
            </Text>
          </View>
        )}

        {providerStatus === 'active' && (
          <>
            {/* Stats */}
            <View className="flex-row gap-3">
              {[
                { label: t('partner_home.stat_rfqs'), value: '0' },
                { label: t('partner_home.stat_orders'), value: '0' },
                { label: t('partner_home.stat_earnings'), value: '₹0' },
              ].map((s) => (
                <View
                  key={s.label}
                  className="flex-1 items-center rounded-xl border border-gray-200 bg-surface p-4"
                >
                  <Text className="text-xl font-bold text-primary">{s.value}</Text>
                  <Text className="mt-1 text-center text-xs text-foreground-secondary">
                    {s.label}
                  </Text>
                </View>
              ))}
            </View>

            {/* Quote requests (RFQ inbox) */}
            <TouchableOpacity onPress={() => router.push('/partner-rfqs' as never)} className="flex-row items-center justify-between rounded-xl border border-gray-200 bg-surface p-5">
              <View>
                <Text className="text-base font-semibold text-foreground">{t('rfq.inbox_title')}</Text>
                <Text className="mt-0.5 text-xs text-foreground-secondary">{t('rfq.no_matched')}</Text>
              </View>
              <Text className="text-2xl">📬</Text>
            </TouchableOpacity>
          </>
        )}

        {/* Not yet applied */}
        {providerStatus === null && (
          <View className="items-center rounded-xl border border-gray-200 bg-surface p-10 gap-4">
            <Text className="text-4xl">🚀</Text>
            <Text className="text-base font-semibold text-foreground text-center">
              {t('partner_home.not_applied_title')}
            </Text>
            <TouchableOpacity
              onPress={() => router.push('/(auth)/partner-signup')}
              className="rounded-xl bg-primary px-6 py-3"
            >
              <Text className="text-sm font-semibold text-white">
                {t('partner_home.apply_btn')}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}
