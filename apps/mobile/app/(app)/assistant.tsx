import { ScrollView, Text, View, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform, Linking } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect, router } from 'expo-router'
import { PROCUREMENT_CONSENT_TEXT_VERSION } from '@amclub/shared'
import { useI18n } from '@/lib/i18n'
import { fetchProcurementState, fetchProcurementThread, sendProcurementDecision, sendProcurementMessage, setProcurementEnabled, type ProcurementState, type ProcurementTurn } from '@/lib/api'

/**
 * S3.1 — the buying assistant (Android parity of /app/assistant). The same thread as WhatsApp and the web; every agent
 * line is a server-rendered template. A card's Yes / Edit / No is the buyer's tap on the SAME decision path as a
 * WhatsApp button. Nothing here pays: an approved "go with B" posts a link to the request page, where the ordinary
 * pay flow runs on the buyer's own tap.
 */
const URL_RE = /(https?:\/\/[^\s)]+)/g
const IS_URL = /^https?:\/\//

function Body({ text }: { text: string }) {
  return (
    <Text className="text-sm text-foreground">
      {text.split(URL_RE).map((p, i) =>
        IS_URL.test(p) ? (
          <Text key={i} className="text-primary underline" onPress={() => void Linking.openURL(p)}>
            {p}
          </Text>
        ) : (
          <Text key={i}>{p}</Text>
        ),
      )}
    </Text>
  )
}

