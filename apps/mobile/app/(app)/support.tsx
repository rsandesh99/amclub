import { ScrollView, Text, View, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useCallback, useRef, useState } from 'react'
import { useFocusEffect, router } from 'expo-router'
import { useI18n } from '@/lib/i18n'
import { fetchSupportThread, sendSupportMessage, sendNudge, type SupportMessage, type SupportAction } from '@/lib/api'

/**
 * S2.3 — the Help chat (Android parity of /app/support and /partner/support).
 * Every reply is a server-rendered template; this screen never formats money
 * or dates. A nudge offer is a confirm button that calls the spine route.
 */
export default function SupportScreen() {
  const { t, locale } = useI18n()
  const [messages, setMessages] = useState<SupportMessage[]>([])
  const [ticketRef, setTicketRef] = useState<string | null>(null)
  const [action, setAction] = useState<SupportAction | null>(null)
  const [threadId, setThreadId] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const listRef = useRef<ScrollView>(null)

  const load = useCallback(async () => {
    const r = await fetchSupportThread()
    if (r) {
      setThreadId(r.thread_id)
      setMessages(r.messages)
      setTicketRef(r.ticket_ref)
    }
    setLoading(false)
  }, [])
  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  async function send(body: string) {
    if (!body.trim() || busy) return
    setBusy(true)
    setAction(null)
    setMessages((m) => [...m, { id: `local-${Date.now()}`, role: 'user', body, intent: null, reply_key: null, created_at: new Date().toISOString() }])
    setText('')
    const r = await sendSupportMessage(body, threadId, locale)
    setBusy(false)
    if (!r.ok || !r.data) return
    setThreadId(r.data.thread_id)
    setMessages((m) => [...m, { id: `reply-${Date.now()}`, role: 'assistant', body: r.data!.reply.text, intent: null, reply_key: r.data!.reply.key, created_at: new Date().toISOString() }])
    setAction(r.data.action ?? null)
    if (r.data.ticket_ref) setTicketRef(r.data.ticket_ref)
  }

  async function confirmNudge() {
    if (!action) return
    setBusy(true)
    await sendNudge(action.subject.kind, action.subject.id, action.support_message_id)
    setBusy(false)
    setAction(null)
    await load()
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1">
        <View className="flex-row items-center justify-between px-4 pt-2">
          <TouchableOpacity onPress={() => router.back()}>
            <Text className="text-base text-primary">‹ {t('common.back')}</Text>
          </TouchableOpacity>
        </View>
        <View className="px-4 pb-2">
          <Text className="text-2xl font-bold text-foreground">{t('support.title')}</Text>
          <Text className="mt-1 text-sm text-foreground-secondary">{t('support.subtitle')}</Text>
        </View>
        {ticketRef && (
          <View className="mx-4 mb-2 rounded-xl border border-primary/30 bg-surface p-3">
            <Text className="text-sm font-semibold text-foreground">{t('support.escalated_title').replace('{ref}', ticketRef)}</Text>
            <Text className="mt-1 text-xs text-foreground-secondary">{t('support.escalated_body')}</Text>
          </View>
        )}
        {loading ? (
          <ActivityIndicator className="mt-10" />
        ) : (
          <ScrollView ref={listRef} contentContainerClassName="px-4 gap-3 pb-4" onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}>
            {messages.length === 0 && <Text className="text-sm text-foreground-secondary">{t('support.empty')}</Text>}
            {messages.map((m) => (
              <View key={m.id} className={m.role === 'user' ? 'self-end max-w-[85%] rounded-xl bg-primary/10 px-3 py-2' : 'self-start max-w-[85%] rounded-xl bg-surface border border-gray-200 px-3 py-2'}>
                <Text className="text-sm text-foreground">{m.body}</Text>
              </View>
            ))}
            {action && (
              <View className="rounded-xl border border-gray-200 bg-surface p-3">
                <Text className="text-sm text-foreground">{t('support.nudge_question')}</Text>
                <View className="mt-2 flex-row gap-2">
                  <TouchableOpacity onPress={confirmNudge} disabled={busy} className="rounded-lg bg-primary px-4 py-2">
                    <Text className="text-sm font-semibold text-white">{t('support.nudge_yes')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setAction(null)} disabled={busy} className="rounded-lg px-4 py-2">
                    <Text className="text-sm font-semibold text-foreground-secondary">{t('support.nudge_no')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
            <View className="flex-row flex-wrap gap-2">
              {(['refund', 'payout_timing', 'fees', 'contact_human'] as const).map((c) => (
                <TouchableOpacity key={c} onPress={() => void send(t(`support.chip_${c}`))} disabled={busy} className="rounded-full border border-gray-300 px-3 py-1">
                  <Text className="text-xs text-foreground">{t(`support.chip_${c}`)}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        )}
        <View className="flex-row items-center gap-2 border-t border-gray-200 p-3">
          <TextInput className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-foreground" value={text} onChangeText={setText} placeholder={t('support.placeholder')} maxLength={1000} editable={!busy} />
          <TouchableOpacity onPress={() => void send(text)} disabled={busy || !text.trim()} className="rounded-lg bg-primary px-4 py-2">
            <Text className="text-sm font-semibold text-white">{t('support.send')}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
