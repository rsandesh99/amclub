import { ScrollView, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useEffect, useState } from 'react'
import { router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useI18n } from '@/lib/i18n'
import { formatINR } from '@/lib/format'
import type { ProfileMeResponse } from '@amclub/shared'
import { AvatarButton } from '@/components/AvatarButton'

interface ProviderStatus {
  status: 'under_review' | 'active' | 'rejected' | 'suspended' | null
}

export default function PartnerScreen() {
  const { t, locale } = useI18n()
  const [providerStatus, setProviderStatus] = useState<ProviderStatus['status']>(null)
  // 'ready' | 'missing_route' | 'bank_unverified' | 'not_ready' | 'no_bank' | null (from /profile/me)
  const [payoutReadiness, setPayoutReadiness] = useState<string | null>(null)
  const [munshiEnabled, setMunshiEnabled] = useState(false)
  // E13 — Today in the provider tab bar: the avatar opens the profile sheet while `mobile` is on.
  const [mobileV3, setMobileV3] = useState(false)
  const [fullName, setFullName] = useState<string | null>(null)
  const [supportEnabled, setSupportEnabled] = useState(false)
  // S2.4 — the provider's OWN AMC Score (the route 404s unless score_card_enabled → no card)
  const [scoreCard, setScoreCard] = useState<ScoreCardView | null>(null)
  const [loading, setLoading] = useState(true)
  // E0 / U8 — real numbers from GET /partner/stats (were hard-coded "0" / "₹0").
  const [stats, setStats] = useState<{ openRfqCount: number; activeCount: number; earningsPaise: number } | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) { router.replace('/(auth)/login'); return }
      try {
        const res = await fetch(
          `${process.env['EXPO_PUBLIC_API_URL'] ?? ''}/api/v1/profile/me`,
          { headers: { Authorization: `Bearer ${session.access_token}` } },
        )
        // S2.3 — shared response contract (includes martEnabled; no mobile
        // branch reads it yet by design).
        const data = (await res.json()) as Partial<ProfileMeResponse>
        setProviderStatus((data.providerStatus ?? null) as ProviderStatus['status'])
        setMunshiEnabled(data.munshiEnabled === true)
        setMobileV3(data.mobileV3Enabled === true)
        setFullName(data.fullName ?? null)
        setSupportEnabled(data.supportEnabled === true)
        setPayoutReadiness(data.payoutReadiness ?? null)
        if (data.providerStatus === 'active') {
          const st = await fetch(`${process.env['EXPO_PUBLIC_API_URL'] ?? ''}/api/v1/partner/stats`, { headers: { Authorization: `Bearer ${session.access_token}` } })
          if (st.ok) setStats((await st.json()) as { openRfqCount: number; activeCount: number; earningsPaise: number })
        }
        const sc = await fetch(`${process.env['EXPO_PUBLIC_API_URL'] ?? ''}/api/v1/partner/score?locale=${locale}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
        if (sc.ok) setScoreCard((await sc.json()) as ScoreCardView)
      } catch {
        // ignore
      } finally {
        setLoading(false)
      }
    })
  }, [locale])

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
          <Text className="text-2xl font-bold text-foreground">{mobileV3 ? t('tabs.today') : t('partner_home.title')}</Text>
          {mobileV3 ? (
            <AvatarButton name={fullName} />
          ) : (
            <TouchableOpacity
              onPress={signOut}
              className="rounded-lg border border-gray-200 px-3 py-2"
            >
              <Text className="text-sm text-foreground-secondary">{t('common.sign_out')}</Text>
            </TouchableOpacity>
          )}
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
                { label: t('partner_home.stat_rfqs'), value: stats ? String(stats.openRfqCount) : '—' },
                { label: t('partner_home.stat_orders'), value: stats ? String(stats.activeCount) : '—' },
                { label: t('partner_home.stat_earnings'), value: stats ? formatINR(stats.earningsPaise) : '—' },
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

            {scoreCard && <ScoreCard card={scoreCard} t={t} />}

            {/* S2.3 — the Help chat (only for an enabled, cohorted user; the server decides) */}
            {supportEnabled && (
              <TouchableOpacity onPress={() => router.push('/support' as never)} className="flex-row items-center justify-between rounded-xl border border-gray-200 bg-surface p-5" testID="support-tile">
                <View>
                  <Text className="text-base font-semibold text-foreground">{t('support.title')}</Text>
                  <Text className="mt-0.5 text-xs text-foreground-secondary">{t('support.tile_sub')}</Text>
                </View>
                <Text className="text-2xl">💬</Text>
              </TouchableOpacity>
            )}

            {/* E13 — the rest of the provider's phone toolkit (reviews, insights, availability) while `mobile` is on */}
            {mobileV3 && (
              <View className="flex-row gap-2" testID="today-v3-links">
                {[
                  { k: 'reviews', to: '/partner-reviews' },
                  { k: 'insights', to: '/partner-insights' },
                  { k: 'provider_profile', to: '/partner-profile' },
                ].map((l) => (
                  <TouchableOpacity key={l.k} onPress={() => router.push(l.to as never)} className="flex-1 items-center rounded-xl border border-gray-200 bg-surface px-2 py-3" accessibilityRole="button">
                    <Text className="text-center text-xs font-medium text-foreground">{t(`profile_v3.${l.k}`)}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* S2.2 — Digital Munshi (only for an enabled, cohorted provider; the server decides) */}
            {munshiEnabled && (
              <TouchableOpacity onPress={() => router.push('/partner-munshi' as never)} className="flex-row items-center justify-between rounded-xl border border-gray-200 bg-surface p-5" testID="munshi-tile">
                <View>
                  <Text className="text-base font-semibold text-foreground">{t('munshi.title')}</Text>
                  <Text className="mt-0.5 text-xs text-foreground-secondary">{t('munshi.tile_sub')}</Text>
                </View>
                <Text className="text-2xl">🧑‍💼</Text>
              </TouchableOpacity>
            )}
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

// ── S2.4 — the AMC Score card (parity with the web dashboard card) ──────────────────────────────
interface ScoreCardView {
  computed: boolean
  score: number | null
  gate: { needed: { closed_orders: number }; have: { closed_orders: number } }
  components: { key: string; value: number | null; weight: number }[]
  tips: { key: string; text: string }[]
  note: string | null
  ranking?: { threshold: string }
}

function ScoreCard({ card, t }: { card: ScoreCardView; t: (k: string) => string }) {
  return (
    <View className="rounded-xl border border-gray-200 bg-surface p-5" testID="score-card">
      <View className="flex-row items-baseline justify-between">
        <Text className="text-base font-semibold text-foreground">{t('score_card.title')}</Text>
        {card.computed && card.score !== null && (
          <Text className="text-3xl font-bold text-primary">{card.score}<Text className="text-xs text-foreground-secondary"> {t('score_card.out_of')}</Text></Text>
        )}
      </View>
      {!card.computed && <Text className="mt-2 text-sm text-foreground-secondary">{t('score_card.not_computed')}</Text>}
      {card.computed && card.score === null && (
        <Text className="mt-2 text-sm text-foreground">{t('score_card.not_enough').replace('{have}', String(card.gate.have.closed_orders)).replace('{need}', String(card.gate.needed.closed_orders))}</Text>
      )}
      {card.note && <Text className="mt-3 text-sm text-foreground">{t('score_card.note_label')}: {card.note}</Text>}
      {card.components.map((c) => (
        <View key={c.key} className="mt-3">
          <View className="flex-row justify-between">
            <Text className="text-sm font-medium text-foreground">{t(`score_card.c_${c.key}`)}</Text>
            <Text className="text-xs text-foreground-secondary">{c.value === null ? t('score_card.no_data') : c.value} · {t('score_card.weight').replace('{weight}', String(c.weight))}</Text>
          </View>
          <View className="mt-1 h-2 overflow-hidden rounded-full bg-gray-200">
            {c.value !== null && <View className="h-full rounded-full bg-primary" style={{ width: `${c.value}%` }} />}
          </View>
        </View>
      ))}
      {card.tips.length > 0 && (
        <View className="mt-4 border-t border-gray-200 pt-3">
          <Text className="text-sm font-semibold text-foreground">{t('score_card.tips_title')}</Text>
          {card.tips.map((tip) => <Text key={tip.key} className="mt-1 text-sm text-foreground">{tip.text}</Text>)}
        </View>
      )}
      {card.ranking && <Text className="mt-4 text-xs text-foreground-secondary" testID="score-ranking-line">{t('score_card.ranking_line').replace('{threshold}', card.ranking.threshold)}</Text>}
      <Text className="mt-2 text-xs text-foreground-secondary">{t('score_card.private_line')}</Text>
    </View>
  )
}