export default function AssistantScreen() {
  const { t, locale } = useI18n()
  const [state, setState] = useState<ProcurementState | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [turns, setTurns] = useState<ProcurementTurn[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const listRef = useRef<ScrollView>(null)

  const loadState = useCallback(async () => {
    const s = await fetchProcurementState()
    setState(s)
    setSelected((cur) => cur ?? s?.sessions.find((x) => x.active)?.id ?? s?.sessions[0]?.id ?? null)
  }, [])
  const loadThread = useCallback(async (id: string) => {
    const r = await fetchProcurementThread(id)
    if (r) setTurns(r.turns)
  }, [])
  useFocusEffect(useCallback(() => { void loadState() }, [loadState]))
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    void fetchProcurementThread(selected).then((r) => {
      if (!cancelled && r) setTurns(r.turns)
    })
    return () => {
      cancelled = true
    }
  }, [selected])
  // the reply comes from the runtime: poll while the screen is open
  useEffect(() => {
    if (!state?.enabled) return
    const id = setInterval(() => {
      void loadState()
      if (selected) void loadThread(selected)
    }, 5000)
    return () => clearInterval(id)
  }, [state?.enabled, selected, loadState, loadThread])

  async function toggle(on: boolean) {
    setBusy(true)
    const s = await setProcurementEnabled(on, locale, PROCUREMENT_CONSENT_TEXT_VERSION)
    setBusy(false)
    if (s) setState(s)
    else setNotice(t('assistant.error'))
  }

  async function post(body: Parameters<typeof sendProcurementMessage>[0]) {
    setBusy(true)
    const r = await sendProcurementMessage(body, locale)
    setBusy(false)
    if (!r.ok || !r.data) {
      setNotice(r.status === 429 ? t('assistant.too_fast') : t('assistant.error'))
      return
    }
    setNotice(r.data.enqueued ? null : t('assistant.runtime_offline'))
    setSelected(r.data.session_id)
    await loadState()
    await loadThread(r.data.session_id)
  }

  async function decide(runId: string, action: 'ok' | 'edit' | 'no') {
    setBusy(true)
    const r = await sendProcurementDecision(runId, action)
    setBusy(false)
    setNotice(r.ok ? null : r.status === 409 ? t('assistant.proposal_gone') : t('assistant.error'))
    if (selected) await loadThread(selected)
  }

  const current = state?.sessions.find((s) => s.id === selected) ?? null

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1">
        <View className="flex-row items-center justify-between px-4 pt-2">
          <TouchableOpacity onPress={() => router.back()}>
            <Text className="text-base text-primary">‹ {t('common.back')}</Text>
          </TouchableOpacity>
          {state?.enabled && (
            <TouchableOpacity onPress={() => { setSelected(null); setTurns([]) }} testID="assistant-new">
              <Text className="text-sm font-semibold text-primary">{t('assistant.new_request')}</Text>
            </TouchableOpacity>
          )}
        </View>
        <View className="px-4 pb-2">
          <Text className="text-2xl font-bold text-foreground">{t('assistant.title')}</Text>
          <Text className="mt-1 text-sm text-foreground-secondary">{t('assistant.subtitle')}</Text>
        </View>
        {notice && <Text className="mx-4 mb-2 text-xs text-foreground-secondary">{notice}</Text>}
        {!state ? (
          <ActivityIndicator className="mt-10" />
        ) : !state.enabled ? (
          <ScrollView contentContainerClassName="px-4 gap-3 pb-6">
            <View className="rounded-xl border border-gray-200 bg-surface p-4">
              <Text className="text-lg font-semibold text-foreground">{t('assistant.consent_title')}</Text>
              <Text className="mt-2 text-sm text-foreground">• {t('assistant.consent_does_1')}</Text>
              <Text className="mt-1 text-sm text-foreground">• {t('assistant.consent_does_2')}</Text>
              <Text className="mt-1 text-sm text-foreground">• {t('assistant.consent_does_3')}</Text>
              <Text className="mt-3 rounded-lg bg-primary/10 p-3 text-sm font-medium text-foreground">{t('assistant.consent_never')}</Text>
              <Text className="mt-2 text-xs text-foreground-secondary">{t('assistant.consent_whatsapp')}</Text>
              <TouchableOpacity onPress={() => void toggle(true)} disabled={busy} className="mt-4 items-center rounded-lg bg-primary px-4 py-3" testID="assistant-enable">
                <Text className="text-sm font-semibold text-white">{t('assistant.enable')}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        ) : (
          <>
            {state.sessions.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="px-4 gap-2 pb-2">
                {state.sessions.map((s) => (
                  <TouchableOpacity key={s.id} onPress={() => setSelected(s.id)} className={`rounded-full border px-3 py-1 ${s.id === selected ? 'border-primary bg-primary/10' : 'border-gray-300'}`}>
                    <Text className="text-xs text-foreground" numberOfLines={1}>{s.title ?? t('assistant.untitled')}{s.open_run_id ? ' •' : ''}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
            <ScrollView ref={listRef} contentContainerClassName="px-4 gap-3 pb-4" onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}>
              {turns.length === 0 && <Text className="text-sm text-foreground-secondary">{t('assistant.empty_thread')}</Text>}
              {turns.map((m) => {
                const open = m.role === 'agent' && !!m.run_id && !!m.proposal?.tool && m.proposal.status === 'open' && current?.open_run_id === m.run_id
                return (
                  <View key={m.id} className={m.role === 'user' ? 'self-end max-w-[85%] rounded-xl bg-primary/10 px-3 py-2' : 'self-start max-w-[85%] rounded-xl bg-surface border border-gray-200 px-3 py-2'}>
                    {m.role === 'user' ? <Text className="text-sm text-foreground">{m.body}</Text> : <Body text={m.body ?? ''} />}
                    {open && (
                      <View className="mt-2 flex-row flex-wrap gap-2">
                        <TouchableOpacity onPress={() => void decide(m.run_id!, 'ok')} disabled={busy} className="rounded-lg bg-primary px-4 py-2">
                          <Text className="text-sm font-semibold text-white">{t('assistant.approve')}</Text>
                        </TouchableOpacity>
                        {m.proposal?.edit && (
                          <TouchableOpacity onPress={() => void decide(m.run_id!, 'edit')} disabled={busy} className="rounded-lg border border-primary px-4 py-2">
                            <Text className="text-sm font-semibold text-primary">{t('assistant.edit')}</Text>
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity onPress={() => void decide(m.run_id!, 'no')} disabled={busy} className="rounded-lg px-4 py-2">
                          <Text className="text-sm font-semibold text-foreground-secondary">{t('assistant.decline')}</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                    {m.role === 'agent' && m.proposal?.labels && m.proposal.status === 'open' && current?.active && (
                      <View className="mt-2 flex-row flex-wrap gap-2">
                        {m.proposal.labels.map((l) => (
                          <TouchableOpacity key={l} onPress={() => void post({ session_id: current.id, label: l })} disabled={busy} className="rounded-lg border border-primary px-3 py-2">
                            <Text className="text-sm text-primary">{t('assistant.quote_label').replace('{label}', l)}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                    {m.role === 'agent' && m.proposal?.session_choice && m.proposal.message_id && current?.active && (
                      <View className="mt-2 flex-row flex-wrap gap-2">
                        <TouchableOpacity onPress={() => void post({ session_id: current.id, session_choice: 'new', message_id: m.proposal!.message_id! })} disabled={busy} className="rounded-lg border border-primary px-3 py-2">
                          <Text className="text-sm text-primary">{t('assistant.new_req_btn')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => void post({ session_id: current.id, session_choice: 'current', message_id: m.proposal!.message_id! })} disabled={busy} className="rounded-lg border border-primary px-3 py-2">
                          <Text className="text-sm text-primary">{t('assistant.this_one_btn')}</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                )
              })}
              <Text className="text-xs text-foreground-secondary">{t('assistant.never_pays_line')}</Text>
              <TouchableOpacity onPress={() => void toggle(false)} disabled={busy}>
                <Text className="text-xs text-foreground-secondary underline">{t('assistant.disable')}</Text>
              </TouchableOpacity>
            </ScrollView>
            <View className="flex-row items-center gap-2 border-t border-gray-200 p-3">
              <TextInput className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-foreground" value={text} onChangeText={setText} placeholder={t('assistant.composer_placeholder')} maxLength={1000} editable={!busy} accessibilityLabel={t('assistant.composer_label')} />
              <TouchableOpacity
                onPress={() => {
                  const body = text.trim()
                  if (!body) return
                  setText('')
                  void post({ text: body, ...(current?.active ? { session_id: current.id } : {}) })
                }}
                disabled={busy || !text.trim()}
                className="rounded-lg bg-primary px-4 py-2"
              >
                <Text className="text-sm font-semibold text-white">{t('assistant.send')}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
