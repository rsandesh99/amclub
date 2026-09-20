import { useMemo, useState } from 'react'
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useI18n } from '@/lib/i18n'
import { answerRfqQuality, sendRfqAsIs } from '@/lib/api'
import { VoiceRfqRecorder } from '@/components/VoiceRfqRecorder'


/**
 * S1.5 — "Before we send this" (mobile parity with web's QualityQuestionsCard):
 * the ≤ 3 quality questions for a DEFERRED RFQ, a text input per question with
 * a voice recorder whose transcript lands in the active field, the countdown to
 * the automatic send, and the two buttons. Nothing is held hostage.
 */
export function QualityQuestionsBlock({ rfqId, report, deadlineAt, modelUsed = true, onSent }: {
  rfqId: string
  report: { missing: { field: string; question: string; why?: string; source: 'rule' | 'model' }[]; risk_flags: string[] }
  deadlineAt: string | null
  modelUsed?: boolean
  onSent?: (rfqId: string, matched: number) => void
}) {
  const { t, locale } = useI18n()
  const router = useRouter()
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [voiceFor, setVoiceFor] = useState<string | null>(null)
  const [busy, setBusy] = useState<'answer' | 'send' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const deadlineLabel = useMemo(() => (deadlineAt ? new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(deadlineAt)) : null), [deadlineAt, locale])
  const filled = Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim().length > 0).map(([k, v]) => [k, v.trim()]))
  const filledCount = Object.keys(filled).length

  const append = (field: string, text: string) => setAnswers((a) => ({ ...a, [field]: `${(a[field] ?? '').trim()} ${text}`.trim().slice(0, 1000) }))

  async function post(kind: 'answer' | 'send') {
    setError('')
    setBusy(kind)
    const res = kind === 'answer' ? await answerRfqQuality(rfqId, filled) : await sendRfqAsIs(rfqId)
    setBusy(null)
    if (!res.ok) {
      if (res.data?.error === 'already_sent') { setNotice(t('rfq.quality_err_already_sent')); router.replace(`/rfq/${rfqId}` as never); return }
      setError(t('rfq.quality_err_generic'))
      return
    }
    if (Array.isArray(res.data?.redacted_fields) && res.data.redacted_fields.length > 0) setNotice(t('rfq.quality_redacted_notice'))
    if (onSent) onSent(rfqId, Number(res.data?.matched ?? 0))
    else router.replace(`/rfq/${rfqId}` as never)
  }

  return (
    <View className="rounded-xl border border-border bg-surface p-4 gap-3">
      <View>
        <Text className="text-sm font-semibold text-foreground">{t('rfq.quality_title')}</Text>
        <Text className="text-xs text-foreground-secondary">{t('rfq.quality_intro')}</Text>
        {!modelUsed ? <Text className="mt-1 text-xs text-foreground-secondary">{t('rfq.quality_rule_only_hint')}</Text> : null}
        {deadlineLabel ? <Text className="mt-1 text-xs text-[#b45309]">{t('rfq.quality_auto_send_at', { time: deadlineLabel })}</Text> : null}
      </View>

      {report.missing.map((m, i) => (
        <View key={m.field} className="rounded-lg border border-border p-3 gap-1.5">
          <View className="flex-row items-start justify-between gap-2">
            <Text className="flex-1 text-sm font-medium text-foreground">{i + 1}. {m.question}</Text>
            <Text className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${m.source === 'rule' ? 'border-[#b45309]/40 bg-[#f5ebdd] text-[#b45309]' : 'border-border bg-muted text-foreground-secondary'}`}>
              {m.source === 'rule' ? t('rfq.quality_source_rule') : t('rfq.quality_source_model')}
            </Text>
          </View>
          {m.why ? <Text className="text-xs text-foreground-secondary">{m.why}</Text> : null}
          <TextInput
            value={answers[m.field] ?? ''}
            onChangeText={(v) => setAnswers((a) => ({ ...a, [m.field]: v.slice(0, 1000) }))}
            multiline
            placeholder={t('rfq.quality_answer_placeholder')}
            placeholderTextColor="#9CA3AF"
            style={{ minHeight: 56 }}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
          <TouchableOpacity onPress={() => setVoiceFor(voiceFor === m.field ? null : m.field)}>
            <Text className="text-xs text-primary">{voiceFor === m.field ? '▲' : '🎤'}</Text>
          </TouchableOpacity>
          {voiceFor === m.field ? (
            <VoiceRfqRecorder
              onParsed={(data: any) => { if (typeof data?.transcript_english === 'string') append(m.field, data.transcript_english) }}
              onTranscriptOnly={(transcript: string) => append(m.field, transcript)}
            />
          ) : null}
        </View>
      ))}

      {report.risk_flags.length > 0 ? (
        <View className="gap-0.5">
          {report.risk_flags.map((f) => {
            const key = f === 'contact_info_in_text' ? 'rfq.quality_risk_contact_info_in_text' : f === 'duplicate_recent' ? 'rfq.quality_risk_duplicate_recent' : f === 'title_too_vague' ? 'rfq.quality_risk_title_too_vague' : f === 'description_too_short' ? 'rfq.quality_risk_description_too_short' : null
            return key ? <Text key={f} className="text-xs text-foreground-secondary">· {t(key)}</Text> : null
          })}
        </View>
      ) : null}

      {error ? <Text className="text-sm text-danger">{error}</Text> : null}
      {notice ? <Text className="text-xs text-foreground-secondary">{notice}</Text> : null}
      <View className="flex-row gap-2">
        <TouchableOpacity onPress={() => post('answer')} disabled={busy !== null || filledCount === 0} className={`flex-1 items-center rounded-lg py-2.5 ${filledCount === 0 ? 'bg-muted' : 'bg-primary'}`}>
          {busy === 'answer' ? <ActivityIndicator color="#fff" /> : <Text className={`font-semibold ${filledCount === 0 ? 'text-foreground-secondary' : 'text-white'}`}>{t('rfq.quality_send_with_answers')}</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => post('send')} disabled={busy !== null} className="items-center justify-center rounded-lg border border-border px-3">
          {busy === 'send' ? <ActivityIndicator color="#1B4D3E" /> : <Text className="text-sm font-medium text-foreground">{t('rfq.quality_send_as_is')}</Text>}
        </TouchableOpacity>
      </View>
    </View>
  )
}
