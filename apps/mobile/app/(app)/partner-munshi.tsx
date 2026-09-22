import { ScrollView, Text, View, TouchableOpacity, ActivityIndicator, Alert } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useCallback } from 'react'
import { useFocusEffect, router } from 'expo-router'
import { formatRupees, type MunshiDraft, type ThreadReplyDraft } from '@amclub/shared'
import { useI18n } from '@/lib/i18n'
import { approveMunshiDraft, fetchMunshiDrafts, fetchMunshiState, munshiSwitch, skipMunshiDraft, type MunshiDraftItem, type MunshiStateResponse } from '@/lib/api'

/**
 * S2.2 — the Munshi screen (Android parity of /partner/munshi): Enable / Pause
 * / Disable, drafts awaiting a decision (Approve / Edit / Skip), this week.
 * Approve posts the run's proposed payload unchanged to the decision route;
 * Edit deep-links into the RFQ screen. The price book stays web-only in v1.
 */
export default function PartnerMunshiScreen() {
  const { t, locale } = useI18n()
  const [state, setState] = useState<MunshiStateResponse | null>(null)
  const [drafts, setDrafts] = useState<MunshiDraftItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [s, d] = await Promise.all([fetchMunshiState(), fetchMunshiDrafts()])
    setState(s)
    setDrafts(d)
    setLoading(false)
  }, [])
  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  async function act(label: string, fn: () => Promise<{ ok: boolean }>) {
    setBusy(label)
    const r = await fn()
    setBusy(null)
    if (!r.ok) Alert.alert(t('munshi.toast_error'))
    await load()
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ScrollView contentContainerClassName="p-4 gap-4">
        <View className="flex-row items-center justify-between">
          <TouchableOpacity onPress={() => router.back()}>
            <Text className="text-base text-primary">‹ {t('common.back')}</Text>
          </TouchableOpacity>
        </View>
        <Text className="text-2xl font-bold text-foreground">{t('munshi.title')}</Text>
        <Text className="text-sm text-foreground-secondary">{t('munshi.subtitle')}</Text>
        {loading || !state ? (
          <ActivityIndicator className="mt-10" />
        ) : (
          <>
            {/* Enable card */}
            <View className="rounded-xl border border-gray-200 bg-surface p-4 gap-2">
              <Text className="text-base font-semibold text-foreground">{t('munshi.enable_title')}</Text>
              <Text className="text-xs text-foreground-secondary">{t('munshi.enable_what')}</Text>
              <Text className="text-xs text-foreground-secondary">{t('munshi.enable_never')}</Text>
              <Text className="text-xs text-foreground-secondary">{t('munshi.consent_text')}</Text>
              <Text className="text-xs font-medium text-foreground">
                {state.enabled ? (state.paused_until ? t('munshi.paused_badge') : t('munshi.enabled_badge')) : t('munshi.disabled_badge')}
                {' · '}
                {state.grant.whatsapp ? t('munshi.whatsapp_on') : t('munshi.whatsapp_off')}
              </Text>
              <View className="flex-row gap-2 mt-2">
                {!state.enabled ? (
                  <TouchableOpacity disabled={busy === 'enable'} onPress={() => act('enable', () => munshiSwitch('enable', locale))} className="rounded-lg bg-primary px-4 py-2">
                    <Text className="text-sm font-semibold text-white">{t('munshi.enable_button')}</Text>
                  </TouchableOpacity>
                ) : (
                  <>
                    <TouchableOpacity disabled={busy === 'pause' || !!state.paused_until} onPress={() => act('pause', () => munshiSwitch('pause', locale))} className="rounded-lg border border-gray-300 px-4 py-2">
                      <Text className="text-sm font-semibold text-foreground">{t('munshi.pause_button')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity disabled={busy === 'disable'} onPress={() => act('disable', () => munshiSwitch('disable', locale))} className="rounded-lg border border-gray-300 px-4 py-2">
                      <Text className="text-sm font-semibold text-foreground">{t('munshi.disable_button')}</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </View>

            {/* Drafts */}
            <Text className="text-lg font-semibold text-foreground">{t('munshi.drafts_title')} ({drafts.length})</Text>
            {drafts.length === 0 && <Text className="text-sm text-foreground-secondary">{state.price_book_rows === 0 ? t('munshi.drafts_empty_no_book') : t('munshi.drafts_empty')}</Text>}
            {drafts.map((d) => {
              const md = d.kind === 'reply' ? null : (d.draft as MunshiDraft)
              const rd = d.kind === 'reply' ? (d.draft as ThreadReplyDraft) : null
              const prices = d.basis.map((b) => b.price_paise)
              return (
                <View key={d.id} className="rounded-xl border border-gray-200 bg-surface p-4 gap-1">
                  <Text className="text-sm font-semibold text-foreground">{d.rfq?.title ?? '—'}</Text>
                  <Text className="text-xs text-primary">{t(`munshi.action_${d.kind}`)}</Text>
                  {md?.action === 'quote' && md.quote && (
                    <Text className="text-base font-semibold text-foreground">
                      {formatRupees(md.quote.price_paise)} · {md.quote.delivery_days} {t('munshi.days')}
                    </Text>
                  )}
                  {md?.action === 'quote' && md.quote && <Text className="text-sm text-foreground">{md.quote.scope}</Text>}
                  {md?.action === 'ask' && md.question && <Text className="text-sm text-foreground">{t('munshi.question_label')}: {md.question}</Text>}
                  {rd && <Text className="text-sm text-foreground">{rd.body}</Text>}
                  {d.basis.length > 0 && (
                    <Text className="text-xs text-foreground-secondary">
                      {t('munshi.basis_line')
                        .replace('{n}', String(d.basis.length))
                        .replace('{min}', formatRupees(Math.min(...prices)))
                        .replace('{max}', formatRupees(Math.max(...prices)))}
                    </Text>
                  )}
                  {md?.rationale.map((r, i) => (
                    <Text key={i} className="text-xs text-foreground-secondary">• {r}</Text>
                  ))}
                  <View className="flex-row gap-2 mt-2">
                    <TouchableOpacity disabled={busy === d.id || !d.run_id || !d.payload} onPress={() => act(d.id, () => approveMunshiDraft(d))} className="rounded-lg bg-primary px-4 py-2">
                      <Text className="text-sm font-semibold text-white">{t('munshi.approve')}</Text>
                    </TouchableOpacity>
                    {d.rfq && (
                      <TouchableOpacity onPress={() => router.push(`/partner-rfq/${d.rfq!.id}` as never)} className="rounded-lg border border-gray-300 px-4 py-2">
                        <Text className="text-sm font-semibold text-foreground">{t('munshi.edit')}</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity disabled={busy === d.id} onPress={() => act(d.id, () => skipMunshiDraft(d.id))} className="rounded-lg px-4 py-2">
                      <Text className="text-sm font-semibold text-foreground-secondary">{t('munshi.skip')}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )
            })}

            {/* This week */}
            <View className="rounded-xl border border-gray-200 bg-surface p-4">
              <Text className="text-base font-semibold text-foreground">{t('munshi.week_title')}</Text>
              <View className="flex-row flex-wrap gap-4 mt-2">
                {(['proposed', 'approved', 'edited', 'skipped', 'accepted_from_drafts'] as const).map((k) => (
                  <View key={k} className="items-center">
                    <Text className="text-xl font-bold text-primary">{state.week[k]}</Text>
                    <Text className="text-xs text-foreground-secondary">{t(`munshi.week_${k}`)}</Text>
                  </View>
                ))}
              </View>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}
