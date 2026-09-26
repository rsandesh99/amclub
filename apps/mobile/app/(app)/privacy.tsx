import { ActivityIndicator, Linking, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useCallback, useEffect, useState } from 'react'
import {
  PRIVACY_DETAILS_MAX,
  PRIVACY_KINDS_NEEDING_DETAILS,
  PRIVACY_REQUEST_DUE_DAYS,
  PRIVACY_REQUEST_KINDS,
  SUPPORT_EMAIL,
  privacyRequestProblem,
  type PrivacyRequestKind,
  type PrivacyRequestView,
} from '@amclub/shared'
import { useI18n } from '@/lib/i18n'
import { createPrivacyRequest, fetchPrivacyRequests } from '@/lib/api'
import { track } from '@/lib/analytics'
import { ScreenHeader } from '@/components/ScreenHeader'
import { webPageUrl } from '@/lib/official'

type Load = { kind: 'loading' } | { kind: 'not_ready' } | { kind: 'error' } | { kind: 'ready'; requests: PrivacyRequestView[] }

/**
 * DPDP requests on mobile (ADR-030 §6; the web page's twin): the person's
 * rights in plain words, their requests with status and due date, and a form
 * to file one (POST /api/v1/me/privacy-requests, source mobile).
 */
export default function PrivacyScreen() {
  const { t, locale } = useI18n()
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [kind, setKind] = useState<PrivacyRequestKind>('access')
  const [details, setDetails] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const date = (iso: string) => new Date(iso).toLocaleDateString(locale === 'en' ? 'en-IN' : `${locale}-IN`, { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })

  const fetchAll = useCallback(async () => {
    const r = await fetchPrivacyRequests()
    setLoad(r.kind === 'ready' ? { kind: 'ready', requests: r.data } : r)
  }, [])
  useEffect(() => { void Promise.resolve().then(fetchAll) }, [fetchAll])

  async function submit() {
    const problem = privacyRequestProblem({ kind, details })
    if (problem) { setNote({ tone: 'error', text: t(`privacy_requests.${problem}`) }); return }
    setBusy(true)
    setNote(null)
    const r = await createPrivacyRequest(kind, details.trim() || null)
    setBusy(false)
    if (r.ok && r.request) {
      track('privacy_request_created', { kind, platform: 'android' })
      setNote({ tone: 'ok', text: t('privacy_requests.sent', { date: date(r.request.dueAt) }) })
      setDetails('')
      const created = r.request
      setLoad((l) => (l.kind === 'ready' ? { kind: 'ready', requests: [created, ...l.requests] } : l))
      return
    }
    if (r.status === 409) setNote({ tone: 'error', text: r.dueAt ? t('privacy_requests.already_open', { date: date(r.dueAt) }) : t('privacy_requests.already_open_nodate') })
    else if (r.status === 422) setNote({ tone: 'error', text: t(r.error === 'details_too_long' ? 'privacy_requests.details_too_long' : 'privacy_requests.details_required') })
    else if (r.status === 429) setNote({ tone: 'error', text: t('privacy_requests.rate_limited') })
    else if (r.status === 503) setLoad({ kind: 'not_ready' })
    else setNote({ tone: 'error', text: t('privacy_requests.send_failed') })
  }

  const needsDetails = PRIVACY_KINDS_NEEDING_DETAILS.includes(kind)

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ScreenHeader title={t('privacy_requests.title')} />
      <ScrollView contentContainerClassName="gap-4 px-4 py-4" testID="privacy-screen" keyboardShouldPersistTaps="handled">
        <Text className="text-sm text-foreground-secondary">{t('privacy_requests.subtitle', { days: PRIVACY_REQUEST_DUE_DAYS })}</Text>

        <View className="gap-3 rounded-xl border border-gray-200 bg-surface p-4">
          <Text className="text-base font-semibold text-foreground">{t('privacy_requests.rights_title')}</Text>
          {PRIVACY_REQUEST_KINDS.map((k) => (
            <View key={k}>
              <Text className="text-sm font-medium text-foreground">{t(`privacy_requests.right_${k}`)}</Text>
              <Text className="text-xs text-foreground-secondary">{t(`privacy_requests.right_${k}_body`)}</Text>
            </View>
          ))}
        </View>

        <Text className="text-base font-semibold text-foreground">{t('privacy_requests.list_title')}</Text>
        {load.kind === 'loading' && <ActivityIndicator color="#1B4D3E" />}
        {load.kind === 'error' && (
          <TouchableOpacity onPress={() => { setLoad({ kind: 'loading' }); void fetchAll() }} accessibilityRole="button" className="min-h-[44px] justify-center">
            <Text className="text-sm text-foreground-secondary">{t('privacy_requests.load_failed')} <Text className="font-medium text-primary">{t('common.retry')}</Text></Text>
          </TouchableOpacity>
        )}
        {load.kind === 'not_ready' && <View className="rounded-xl bg-primary/10 p-4" testID="privacy-not-ready"><Text className="text-sm text-foreground">{t('privacy_requests.not_ready', { email: SUPPORT_EMAIL })}</Text></View>}
        {load.kind === 'ready' && load.requests.length === 0 && <Text className="text-sm text-foreground-secondary">{t('privacy_requests.empty')}</Text>}
        {load.kind === 'ready' && load.requests.map((r) => (
          <View key={r.id} className="gap-1 rounded-xl border border-gray-200 bg-surface p-4" testID="privacy-request-row">
            <View className="flex-row items-center justify-between gap-2">
              <Text className="text-sm font-medium text-foreground">{t(`privacy_requests.kind_${r.kind}`)}</Text>
              <Text className="text-xs font-semibold text-primary">{t(`privacy_requests.status_${r.status}`)}</Text>
            </View>
            <Text className="text-xs text-foreground-secondary">
              {t('privacy_requests.filed_on', { date: date(r.createdAt) })} · {r.resolvedAt ? t('privacy_requests.resolved_on', { date: date(r.resolvedAt) }) : t('privacy_requests.due_by', { date: date(r.dueAt) })}
            </Text>
            {r.resolution ? <Text className="text-sm text-foreground">{r.resolution}</Text> : null}
          </View>
        ))}

        {load.kind !== 'not_ready' && (
          <View className="gap-3 rounded-xl border border-gray-200 bg-surface p-4">
            <Text className="text-base font-semibold text-foreground">{t('privacy_requests.form_title')}</Text>
            <Text className="text-xs text-foreground-secondary">{t('privacy_requests.form_body', { days: PRIVACY_REQUEST_DUE_DAYS })}</Text>
            <Text className="text-sm font-medium text-foreground">{t('privacy_requests.kind_label')}</Text>
            <View className="flex-row flex-wrap gap-2" accessibilityRole="radiogroup" accessibilityLabel={t('privacy_requests.kind_label')}>
              {PRIVACY_REQUEST_KINDS.map((k) => (
                <TouchableOpacity key={k} onPress={() => { setKind(k); setNote(null) }} accessibilityRole="radio" accessibilityState={{ selected: kind === k }} className={`min-h-[44px] justify-center rounded-lg border px-3 ${kind === k ? 'border-primary bg-primary/10' : 'border-gray-200 bg-surface'}`} testID={`privacy-kind-${k}`}>
                  <Text className={`text-sm font-medium ${kind === k ? 'text-primary' : 'text-foreground-secondary'}`}>{t(`privacy_requests.kind_${k}`)}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {kind === 'erasure' && <View className="rounded-lg bg-amber-50 p-3"><Text className="text-xs text-warning">{t('privacy_requests.erasure_warning')}</Text></View>}
            <Text className="text-sm font-medium text-foreground">{t('privacy_requests.details_label')}{needsDetails ? '' : ` (${t('privacy_requests.optional')})`}</Text>
            <TextInput
              value={details}
              onChangeText={setDetails}
              multiline
              maxLength={PRIVACY_DETAILS_MAX}
              placeholder={kind === 'correction' ? t('privacy_requests.details_hint_correction') : kind === 'grievance' ? t('privacy_requests.details_hint_grievance') : t('privacy_requests.details_hint_other')}
              placeholderTextColor="#9CA3AF"
              accessibilityLabel={t('privacy_requests.details_label')}
              className="min-h-[88px] rounded-xl border border-gray-200 bg-surface px-3 py-2 text-sm text-foreground"
              textAlignVertical="top"
              testID="privacy-details"
            />
            {note && <Text className={`text-sm ${note.tone === 'ok' ? 'text-success' : 'text-danger'}`} accessibilityLiveRegion="polite">{note.text}</Text>}
            <TouchableOpacity onPress={() => void submit()} disabled={busy} className={`items-center rounded-xl py-3.5 ${busy ? 'bg-primary/60' : 'bg-primary'}`} accessibilityRole="button" testID="privacy-submit">
              <Text className="text-base font-semibold text-white">{busy ? t('common.loading') : t('privacy_requests.submit')}</Text>
            </TouchableOpacity>
          </View>
        )}

        <TouchableOpacity onPress={() => void Linking.openURL(webPageUrl('/privacy', locale)).catch(() => {})} accessibilityRole="link" className="min-h-[44px] justify-center">
          <Text className="text-sm font-medium text-primary">{t('privacy_requests.policy_link')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  )
}
